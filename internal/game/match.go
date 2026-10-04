package game

import (
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
	ID               string            `json:"id"`
	Name             string            `json:"name"`
	Faction          string            `json:"faction"`
	Health           float64           `json:"health"`
	Weapon           int               `json:"weapon"`
	BowDrawTicks     uint64            `json:"bowDrawTicks"`
	Arrows           int               `json:"arrows"`
	Kills            int               `json:"kills"`
	Deaths           int               `json:"deaths"`
	Ack              uint64            `json:"ack"`
	Life             uint64            `json:"life"`
	AttackTick       uint64            `json:"attackTick"`
	LastAttackSeq    uint64            `json:"lastAttackSeq"`
	NextAttackTick   uint64            `json:"nextAttackTick"`
	AttackWeapon     int               `json:"attackWeapon"`
	LastCombat       *CombatDiagnostic `json:"lastCombat,omitempty"`
	RespawnTick      uint64            `json:"respawnTick"`
	ShieldTick       uint64            `json:"shieldTick"`
	Connected        bool              `json:"connected"`
	Dummy            bool              `json:"dummy,omitempty"`
	AttackPitch      float64           `json:"attackPitch"`
	AttackYaw        float64           `json:"attackYaw"`
	swing            *swordSwing
	lastBowInputTick uint64
	dummySpawn       *Spawn
	queue            []queuedInput
	lastSeq          uint64
	disconnectedAt   uint64
	rtt, jitter      float64
	latencyReady     bool
}

type Event struct {
	ID      uint64  `json:"id"`
	Type    string  `json:"type"`
	Actor   string  `json:"actor"`
	Target  string  `json:"target,omitempty"`
	Damage  float64 `json:"damage,omitempty"`
	Part    string  `json:"part,omitempty"`
	Severed bool    `json:"severed,omitempty"`
	Blocked bool    `json:"blocked,omitempty"`
	Seq     uint64  `json:"seq,omitempty"`
	Life    uint64  `json:"life,omitempty"`
	From    *Vec3   `json:"from,omitempty"`
	To      *Vec3   `json:"to,omitempty"`
}

type Snapshot struct {
	Type        string       `json:"type"`
	Tick        uint64       `json:"tick"`
	Phase       string       `json:"phase"`
	EndTick     uint64       `json:"endTick"`
	Players     []Player     `json:"players"`
	Events      []Event      `json:"events"`
	Projectiles []Projectile `json:"projectiles"`
}

type Match struct {
	World           World
	Tick            uint64
	Phase           string
	EndTick         uint64
	Players         map[string]*Player
	nextID, eventID uint64
	nextDummy       uint64
	events          []Event
	history         []historyFrame
	projectiles     []Projectile
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
		return nil, fmt.Errorf("В комнате уже %d бойцов.", m.World.Rules.MaxPlayers)
	}
	m.nextID++
	p := &Player{ID: fmt.Sprint(m.nextID), Name: name, Faction: []string{"elf", "evil", "guard", "human"}[(m.nextID-1)%4], Connected: true}
	m.Players[p.ID] = p
	m.respawn(p)
	return p, nil
}

// Dummies use the same combat and respawn rules as players, without an input
// stream or a network session. Keep their spawn fixed for repeatable tests.
func (m *Match) AddDummy() (*Player, error) {
	p, err := m.Add(fmt.Sprintf("Манекен %d", m.nextDummy+1))
	if err != nil {
		return nil, err
	}
	m.nextDummy++
	p.Dummy = true
	p.dummySpawn = &Spawn{X: p.X, Z: p.Z, Yaw: p.Yaw}
	return p, nil
}

func (m *Match) RemoveDummies() int {
	removed := 0
	for id, p := range m.Players {
		if p.Dummy {
			delete(m.Players, id)
			removed++
		}
	}
	return removed
}

func (m *Match) Disconnect(id string) {
	if p := m.Players[id]; p != nil && !p.Dummy {
		p.Connected = false
		p.queue = nil
		p.Blocking = false
		p.BowDrawTicks = 0
		p.swing = nil
		p.disconnectedAt = m.Tick
	}
}

func (m *Match) Resume(id string) bool {
	p := m.Players[id]
	if p == nil || p.Dummy || p.Connected {
		return false
	}
	p.Connected = true
	p.queue = nil
	// A new input stream begins on welcome. Life also resets client prediction.
	p.Ack = 0
	p.lastSeq = 0
	p.Life++
	p.LastAttackSeq = 0
	p.AttackTick = 0
	p.LastCombat = nil
	p.BowDrawTicks = 0
	p.latencyReady = false
	p.rtt, p.jitter = 0, 0
	return true
}

