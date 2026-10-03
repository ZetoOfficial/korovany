package game

import (
	"errors"
	"fmt"
	"math"
	"sort"
)

const (
	Sword = 1
	Bow   = 2
)

type Player struct {
	Motion
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	Faction        string  `json:"faction"`
	Health         float64 `json:"health"`
	Weapon         int     `json:"weapon"`
	Arrows         int     `json:"arrows"`
	Kills          int     `json:"kills"`
	Deaths         int     `json:"deaths"`
	Ack            uint64  `json:"ack"`
	Life           uint64  `json:"life"`
	AttackTick     uint64  `json:"attackTick"`
	RespawnTick    uint64  `json:"respawnTick"`
	ShieldTick     uint64  `json:"shieldTick"`
	Connected      bool    `json:"connected"`
	queue          []Input
	lastSeq        uint64
	disconnectedAt uint64
	nextAttackTick uint64
}

type Event struct {
	ID     uint64  `json:"id"`
	Type   string  `json:"type"`
	Actor  string  `json:"actor"`
	Target string  `json:"target,omitempty"`
	Damage float64 `json:"damage,omitempty"`
	From   *Vec3   `json:"from,omitempty"`
	To     *Vec3   `json:"to,omitempty"`
}

type Snapshot struct {
	Type    string   `json:"type"`
	Tick    uint64   `json:"tick"`
	Phase   string   `json:"phase"`
	EndTick uint64   `json:"endTick"`
	Players []Player `json:"players"`
	Events  []Event  `json:"events"`
}

type Match struct {
	World           World
	Tick            uint64
	Phase           string
	EndTick         uint64
	Players         map[string]*Player
	nextID, eventID uint64
	events          []Event
}

func NewMatch() *Match {
	return &Match{World: LoadWorld(), Phase: "waiting", Players: make(map[string]*Player)}
}

func (m *Match) ordered() []*Player {
	players := make([]*Player, 0, len(m.Players))
	for _, p := range m.Players {
		players = append(players, p)
	}
	sort.Slice(players, func(i, j int) bool { return players[i].ID < players[j].ID })
	return players
}

func (m *Match) Add(name string) (*Player, error) {
	if len(m.Players) >= m.World.Rules.MaxPlayers {
		return nil, errors.New("В комнате уже 8 игроков.")
	}
	m.nextID++
	p := &Player{ID: fmt.Sprint(m.nextID), Name: name, Faction: []string{"elf", "evil", "guard", "human"}[(m.nextID-1)%4], Connected: true}
	m.Players[p.ID] = p
	m.respawn(p)
	return p, nil
}

func (m *Match) Disconnect(id string) {
	if p := m.Players[id]; p != nil {
		p.Connected = false
		p.queue = nil
		p.Blocking = false
		p.disconnectedAt = m.Tick
	}
}

func (m *Match) Resume(id string) bool {
	p := m.Players[id]
	if p == nil || p.Connected {
		return false
	}
	p.Connected = true
	p.queue = nil
	// A new input stream begins on welcome. Life also resets client prediction.
	p.Ack = 0
	p.lastSeq = 0
	p.Life++
	return true
}

func (m *Match) Input(id string, i Input) bool {
	p := m.Players[id]
	if p == nil || !p.Connected || !i.Valid() || i.Seq <= p.lastSeq || i.Seq-p.lastSeq > 4096 {
		return false
	}
	p.lastSeq = i.Seq
	if len(p.queue) >= 15 {
		return false
	}
	p.queue = append(p.queue, i)
	return true
}

func (m *Match) respawn(p *Player) {
	best, bestDistance := m.World.Spawns[0], -1.0
	for _, s := range m.World.Spawns {
		d := math.Inf(1)
		for _, other := range m.Players {
			if other.ID != p.ID && other.Health > 0 {
				d = math.Min(d, math.Hypot(s.X-other.X, s.Z-other.Z))
			}
		}
		if d > bestDistance {
			best, bestDistance = s, d
		}
	}
	p.Motion = Motion{X: best.X, Z: best.Z, Yaw: best.Yaw, Stamina: 100}
	p.Health = 100
	if p.Weapon != Bow {
		p.Weapon = Sword
	}
	p.Arrows = m.World.Rules.Arrows
	p.Life++
	p.RespawnTick = 0
	p.AttackTick = 0
	p.nextAttackTick = 0
	p.ShieldTick = m.Tick + uint64(m.World.Rules.ShieldSeconds*float64(m.World.Rules.TickRate))
	// Acknowledge discarded inputs so clients do not replay a previous life.
	p.queue = nil
	p.Ack = p.lastSeq
}

func (m *Match) emit(kind, actor, target string, damage float64) {
	m.eventID++
	m.events = append(m.events, Event{ID: m.eventID, Type: kind, Actor: actor, Target: target, Damage: damage})
	if len(m.events) > 32 {
		m.events = m.events[len(m.events)-32:]
	}
}

