package game

import "math"

type swordSwing struct {
	rewind     float64
	diagnostic *CombatDiagnostic
	life, seq  uint64
}

// Advance the compensated view with the swing. Freezing targets at button-down
// would make an opponent who dodges during the windup still receive damage.
func (m *Match) swordTargets(tick float64) []*Player {
	if tick >= float64(m.Tick) {
		return m.ordered()
	}
	for i := len(m.history) - 1; i >= 0; i-- {
		a := m.history[i]
		if float64(a.tick) > tick {
			continue
		}
		b := historyFrame{tick: m.Tick}
		if i+1 < len(m.history) {
			b = m.history[i+1]
		} else {
			for _, p := range m.ordered() {
				b.players = append(b.players, *p)
			}
		}
		t := 0.0
		if b.tick > a.tick {
			t = clamp((tick-float64(a.tick))/float64(b.tick-a.tick), 0, 1)
		}
		result := make([]*Player, 0, len(a.players))
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
				copy.Pitch += (next.Pitch - old.Pitch) * t
				copy.Gait += (next.Gait - old.Gait) * t
				result = append(result, &copy)
				break
			}
		}
		return result
	}
	return nil
}

func blade(p *Player, age float64, r Rules) (Vec3, Vec3) {
	rotation := swordRotation(age, float64(r.AttackTicks))
	rotation.X += p.AttackPitch
	world := func(v [3]float64) Vec3 {
		local := add(Vec3{.46, 1.5, 0}, rotate(vector(v), rotation, false))
		return add(Vec3{p.X, p.Y, p.Z}, rotate(local, Vec3{Y: p.AttackYaw}, false))
	}
	return world(combat.BladeBase), world(combat.BladeTip)
}

func (m *Match) stepSwords() {
	r := m.World.Rules
	players := m.ordered()
	for _, p := range players {
		swing := p.swing
		if swing == nil {
			continue
		}
		if p.Health <= 0 || !p.Connected || p.Life != swing.life || p.Weapon != Sword || p.limbMissing(1) {
			swing.diagnostic.Outcome, swing.diagnostic.Reason = "miss", "interrupted"
			p.swing = nil
			continue
		}
		age := float64(m.Tick - p.AttackTick)
		if age < combat.WindupTicks {
			continue
		}
		if age > combat.WindupTicks+combat.StrikeTicks {
			swing.diagnostic.Outcome, swing.diagnostic.Reason = "miss", "range"
			p.swing = nil
			continue
		}
		swing.diagnostic.Outcome, swing.diagnostic.Reason = "swing", "strike"
		// Sixteen angular substeps per 60 Hz tick keep a fast blade from tunnelling
		// through hands and thin cover. Only the sharp blade deals damage.
		for step := 0; step <= 16 && p.swing != nil; step++ {
			sample := math.Max(combat.WindupTicks, age-1+float64(step)/16)
			viewTick := float64(m.Tick) - swing.rewind - (age - sample)
			base, tip := blade(p, sample, r)
			delta := sub(tip, base)
			length := magnitude(delta)
			direction := scale(delta, 1/length)
			nearest := length
			reason := ""
			// Cover between the shoulder and hilt also prevents reaching through walls.
			shoulder := add(Vec3{p.X, p.Y, p.Z}, rotate(Vec3{.46, 1.5, 0}, Vec3{Y: p.AttackYaw}, false))
			for _, o := range m.World.Obstacles {
				low, high := Vec3{o.X - o.W/2, 0, o.Z - o.D/2}, Vec3{o.X + o.W/2, o.Height, o.Z + o.D/2}
				arm := sub(base, shoulder)
				armLength := magnitude(arm)
				if _, hit := rayBox(shoulder, scale(arm, 1/armLength), low, high, armLength); hit {
					nearest = 0
					reason = "wall"
				}
				pad := Vec3{combat.BladeRadius, combat.BladeRadius, combat.BladeRadius}
				if d, hit := rayBox(base, direction, sub(low, pad), add(high, pad), nearest); hit {
					nearest = d
					reason = "wall"
				}
			}
			var target *Player
			var contact BodyHit
			targets := players
			if swing.rewind > 0 {
				targets = m.swordTargets(viewTick)
			}
			for _, other := range targets {
				if other.ID == p.ID || other.Health <= 0 {
					continue
				}
				if hit, ok := combatHit(other, viewTick, r, base, direction, nearest, combat.BladeRadius); ok && (hit.Distance < nearest || reason == "") {
					nearest, reason, target, contact = hit.Distance, "player", other, hit
				}
			}
			if reason == "" {
				continue
			}
			p.swing = nil
			swing.diagnostic.Outcome, swing.diagnostic.Reason = "miss", reason
			if target != nil {
				if viewTick < float64(target.ShieldTick) {
					swing.diagnostic.Reason = "shield"
					continue
				}
				m.damageFrom(p, target, r.AttackDamage, swing.diagnostic, Vec3{p.X, p.Y, p.Z}, swing.seq, swing.life, contact)
			}
		}
	}
}
