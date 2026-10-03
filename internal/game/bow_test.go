package game

import (
	"math"
	"testing"
)

func TestBowHitsBeyondMeleeRange(t *testing.T) {
	m, a, b := readyMatch(t)
	b.Z = -20
	m.Input(a.ID, Input{Seq: 1, Weapon: Bow, Attack: true})
	m.Step()
	if a.Weapon != Bow || a.Arrows != 19 || b.Health != 66 || a.ShieldTick != 0 {
		t.Fatalf("shot was not authoritative: attacker=%+v target=%+v", a, b)
	}
	s := m.Snapshot()
	if len(s.Events) != 2 || s.Events[0].Type != "arrow" || s.Events[0].From == nil || s.Events[0].To == nil || s.Events[1].Damage != 34 {
		t.Fatalf("missing shot and hit events: %+v", s.Events)
	}
}

func TestBowKillAndRespawn(t *testing.T) {
	m, a, b := readyMatch(t)
	a.Weapon = Bow
	b.Z = -20
	b.Arrows = 0
	for n := 0; n < 3; n++ {
		m.attack(a)
		m.Tick += m.World.Rules.BowTicks
	}
	if b.Health != 0 || b.Deaths != 1 || a.Kills != 1 || a.Arrows != 17 {
		t.Fatalf("invalid ranged kill: %+v %+v", a, b)
	}
	for b.Health == 0 {
		m.Step()
	}
	if b.Arrows != m.World.Rules.Arrows || b.ShieldTick <= m.Tick {
		t.Fatal("ranged victim did not respawn with arrows and protection")
	}
}

func TestBowAimAndCover(t *testing.T) {
	for _, kind := range []string{"behind", "side", "above", "below", "range", "wall", "shield", "jump-miss", "jump-hit", "over-low-cover"} {
		t.Run(kind, func(t *testing.T) {
			m, a, b := readyMatch(t)
			a.Weapon = Bow
			b.Z = -20
			want := 100.0
			switch kind {
			case "behind":
				a.Yaw = math.Pi
			case "side":
				b.X = 2
			case "above":
				a.Pitch = 0.7
			case "below":
				a.Pitch = -0.7
			case "range":
				m.World.Obstacles = nil
				b.Z = -60
			case "wall":
				m.World.Obstacles = append(m.World.Obstacles, Obstacle{Z: -10, W: 4, D: 0.01, Height: 3})
			case "shield":
				b.ShieldTick = 1000
			case "jump-miss":
				b.Y = 3
			case "jump-hit":
				b.Y = 3
				a.Pitch = math.Atan2(b.Y+1.2-1.8, 20)
				want = 66
			case "over-low-cover":
				m.World.Obstacles = append(m.World.Obstacles, Obstacle{Z: -10, W: 4, D: 1, Height: 1})
				want = 66
			}
			m.attack(a)
			if b.Health != want || a.Arrows != 19 {
				t.Fatalf("health=%v, want %v; arrows=%v", b.Health, want, a.Arrows)
			}
		})
	}
}

func TestBowStopsAtFirstPlayerAndDirectionalBlock(t *testing.T) {
	for _, shield := range []bool{false, true} {
		m, a, b := readyMatch(t)
		a.Weapon = Bow
		b.Z = -10
		b.Blocking = true
		c, _ := m.Add("Позади")
		c.Motion = Motion{Z: -20, Stamina: 100}
		c.ShieldTick = 0
		want := 91.0
		if shield {
			b.ShieldTick = 1000
			want = 100
		}
		m.attack(a)
		if b.Health != want || c.Health != 100 {
			t.Fatalf("arrow penetrated first target or ignored block: %v, %v", b.Health, c.Health)
		}
		m.Tick += m.World.Rules.BowTicks
		b.Yaw = 0
		b.ShieldTick = 0
		m.attack(a)
		if b.Health != want-34 {
			t.Fatalf("rear block stopped arrow: %v", b.Health)
		}
	}
}

func TestBowAmmoCooldownAndWeaponSwitch(t *testing.T) {
	m, a, b := readyMatch(t)
	b.Z = -15
	m.Input(a.ID, Input{Seq: 1, Weapon: Bow, Attack: true, Block: true})
	m.Step()
	if a.Blocking {
		t.Fatal("bow can block")
	}
	b.Z = -2
	m.Input(a.ID, Input{Seq: 2, Weapon: Sword, Attack: true})
	m.Step()
	if b.Health != 66 || a.Arrows != 19 {
		t.Fatal("switching bypassed shot cooldown")
	}
	m.Tick += m.World.Rules.BowTicks
	m.Input(a.ID, Input{Seq: 3, Weapon: Sword, Attack: true})
	m.Step()
	if b.Health != 31 || a.Arrows != 19 {
		t.Fatal("sword failed after switching")
	}
	m.Tick += m.World.Rules.AttackTicks
	a.Arrows = 0
	m.Input(a.ID, Input{Seq: 4, Weapon: Bow, Attack: true})
	m.Step()
	if b.Health != 31 || a.Arrows != 0 {
		t.Fatal("empty bow dealt damage")
	}
	m.respawn(a)
	if a.Arrows != m.World.Rules.Arrows || a.Weapon != Bow {
		t.Fatal("respawn did not refill arrows and retain weapon")
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

func TestBowCannotShootWithoutStaminaOrOutsideRound(t *testing.T) {
	for _, kind := range []string{"stamina", "dead", "waiting", "countdown", "finished"} {
		m, a, b := readyMatch(t)
		a.Weapon = Bow
		switch kind {
		case "stamina":
			a.Stamina = 0
		case "dead":
			a.Health = 0
		default:
			m.Phase = kind
		}
		m.attack(a)
		if a.Arrows != 20 || b.Health != 100 {
			t.Fatalf("%s allowed a shot", kind)
		}
	}
}
