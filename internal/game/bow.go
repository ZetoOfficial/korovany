package game

import "math"

type Vec3 struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z"`
}

// rayBox returns the first intersection distance with a solid box. Direction is
// normalized; the same ray selects cover and players, including vertical aim.
func rayBox(origin, direction, low, high Vec3, limit float64) (float64, bool) {
	near, far := 0.0, limit
	for _, axis := range [][4]float64{
		{origin.X, direction.X, low.X, high.X},
		{origin.Y, direction.Y, low.Y, high.Y},
		{origin.Z, direction.Z, low.Z, high.Z},
	} {
		if math.Abs(axis[1]) < 1e-9 {
			if axis[0] < axis[2] || axis[0] > axis[3] {
				return 0, false
			}
			continue
		}
		a, b := (axis[2]-axis[0])/axis[1], (axis[3]-axis[0])/axis[1]
		near, far = math.Max(near, math.Min(a, b)), math.Min(far, math.Max(a, b))
		if near > far {
			return 0, false
		}
	}
	return near, true
}

// Projectile positions are authoritative. No rewind is used for arrows: a
// target that leaves the flight path before impact must be able to dodge.
type Projectile struct {
	ID         uint64 `json:"id"`
	Actor      string `json:"actor"`
	Life       uint64 `json:"life"`
	Seq        uint64 `json:"seq"`
	LaunchTick uint64 `json:"launchTick"`
	Position   Vec3   `json:"position"`
	Velocity   Vec3   `json:"velocity"`
	damage     float64
	remaining  float64
	diagnostic *CombatDiagnostic
}

func (m *Match) updateBow(p *Player, q queuedInput) {
	r := m.World.Rules
	if q.Seq != 0 {
		p.lastBowInputTick = m.Tick
	}
	if !p.canBow() || q.CancelAttack || !p.Connected || m.Phase != "playing" || p.Health <= 0 || p.Arrows <= 0 || p.Stamina < r.BowCost || m.Tick < p.NextAttackTick || m.Tick-p.lastBowInputTick > uint64(r.TickRate)/4 {
		p.BowDrawTicks = 0
		return
	}
	// Missing commands are not releases. Hold briefly through ordinary jitter,
	// then cancel rather than firing if the input stream stops.
	if q.Attack || (q.Seq == 0 && p.BowDrawTicks > 0) {
		if p.BowDrawTicks < r.BowDrawTicks {
			p.BowDrawTicks++
		}
		return
	}
	draw := p.BowDrawTicks
	p.BowDrawTicks = 0
	if draw < r.BowMinDrawTicks || q.Seq == 0 {
		return
	}
	charge := math.Min(1, float64(draw)/float64(r.BowDrawTicks))
	p.AttackTick, p.LastAttackSeq, p.AttackWeapon = m.Tick, q.Seq, Bow
	p.NextAttackTick = m.Tick + r.BowTicks
	p.Stamina -= r.BowCost
	p.Arrows--
	p.ShieldTick = 0
	d := &CombatDiagnostic{Tick: m.Tick, Seq: q.Seq, Outcome: "flying", Reason: "flight"}
	d.QueueMS = math.Max(0, float64(m.Tick)-q.receivedTick) / float64(r.TickRate) * 1000
	d.CommandAgeMS = d.QueueMS + p.rtt*500
	p.LastCombat = d
	speed := r.BowMinSpeed + (r.BowSpeed-r.BowMinSpeed)*charge
	origin := Vec3{p.X, p.Y + 1.8, p.Z}
	velocity := Vec3{-math.Sin(p.Yaw) * math.Cos(p.Pitch) * speed, math.Sin(p.Pitch) * speed, -math.Cos(p.Yaw) * math.Cos(p.Pitch) * speed}
	m.emit("arrow", p.ID, "", 0)
	e := &m.events[len(m.events)-1]
	e.From, e.Seq, e.Life = &origin, q.Seq, p.Life
	m.projectiles = append(m.projectiles, Projectile{ID: e.ID, Actor: p.ID, Life: p.Life, Seq: q.Seq, LaunchTick: m.Tick, Position: origin, Velocity: velocity, damage: math.Round(r.BowMinDamage + (r.BowDamage-r.BowMinDamage)*charge), remaining: r.BowRange, diagnostic: d})
}

func (m *Match) stepProjectiles() {
	r := m.World.Rules
	dt := 1 / float64(r.TickRate)
	alive := m.projectiles[:0]
	players := m.ordered()
	for _, arrow := range m.projectiles {
		owner := m.Players[arrow.Actor]
		if owner == nil || owner.Life != arrow.Life {
			continue
		}
		if arrow.LaunchTick == m.Tick {
			alive = append(alive, arrow)
			continue
		}
		start := arrow.Position
		delta := Vec3{arrow.Velocity.X * dt, arrow.Velocity.Y*dt - r.BowGravity*dt*dt/2, arrow.Velocity.Z * dt}
		length := math.Sqrt(delta.X*delta.X + delta.Y*delta.Y + delta.Z*delta.Z)
		direction := Vec3{delta.X / length, delta.Y / length, delta.Z / length}
		nearest := math.Min(length, arrow.remaining)
		reason := ""
		if arrow.remaining <= length {
			reason = "range"
		}
		if direction.Y < 0 && start.Y+direction.Y*nearest <= 0 {
			nearest, reason = -start.Y/direction.Y, "ground"
		}
		for _, o := range m.World.Obstacles {
			if d, hit := rayBox(start, direction, Vec3{o.X - o.W/2, 0, o.Z - o.D/2}, Vec3{o.X + o.W/2, o.Height, o.Z + o.D/2}, nearest); hit {
				nearest, reason = d, "wall"
			}
		}
		var target *Player
		var contact BodyHit
		for _, other := range players {
			if other.ID == arrow.Actor || other.Health <= 0 {
				continue
			}
			if hit, ok := bodyHit(other, float64(m.Tick), r, start, direction, nearest, 0); ok && (hit.Distance < nearest || reason == "") {
				target, nearest, reason, contact = other, hit.Distance, "player", hit
			}
		}
		arrow.Position = Vec3{start.X + direction.X*nearest, start.Y + direction.Y*nearest, start.Z + direction.Z*nearest}
		arrow.Velocity.Y -= r.BowGravity * dt
		arrow.remaining -= nearest
		if reason == "" {
			alive = append(alive, arrow)
			continue
		}
		arrow.diagnostic.Outcome, arrow.diagnostic.Reason = "miss", reason
		if target != nil {
			if m.Tick < target.ShieldTick {
				arrow.diagnostic.Reason = "shield"
			} else {
				// Blocking faces the incoming arrow, even if its shooter has moved.
				source := Vec3{target.X - direction.X, target.Y, target.Z - direction.Z}
				m.damageFrom(owner, target, arrow.damage, arrow.diagnostic, source, arrow.Seq, arrow.Life, contact)
			}
		}
	}
	m.projectiles = alive
}