func (m *Match) attack(p *Player) {
	r := m.World.Rules
	cost, cooldown := r.AttackCost, r.AttackTicks
	if p.Weapon == Bow {
		cost, cooldown = r.BowCost, r.BowTicks
		if p.Arrows <= 0 {
			return
		}
	}
	if m.Phase != "playing" || p.Health <= 0 || p.Stamina < cost || m.Tick < p.nextAttackTick {
		return
	}
	p.AttackTick = m.Tick
	p.nextAttackTick = m.Tick + cooldown
	p.Stamina -= cost
	p.ShieldTick = 0
	if p.Weapon == Bow {
		p.Arrows--
		m.shoot(p)
		return
	}
	var target *Player
	nearest := r.AttackRange
	for _, other := range m.ordered() {
		if p.ID == other.ID || other.Health <= 0 || m.Tick < other.ShieldTick || math.Abs(other.Y-p.Y) > 1.8 {
			continue
		}
		dx, dz := other.X-p.X, other.Z-p.Z
		d := math.Hypot(dx, dz)
		if d > nearest || d < 0.001 {
			continue
		}
		if (-math.Sin(p.Yaw)*dx-math.Cos(p.Yaw)*dz)/d < math.Cos(50*math.Pi/180) {
			continue
		}
		if !m.World.Clear(p.X, p.Z, other.X, other.Z) {
			continue
		}
		target, nearest = other, d
	}
	if target == nil {
		return
	}
	m.damage(p, target, r.AttackDamage)
}

func (m *Match) damage(p, target *Player, damage float64) {
	r := m.World.Rules
	dx, dz := p.X-target.X, p.Z-target.Z
	distance := math.Hypot(dx, dz)
	if target.Blocking && distance > 0 && (-math.Sin(target.Yaw)*dx-math.Cos(target.Yaw)*dz)/distance > 0.3 {
		damage = math.Round(damage * 0.25)
		target.Stamina = math.Max(0, target.Stamina-8)
	}
	target.Health = math.Max(0, target.Health-damage)
	m.emit("hit", p.ID, target.ID, damage)
	if target.Health == 0 {
		p.Kills++
		target.Deaths++
		target.Blocking = false
		target.RespawnTick = m.Tick + uint64(r.RespawnSeconds*float64(r.TickRate))
		m.emit("kill", p.ID, target.ID, 0)
	}
}

func (m *Match) Step() {
	m.Tick++
	r := m.World.Rules
	for id, p := range m.Players {
		if !p.Connected && m.Tick-p.disconnectedAt >= uint64(r.TickRate*20) {
			delete(m.Players, id)
		}
	}
	if len(m.Players) < 2 {
		m.Phase = "waiting"
		m.EndTick = 0
	} else if m.Phase == "waiting" || (m.Phase == "finished" && m.Tick >= m.EndTick) {
		m.Phase = "countdown"
		m.EndTick = m.Tick + uint64(r.CountdownSeconds*r.TickRate)
		for _, p := range m.ordered() {
			p.Kills = 0
			p.Deaths = 0
			m.respawn(p)
		}
	} else if m.Phase == "countdown" && m.Tick >= m.EndTick {
		m.Phase = "playing"
		m.EndTick = m.Tick + uint64(r.RoundSeconds*r.TickRate)
	}
	attacks := make([]*Player, 0, len(m.Players))
	for _, p := range m.ordered() {
		input := Input{Yaw: p.Yaw, Pitch: p.Pitch, Weapon: p.Weapon}
		if len(p.queue) > 0 {
			input = p.queue[0]
			p.queue = p.queue[1:]
			p.Ack = input.Seq
		}
		if p.Health <= 0 {
			if m.Tick >= p.RespawnTick && m.Phase != "finished" {
				m.respawn(p)
			}
			continue
		}
		if m.Phase == "finished" || m.Phase == "countdown" {
			continue
		}
		if input.Weapon != 0 {
			p.Weapon = input.Weapon
		}
		input.Weapon = p.Weapon
		Move(m.World, &p.Motion, input)
		if input.Attack {
			attacks = append(attacks, p)
		}
	}
	for _, p := range attacks {
		m.attack(p)
	}
	if m.Phase == "playing" {
		finished := m.Tick >= m.EndTick
		for _, p := range m.Players {
			if p.Kills >= r.ScoreLimit {
				finished = true
			}
		}
		if finished {
			m.Phase = "finished"
			m.EndTick = m.Tick + uint64(10*r.TickRate)
			m.emit("end", "", "", 0)
		}
	}
}

func (m *Match) Snapshot() Snapshot {
	s := Snapshot{Type: "snapshot", Tick: m.Tick, Phase: m.Phase, EndTick: m.EndTick, Players: make([]Player, 0, len(m.Players)), Events: append([]Event{}, m.events...)}
	for _, p := range m.ordered() {
		copy := *p
		copy.queue = nil
		s.Players = append(s.Players, copy)
	}
	return s
}