func (m *Match) Input(id string, i Input) bool {
	return m.InputDelayed(id, i, 0)
}

// queueSeconds covers time spent waiting in the room's transport queue.
func (m *Match) InputDelayed(id string, i Input, queueSeconds float64) bool {
	p := m.Players[id]
	if p == nil || p.Dummy || !p.Connected || !i.Valid() || (i.Life != 0 && i.Life != p.Life) || i.Seq <= p.lastSeq || i.Seq-p.lastSeq > 4096 {
		return false
	}
	p.lastSeq = i.Seq
	if len(p.queue) >= 15 {
		return false
	}
	p.queue = append(p.queue, queuedInput{Input: i, receivedTick: float64(m.Tick) - math.Max(0, queueSeconds)*float64(m.World.Rules.TickRate)})
	return true
}

func (m *Match) respawn(p *Player) {
	best, bestDistance := m.World.Spawns[0], -1.0
	for _, s := range m.World.Spawns {
		d := math.Inf(1)
		for _, other := range m.Players {
			if other.ID != p.ID && (other.Health > 0 || other.Dummy) {
				d = math.Min(d, math.Hypot(s.X-other.X, s.Z-other.Z))
			}
		}
		if d > bestDistance {
			best, bestDistance = s, d
		}
	}
	if p.dummySpawn != nil {
		best = *p.dummySpawn
	}
	p.Motion = Motion{X: best.X, Z: best.Z, Yaw: best.Yaw, Stamina: 100}
	p.Health = 100
	p.swing = nil
	p.AttackPitch, p.AttackYaw = 0, 0
	if p.Weapon != Bow {
		p.Weapon = Sword
	}
	p.Arrows = m.World.Rules.Arrows
	p.Life++
	p.RespawnTick = 0
	p.AttackTick = 0
	p.NextAttackTick = 0
	p.LastAttackSeq = 0
	p.AttackWeapon = 0
	p.LastCombat = nil
	p.BowDrawTicks = 0
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
	m.attackInput(p, queuedInput{Input: Input{Seq: p.Ack}, receivedTick: float64(m.Tick)})
}

func (m *Match) attackInput(p *Player, q queuedInput) {
	if p.swing != nil {
		return
	}
	d := &CombatDiagnostic{Tick: m.Tick, Seq: q.Seq, Outcome: "rejected"}
	p.LastCombat = d
	r := m.World.Rules
	d.QueueMS = math.Max(0, float64(m.Tick)-q.receivedTick) / float64(r.TickRate) * 1000
	d.CommandAgeMS = d.QueueMS + p.rtt*500
	if q.View != nil {
		d.RewindMS = (float64(m.Tick) - q.View.Tick) / float64(r.TickRate) * 1000
	}
	if p.Weapon == Bow {
		d.Reason = "draw_required"
		return
	}
	cost, cooldown := r.AttackCost, r.AttackTicks
	switch {
	case m.Phase != "playing":
		d.Reason = "phase"
	case p.Health <= 0:
		d.Reason = "dead"
	case p.limbMissing(1):
		d.Reason = "arm"
	case p.Stamina < cost:
		d.Reason = "stamina"
	case m.Tick < p.NextAttackTick:
		d.Reason = "cooldown"
	}
	if d.Reason != "" {
		return
	}
	_, viewTick, reason := m.attackView(p, q, d)
	if reason != "" {
		d.Reason = reason
		return
	}
	p.AttackTick = m.Tick
	p.LastAttackSeq = q.Seq
	p.AttackWeapon = p.Weapon
	p.NextAttackTick = m.Tick + cooldown
	p.Stamina -= cost
	p.ShieldTick = 0
	p.AttackPitch, p.AttackYaw = p.Pitch, p.Yaw
	p.Blocking = false
	d.Outcome, d.Reason = "swing", "windup"
	p.swing = &swordSwing{rewind: float64(m.Tick) - viewTick, diagnostic: d, life: p.Life, seq: q.Seq}
}

