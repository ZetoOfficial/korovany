package game

import (
	"math"
	"testing"
)

func bowInput(t *testing.T, m *Match, p *Player, held, cancel bool) {
	t.Helper()
	if !m.Input(p.ID, Input{Seq: p.lastSeq + 1, Life: p.Life, Weapon: Bow, Attack: held, CancelAttack: cancel, Yaw: p.Yaw, Pitch: p.Pitch}) {
		t.Fatal("bow command rejected")
	}
	m.Step()
}
func drawBow(t *testing.T, m *Match, p *Player, ticks uint64) {
	t.Helper()
	for m.Tick < p.NextAttackTick {
		m.Step()
	}
	for n := uint64(0); n < ticks; n++ {
		bowInput(t, m, p, true, false)
	}
}
func fireBow(t *testing.T, m *Match, p *Player) {
	t.Helper()
	drawBow(t, m, p, m.World.Rules.BowDrawTicks)
	bowInput(t, m, p, false, false)
}
func finishFlight(t *testing.T, m *Match) {
	t.Helper()
	for n := 0; len(m.projectiles) > 0 && n < 600; n++ {
		m.Step()
	}
	if len(m.projectiles) > 0 {
		t.Fatal("arrow never expired")
	}
}

func TestBowDrawReleaseAndFlight(t *testing.T) {
	m, a, b := readyMatch(t)
	b.Z = -20
	a.Pitch = .13
	a.ShieldTick = 1000
	drawBow(t, m, a, m.World.Rules.BowDrawTicks+20)
	if a.BowDrawTicks != 60 || a.Arrows != 20 || b.Health != 100 || a.ShieldTick != 1000 || len(m.projectiles) != 0 {
		t.Fatal("holding fired or overcharged the bow")
	}
	bowInput(t, m, a, false, false)
	if a.BowDrawTicks != 0 || a.Arrows != 19 || a.ShieldTick != 0 || b.Health != 100 || len(m.projectiles) != 1 || a.LastCombat.Outcome != "flying" {
		t.Fatal("release did not launch an authoritative projectile")
	}
	arrow := m.projectiles[0]
	launchSnapshot := m.Snapshot()
	if arrow.Seq != a.Ack || arrow.Life != a.Life || arrow.Position.Y != 1.8 || math.Abs(math.Hypot(arrow.Velocity.Y, arrow.Velocity.Z)-28) > 1e-8 {
		t.Fatalf("invalid launch: %+v", arrow)
	}
	for n := 0; n < 30; n++ {
		m.Step()
	}
	if b.Health != 100 {
		t.Fatal("20 m shot arrived before 0.5 seconds")
	}
	finishFlight(t, m)
	if launchSnapshot.Players[0].LastCombat.Outcome != "flying" || launchSnapshot.Projectiles[0].Position != arrow.Position {
		t.Fatal("impact mutated an earlier snapshot")
	}
	if b.Health != 66 || a.LastCombat.Outcome != "hit" {
		t.Fatalf("aimed ballistic shot missed: health=%v diagnostic=%+v", b.Health, a.LastCombat)
	}
	events := m.Snapshot().Events
	if len(events) != 2 || events[0].Type != "arrow" || events[1].Type != "hit" || events[1].Seq != arrow.Seq {
		t.Fatalf("invalid flight/hit events: %+v", events)
	}
}

func TestBowGravityAndCharge(t *testing.T) {
	var speeds, damages []float64
	for _, ticks := range []uint64{12, 30, 60} {
		m, a, b := readyMatch(t)
		b.X = 10
		drawBow(t, m, a, ticks)
		bowInput(t, m, a, false, false)
		arrow := m.projectiles[0]
		speeds = append(speeds, -arrow.Velocity.Z)
		damages = append(damages, arrow.damage)
		for n := 0; n < 24; n++ {
			m.Step()
		}
		current := m.projectiles[0]
		if math.Abs(current.Position.Y-(1.8-12*.4*.4/2)) > 1e-8 || math.Abs(current.Velocity.Y+12*.4) > 1e-8 {
			t.Fatal("flight does not follow ballistic gravity")
		}
		finishFlight(t, m)
		if a.LastCombat.Reason != "ground" {
			t.Fatal("level arrow did not fall to the ground")
		}
	}
	if !(speeds[0] < speeds[1] && speeds[1] < speeds[2] && damages[0] < damages[1] && damages[1] < damages[2] && damages[2] == 34) {
		t.Fatal("draw does not control speed and damage")
	}
}

