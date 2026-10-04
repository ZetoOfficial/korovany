package game

import "math"

const (
	HistorySeconds       = 0.5
	MaxRewindSeconds     = 0.35
	InterpolationSeconds = 0.1
)

// ViewTime identifies the actual snapshot pair rendered by the client. A tick
// alone would interpolate different positions when extra welcome snapshots exist.
type ViewTime struct {
	Tick float64 `json:"tick"`
	From uint64  `json:"from"`
	To   uint64  `json:"to"`
}

type queuedInput struct {
	Input
	receivedTick float64
}

// Both sides normally produce/consume 60 commands per second, so a burst can
// otherwise leave a permanent queue. Retain two ticks for ordinary frame
// batching, and preserve one-shot actions with their original aim/view/seq.
// Discarded movement is acknowledged with the next processed command; it never
// advances the simulation faster than one authoritative step per tick.
func (p *Player) coalesceInputs(tick uint64) {
	preservedAttack := false
	for i := 0; i < len(p.queue)-2; {
		old, next := p.queue[i].Input, p.queue[i+1].Input
		// Keep the first potentially accepted held attack too, so its sequence
		// still matches the predicted animation. Subsequent repeats can merge.
		keepAttack := old.Attack && ((!preservedAttack && tick >= p.NextAttackTick) || !next.Attack || old.Weapon != next.Weapon)
		if old.Jump || keepAttack || (old.Block && !next.Block) {
			preservedAttack = preservedAttack || old.Attack
			i++
			continue
		}
		p.queue = append(p.queue[:i], p.queue[i+1:]...)
	}
}

type historyFrame struct {
	tick    uint64
	players []Player
}

type CombatDiagnostic struct {
	Tick         uint64  `json:"tick"`
	Seq          uint64  `json:"seq"`
	Outcome      string  `json:"outcome"`
	Reason       string  `json:"reason"`
	CommandAgeMS float64 `json:"commandAgeMs"`
	QueueMS      float64 `json:"queueMs"`
	RewindMS     float64 `json:"rewindMs"`
}

// SetLatency is called only with measurements made by the server transport.
func (m *Match) SetLatency(id string, rtt, jitter float64) {
	if p := m.Players[id]; p != nil && rtt >= 0 && jitter >= 0 && !math.IsNaN(rtt+jitter) && !math.IsInf(rtt+jitter, 0) {
		p.rtt = rtt
		p.jitter = jitter
		p.latencyReady = true
	}
}

func (m *Match) remember(s Snapshot) {
	frame := historyFrame{tick: s.Tick, players: s.Players}
	if n := len(m.history); n > 0 && m.history[n-1].tick == s.Tick {
		m.history[n-1] = frame
	} else {
		m.history = append(m.history, frame)
	}
	cutoff := float64(m.Tick) - HistorySeconds*float64(m.World.Rules.TickRate)
	// Keep one older endpoint so the boundary can still be interpolated.
	for len(m.history) > 2 && float64(m.history[1].tick) < cutoff {
		m.history = m.history[1:]
	}
}

func (m *Match) frame(tick uint64) *historyFrame {
	for i := range m.history {
		if m.history[i].tick == tick {
			return &m.history[i]
		}
	}
	return nil
}

func (m *Match) attackView(p *Player, q queuedInput, d *CombatDiagnostic) ([]*Player, float64, string) {
	rate := float64(m.World.Rules.TickRate)
	d.QueueMS = math.Max(0, float64(m.Tick)-q.receivedTick) / rate * 1000
	d.CommandAgeMS = d.QueueMS + p.rtt*500
	if !p.latencyReady {
		d.RewindMS = 0
		return m.ordered(), float64(m.Tick), ""
	}
	v := q.View
	if v == nil {
		return nil, 0, "missing_view"
	}
	age := float64(m.Tick) - v.Tick
	d.RewindMS = age / rate * 1000
	if v.Tick < 0 || age > MaxRewindSeconds*rate+1e-8 {
		return nil, 0, "stale_view"
	}
	if v.Tick > q.receivedTick {
		return nil, 0, "future_view"
	}
	// The rendered world is a full RTT plus interpolation behind the receipt
	// time: outbound snapshots and inbound commands each travel one way.
	expected := q.receivedTick - (p.rtt+InterpolationSeconds)*rate
	tolerance := (0.05 + math.Min(2*p.jitter, 0.05)) * rate
	if math.Abs(v.Tick-expected) > tolerance+1e-8 {
		return nil, 0, "untrusted_view"
	}
	if v.From > v.To || v.Tick < float64(v.From) || v.Tick > float64(v.To) || float64(v.To-v.From) > rate*0.1 {
		return nil, 0, "invalid_view"
	}
	a, b := m.frame(v.From), m.frame(v.To)
	if a == nil || b == nil {
		return nil, 0, "missing_history"
	}
	// An old snapshot pair cannot cross the attacker's life/session boundary.
	if !sameLife(a.players, p) || !sameLife(b.players, p) {
		return nil, 0, "life_changed"
	}
	t := 0.0
	if a.tick != b.tick {
		t = (v.Tick - float64(a.tick)) / float64(b.tick-a.tick)
	}
	players := make([]*Player, 0, len(a.players))
	for _, old := range a.players {
		current := m.Players[old.ID]
		if current == nil || current.Life != old.Life || current.Health <= 0 || old.Health <= 0 {
			continue
		}
		for _, next := range b.players {
			if next.ID != old.ID || next.Life != old.Life || next.Health <= 0 {
				continue
			}
			copy := old
			copy.X += (next.X - old.X) * t
			copy.Y += (next.Y - old.Y) * t
			copy.Z += (next.Z - old.Z) * t
			copy.Yaw += math.Atan2(math.Sin(next.Yaw-old.Yaw), math.Cos(next.Yaw-old.Yaw)) * t
			players = append(players, &copy)
			break
		}
	}
	return players, v.Tick, ""
}

func sameLife(players []Player, p *Player) bool {
	for _, other := range players {
		if other.ID == p.ID {
			return other.Life == p.Life && other.Health > 0
		}
	}
	return false
}