func (m *Match) damageFrom(p, historical *Player, damage float64, diagnostic *CombatDiagnostic, source Vec3, seq, life uint64, hit BodyHit) {
	target := m.Players[historical.ID]
	if target == nil || target.Health <= 0 || target.Life != historical.Life {
		diagnostic.Reason = "life_changed"
		return
	}
	for _, part := range combat.Parts {
		if part.ID == hit.Part && part.Limb >= 0 && target.limbMissing(part.Limb) {
			diagnostic.Outcome, diagnostic.Reason = "miss", "limb_missing"
			return
		}
	}
	r := m.World.Rules
	diagnostic.Outcome, diagnostic.Reason = "hit", "hit"
	dx, dz := source.X-historical.X, source.Z-historical.Z
	distance := math.Hypot(dx, dz)
	blocked := historical.Blocking && !target.limbMissing(1) && distance > 0 && (-math.Sin(historical.Yaw)*dx-math.Cos(historical.Yaw)*dz)/distance > 0.3
	if blocked {
		diagnostic.Reason = "block"
		damage = math.Round(damage * 0.25)
		target.Stamina = math.Max(0, target.Stamina-8)
	}
	severed := false
	for _, part := range combat.Parts {
		if part.ID != hit.Part {
			continue
		}
		if part.Limb >= 0 && !target.limbMissing(part.Limb) {
			limit := combat.ArmHealth
			if part.Limb >= 2 {
				limit = combat.LegHealth
			}
			target.LimbDamage[part.Limb] = math.Min(limit, target.LimbDamage[part.Limb]+damage)
			severed = target.limbMissing(part.Limb)
		}
		damage = math.Round(damage * part.Multiplier)
		break
	}
	if !target.canBow() {
		target.BowDrawTicks = 0
	}
	if target.limbMissing(1) {
		target.Blocking = false
		target.swing = nil
	}
	if distance > 0 && !target.Dummy {
		impulse := math.Min(3, damage*.06)
		target.ImpulseX = clamp(target.ImpulseX-dx/distance*impulse, -4, 4)
		target.ImpulseZ = clamp(target.ImpulseZ-dz/distance*impulse, -4, 4)
	}
	diagnostic.Part = hit.Part
	target.Health = math.Max(0, target.Health-damage)
	m.emit("hit", p.ID, target.ID, damage)
	m.events[len(m.events)-1].Seq = seq
	m.events[len(m.events)-1].Life = life
	m.events[len(m.events)-1].Part = hit.Part
	m.events[len(m.events)-1].To = &hit.Point
	m.events[len(m.events)-1].Severed = severed
	m.events[len(m.events)-1].Blocked = blocked
	if target.Health == 0 {
		p.Kills++
		target.Deaths++
		target.Blocking = false
		target.swing = nil
		target.BowDrawTicks = 0
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
	if m.Phase != "playing" {
		m.projectiles = nil
		for _, p := range m.Players {
			p.swing = nil
			p.BowDrawTicks = 0
		}
	}
	type pendingAttack struct {
		player *Player
		input  queuedInput
	}
	attacks := make([]pendingAttack, 0, len(m.Players))
	for _, p := range m.ordered() {
		input := Input{Yaw: p.Yaw, Pitch: p.Pitch, Weapon: p.Weapon}
		queued := queuedInput{receivedTick: float64(m.Tick)}
		p.coalesceInputs(m.Tick)
		if len(p.queue) > 0 {
			queued = p.queue[0]
			input = queued.Input
			p.queue = p.queue[1:]
			p.Ack = input.Seq
		}
		if p.Health <= 0 {
			p.BowDrawTicks = 0
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
		if swordActive(p, float64(m.Tick), r) {
			input.Block = false
		}
		Move(m.World, &p.Motion, input)
		if p.Weapon == Bow {
			m.updateBow(p, queued)
		} else {
			p.BowDrawTicks = 0
			if input.Attack {
				attacks = append(attacks, pendingAttack{p, queued})
			}
		}
	}
	for _, attack := range attacks {
		m.attackInput(attack.player, attack.input)
	}
	if m.Phase == "playing" {
		m.stepSwords()
		m.stepProjectiles()
		finished := m.Tick >= m.EndTick
		for _, p := range m.Players {
			if p.Kills >= r.ScoreLimit {
				finished = true
			}
		}
		if finished {
			m.projectiles = nil
			for _, p := range m.Players {
				p.BowDrawTicks = 0
			}
			m.Phase = "finished"
			m.EndTick = m.Tick + uint64(10*r.TickRate)
			m.emit("end", "", "", 0)
		}
	}
}

func (m *Match) Snapshot() Snapshot {
	s := Snapshot{Type: "snapshot", Tick: m.Tick, Phase: m.Phase, EndTick: m.EndTick, Players: make([]Player, 0, len(m.Players)), Events: append([]Event{}, m.events...), Projectiles: append([]Projectile{}, m.projectiles...)}
	for _, p := range m.ordered() {
		copy := *p
		copy.queue = nil
		copy.swing = nil
		if p.LastCombat != nil {
			diagnostic := *p.LastCombat
			copy.LastCombat = &diagnostic
		}
		s.Players = append(s.Players, copy)
	}
	m.remember(s)
	return s
}