func TestBowCanBeDodgedAndIntercepted(t *testing.T) {
	for _, dodge := range []bool{true, false} {
		m, a, b := readyMatch(t)
		b.Z = -20
		a.Pitch = .13
		if !dodge {
			b.X = 3
		}
		fireBow(t, m, a)
		for n := 0; n < 12; n++ {
			m.Step()
		}
		// Move only after release. Target positions at launch never decide a hit.
		if dodge {
			b.X = 3
		} else {
			b.X = 0
		}
		finishFlight(t, m)
		want := 66.0
		if dodge {
			want = 100
		}
		if b.Health != want {
			t.Fatalf("dodge=%v health=%v", dodge, b.Health)
		}
	}
}

func TestBowAimCoverRangeAndHeight(t *testing.T) {
	for _, kind := range []string{"behind", "side", "above", "below", "uncompensated-drop", "wall", "shield", "over-low-cover", "raised-target", "range"} {
		t.Run(kind, func(t *testing.T) {
			m, a, b := readyMatch(t)
			b.Z = -20
			a.Pitch = .13
			want := 100.0
			switch kind {
			case "behind":
				a.Yaw = math.Pi
			case "side":
				b.X = 2
			case "above":
				a.Pitch = .7
			case "below":
				a.Pitch = -.7
			case "uncompensated-drop":
				a.Pitch = 0
			case "wall":
				m.World.Obstacles = append(m.World.Obstacles, Obstacle{Z: -10, W: 4, D: .001, Height: 3})
			case "shield":
				b.ShieldTick = 1000
			case "over-low-cover":
				m.World.Obstacles = append(m.World.Obstacles, Obstacle{Z: -10, W: 4, D: 1, Height: 1})
				want = 66
			case "raised-target":
				b.Y = 3
				a.Pitch = .27
				want = 66
			case "range":
				m.World.Obstacles = nil
				m.World.Rules.BowRange = 10
			}
			fireBow(t, m, a)
			if kind == "raised-target" {
				b.Y = 3
			}
			// Exercise airborne target boxes without changing their height while the
			// projectile alone advances (ordinary jumps are covered by movement tests).
			for n := 0; len(m.projectiles) > 0 && n < 600; n++ {
				m.Tick++
				m.stepProjectiles()
			}
			if b.Health != want || a.Arrows != 19 || len(m.projectiles) > 0 {
				t.Fatalf("health=%v want=%v diag=%+v", b.Health, want, a.LastCombat)
			}
		})
	}
}

func TestBowDefenseAtImpactAndFirstTarget(t *testing.T) {
	for _, kind := range []string{"front-block", "rear-block", "shield", "expired-shield"} {
		t.Run(kind, func(t *testing.T) {
			m, a, b := readyMatch(t)
			b.Z = -10
			c, _ := m.Add("Позади")
			c.Motion = Motion{Z: -20, Stamina: 100}
			c.ShieldTick = 0
			fireBow(t, m, a)
			// Shooter moves behind the target after release; block must still use the
			// incoming arrow direction, not the shooter's new position.
			a.X, a.Z = 4, -15
			want := 66.0
			for len(m.projectiles) > 0 {
				if kind == "front-block" || kind == "rear-block" {
					yaw := math.Pi
					if kind == "rear-block" {
						yaw = 0
					} else {
						want = 100
					}
					m.Input(b.ID, Input{Seq: b.lastSeq + 1, Weapon: Sword, Block: true, Yaw: yaw})
				}
				if kind == "shield" {
					b.ShieldTick = m.Tick + 100
					want = 100
				}
				if kind == "expired-shield" {
					b.ShieldTick = m.Tick
				}
				m.Step()
			}
			if b.Health != want || c.Health != 100 {
				t.Fatalf("invalid defense/penetration: %v %v", b.Health, c.Health)
			}
		})
	}
}

func TestBowCancellationAndUnavailableShots(t *testing.T) {
	for _, kind := range []string{"tap", "cancel", "switch", "disconnect", "timeout", "dead", "stamina", "ammo", "waiting", "countdown", "finished", "respawn"} {
		t.Run(kind, func(t *testing.T) {
			m, a, b := readyMatch(t)
			ticks := uint64(30)
			if kind == "tap" {
				ticks = 5
			}
			drawBow(t, m, a, ticks)
			switch kind {
			case "cancel":
				bowInput(t, m, a, false, true)
			case "switch":
				m.Input(a.ID, Input{Seq: a.lastSeq + 1, Weapon: Sword})
				m.Step()
			case "disconnect":
				m.Disconnect(a.ID)
				m.Step()
				m.Resume(a.ID)
			case "timeout":
				for n := 0; n < 20; n++ {
					m.Step()
				}
			case "dead":
				a.Health = 0
				a.RespawnTick = m.Tick + 100
			case "stamina":
				a.Stamina = 0
			case "ammo":
				a.Arrows = 0
			case "waiting":
				delete(m.Players, b.ID)
			case "countdown", "finished":
				m.Phase = kind
				m.EndTick = m.Tick + 100
			case "respawn":
				m.respawn(a)
			}
			bowInput(t, m, a, false, false)
			if len(m.projectiles) != 0 || a.BowDrawTicks != 0 || b.Health != 100 || (kind != "ammo" && a.Arrows != 20) {
				t.Fatalf("%s caused an unintended shot", kind)
			}
		})
	}
}

