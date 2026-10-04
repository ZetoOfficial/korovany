package game

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"testing"
)

func TestShieldGeometryAndExposedBody(t *testing.T) {
	data, err := os.ReadFile("data/shield_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Part        string
		Origin, Direction [3]float64
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, yaw := range []float64{0, math.Pi / 2, math.Pi, -.7} {
		for _, c := range cases {
			t.Run(fmt.Sprintf("%s/yaw=%.2f", c.Name, yaw), func(t *testing.T) {
				m, _, p := readyMatch(t)
				p.Motion = Motion{X: 4, Y: 2, Z: 6, Yaw: yaw, Pitch: .8, Stamina: 100, Blocking: true}
				root, rotation := Vec3{p.X, p.Y, p.Z}, Vec3{Y: yaw}
				origin := add(root, rotate(vector(c.Origin), rotation, false))
				direction := rotate(vector(c.Direction), rotation, false)
				hit, ok := combatHit(p, 200, m.World.Rules, origin, direction, 6, 0)
				if ok != (c.Part != "") || hit.Part != c.Part {
					t.Fatalf("got %+v hit=%v, want %s", hit, ok, c.Part)
				}
			})
		}
	}
}

func TestShieldAvailability(t *testing.T) {
	for _, scenario := range []string{"lowered", "bow", "lost-arm", "dead", "swing"} {
		t.Run(scenario, func(t *testing.T) {
			m, _, p := readyMatch(t)
			p.Motion = Motion{Stamina: 100, Blocking: true}
			switch scenario {
			case "lowered":
				p.Blocking = false
			case "bow":
				p.Weapon = Bow
			case "lost-arm":
				p.LimbDamage[1] = combat.ArmHealth
			case "dead":
				p.Health = 0
			case "swing":
				p.AttackTick, p.AttackWeapon = 195, Sword
			}
			hit, _ := combatHit(p, 200, m.World.Rules, Vec3{Y: 1.3, Z: -3}, Vec3{Z: 1}, 6, 0)
			if hit.Part == "shield" {
				t.Fatal("unavailable shield still intercepted attack")
			}
		})
	}
}

func TestShieldStopsArrowsWithoutBodyDamage(t *testing.T) {
	for _, scenario := range []string{"front", "rear", "side", "edge", "lowered", "wall"} {
		t.Run(scenario, func(t *testing.T) {
			m, a, b := readyMatch(t)
			b.Motion = Motion{Stamina: 100, Blocking: true}
			origin, direction := Vec3{Y: 1.3, Z: -2}, Vec3{Z: 1}
			want := "shield"
			switch scenario {
			case "rear":
				origin.Z, direction.Z, want = 2, -1, "torso"
			case "side":
				origin, direction, want = Vec3{X: -2, Y: 1.2}, Vec3{X: 1}, "leftArm"
			case "edge":
				origin.X = .8
			case "lowered":
				b.Blocking, want = false, "torso"
			case "wall":
				m.World.Obstacles = append(m.World.Obstacles, Obstacle{Z: -1.5, W: 4, D: .05, Height: 3})
				want = ""
			}
			c, _ := m.Add("Behind shield")
			c.Motion = Motion{X: origin.X + direction.X*4, Z: origin.Z + direction.Z*4, Stamina: 100}
			c.ShieldTick = 0
			d := &CombatDiagnostic{}
			m.projectiles = []Projectile{{ID: 1, Actor: a.ID, Life: a.Life, Seq: 7, Position: origin, Velocity: scale(direction, 28), damage: 34, remaining: 6, diagnostic: d}}
			for n := 0; n < 60 && len(m.projectiles) > 0; n++ {
				m.Tick++
				m.stepProjectiles()
			}
			if d.Part != want {
				t.Fatalf("contact=%+v, want %s", d, want)
			}
			if want == "shield" {
				if b.Health != 100 || b.LimbDamage != [4]float64{} || b.ImpulseX != 0 || b.ImpulseZ != 0 || b.Stamina != 92 || c.Health != 100 {
					t.Fatalf("shield failed: %+v, behind health=%v", b, c.Health)
				}
				e := m.events[len(m.events)-1]
				if e.Part != "shield" || !e.Blocked || e.Damage != 0 || e.Severed || e.To == nil || e.Seq != 7 {
					t.Fatalf("invalid block feedback: %+v", e)
				}
			} else if want != "" && b.Health == 100 {
				t.Fatal("shield granted body invulnerability")
			}
		})
	}
}

func TestShieldStopsSwordBeforeBody(t *testing.T) {
	m, a, b := readyMatch(t)
	m.Input(a.ID, Input{Seq: 1, Attack: true})
	m.Input(b.ID, Input{Seq: 1, Block: true, Yaw: math.Pi})
	m.Step()
	resolveSword(t, m, a)
	if a.LastCombat.Part != "shield" || a.LastCombat.Reason != "block" || b.Health != 100 || b.LimbDamage != [4]float64{} || b.ImpulseX != 0 || b.ImpulseZ != 0 {
		t.Fatalf("sword bypassed shield: %+v", a.LastCombat)
	}
	if len(m.events) != 1 || !m.events[0].Blocked || m.events[0].Damage != 0 {
		t.Fatalf("invalid sword block events: %+v", m.events)
	}
}