func TestBowInputGapsFloodAndReleaseCoalescing(t *testing.T) {
	m, a, _ := readyMatch(t)
	drawBow(t, m, a, 20)
	for n := 0; n < 5; n++ {
		m.Step()
	}
	if a.BowDrawTicks != 25 || a.Arrows != 20 {
		t.Fatal("packet gap fired or reset bow")
	}
	release := a.lastSeq + 1
	m.Input(a.ID, Input{Seq: release, Weapon: Bow, Pitch: .2})
	for n := 0; n < 7; n++ {
		m.Input(a.ID, Input{Seq: a.lastSeq + 1, Weapon: Bow, Attack: true})
	}
	m.Step()
	if a.Arrows != 19 || a.LastAttackSeq != release || len(m.projectiles) != 1 || m.projectiles[0].Velocity.Y <= 0 {
		t.Fatal("coalescing lost release or its aim")
	}
	m, a, _ = readyMatch(t)
	for seq := uint64(1); seq <= 100; seq++ {
		m.Input(a.ID, Input{Seq: seq, Weapon: Bow, Attack: true})
	}
	m.Step()
	if a.BowDrawTicks != 1 {
		t.Fatal("input flood accelerated draw")
	}
}

func TestBowCooldownAmmoKillAndRespawn(t *testing.T) {
	m, a, b := readyMatch(t)
	b.Z = -10
	for n := 0; n < 3; n++ {
		fireBow(t, m, a)
		if n == 0 {
			m.Input(a.ID, Input{Seq: a.lastSeq + 1, Weapon: Sword, Attack: true})
			m.Step()
			if a.LastCombat.Reason != "cooldown" {
				t.Fatal("weapon switch bypassed release cooldown")
			}
		}
		finishFlight(t, m)
	}
	if b.Health != 0 || b.Deaths != 1 || a.Kills != 1 || a.Arrows != 17 {
		t.Fatalf("invalid ranged kill: %+v %+v", a, b)
	}
	for b.Health == 0 {
		m.Step()
	}
	if b.Arrows != 20 || b.ShieldTick <= m.Tick {
		t.Fatal("respawn did not refill and protect victim")
	}
	m.respawn(a)
	if a.Arrows != 20 || a.Weapon != Bow {
		t.Fatal("respawn lost inventory/weapon")
	}
	a.Arrows = 7
	m.Disconnect(a.ID)
	m.Resume(a.ID)
	if a.Arrows != 7 || a.Weapon != Bow {
		t.Fatal("reconnect reset inventory")
	}
	for _, weapon := range []int{-1, 3, 100} {
		if (Input{Seq: 1, Weapon: weapon}).Valid() {
			t.Fatal("invalid weapon accepted")
		}
	}
}

func TestBowUsesCurrentWorldEvenWithStaleView(t *testing.T) {
	m, a, b, input := historicalMatch(t, Bow, .2)
	a.Pitch = .13
	drawBow(t, m, a, 60)
	input.Seq = a.lastSeq + 1
	input.Attack = false
	input.Pitch = a.Pitch
	m.Input(a.ID, input)
	m.Step()
	if a.LastCombat.RewindMS != 0 || len(m.projectiles) != 1 {
		t.Fatal("projectile depended on historical view")
	}
	finishFlight(t, m)
	if b.Health != 100 {
		t.Fatal("arrow hit the target's old position")
	}
}

func TestBowLifecycleClearsProjectiles(t *testing.T) {
	for _, kind := range []string{"round-end", "waiting", "shooter-respawn", "shooter-reconnect", "target-respawn"} {
		t.Run(kind, func(t *testing.T) {
			m, a, b := readyMatch(t)
			b.Z = -20
			a.Pitch = .13
			fireBow(t, m, a)
			switch kind {
			case "round-end":
				m.EndTick = m.Tick + 1
			case "waiting":
				delete(m.Players, b.ID)
			case "shooter-respawn":
				m.respawn(a)
			case "shooter-reconnect":
				m.Disconnect(a.ID)
				m.Resume(a.ID)
			case "target-respawn":
				m.respawn(b)
			}
			m.Step()
			finishFlight(t, m)
			if b.Health != 100 {
				t.Fatal("old projectile damaged a new life")
			}
		})
	}
}
