package game

import (
	"encoding/json"
	"math"
	"os"
	"testing"
)

func finishSwing(t *testing.T, m *Match, p *Player) {
	t.Helper()
	for n := 0; p.swing != nil && n < 40; n++ {
		m.Step()
		m.Snapshot()
	}
	if p.swing != nil {
		t.Fatal("sword did not finish")
	}
}

// Advance only combat for legacy combat/rewind unit tests. Their positions and
// blocking state are controlled explicitly rather than by an input stream.
func resolveSword(t *testing.T, m *Match, p *Player) {
	t.Helper()
	for n := 0; p.swing != nil && n < 40; n++ {
		m.Tick++
		m.stepSwords()
		m.Snapshot()
	}
	if p.swing != nil {
		t.Fatal("sword did not finish")
	}
}

func TestBodyGeometryAndEmptySpace(t *testing.T) {
	m, _, p := readyMatch(t)
	p.Motion = Motion{Stamina: 100}
	p.Dummy = true
	cases := []struct {
		name string
		x, y float64
		part string
	}{
		{"head", 0, 1.9, "head"}, {"chest", 0, 1.3, "torso"},
		{"left arm", -.46, 1.2, "leftArm"}, {"right arm", .46, 1.2, "rightArm"},
		{"left leg", -.19, .5, "leftLeg"}, {"right leg", .19, .5, "rightLeg"},
		{"between legs", 0, .5, ""}, {"beside head", .31, 1.9, ""}, {"between arm and torso", .34, 1.2, ""},
		{"above head", 0, 2.3, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			hit, ok := bodyHit(p, 200, m.World.Rules, Vec3{c.x, c.y, 3}, Vec3{Z: -1}, 6, 0)
			if ok != (c.part != "") || hit.Part != c.part {
				t.Fatalf("got %+v, hit=%v", hit, ok)
			}
		})
	}
	p.LimbDamage[0] = combat.ArmHealth
	if _, ok := bodyHit(p, 200, m.World.Rules, Vec3{-.46, 1.2, 3}, Vec3{Z: -1}, 6, 0); ok {
		t.Fatal("missing arm still blocks shots")
	}
}

func TestAnimatedRotatedBody(t *testing.T) {
	m, _, p := readyMatch(t)
	p.Motion = Motion{Stamina: 100, Yaw: math.Pi / 2}
	p.Dummy = true
	hit, ok := bodyHit(p, 200, m.World.Rules, Vec3{3, 1.2, .46}, Vec3{X: -1}, 6, 0)
	if !ok || hit.Part != "leftArm" {
		t.Fatalf("rotated arm: %+v", hit)
	}
	p.Yaw = 0
	p.Weapon = Bow
	p.BowDrawTicks = 60
	// Raised arms leave their former hanging position empty.
	if _, ok := bodyHit(p, 200, m.World.Rules, Vec3{-.46, .9, 3}, Vec3{Z: -1}, 6, 0); ok {
		t.Fatal("old arm pose remained hittable")
	}
	part := combat.Parts[2]
	rotation := partRotation(p, part.ID, 200, m.World.Rules)
	point := add(vector(part.Pivot), rotate(Vec3{Y: -.32}, rotation, false))
	hit, ok = bodyHit(p, 200, m.World.Rules, add(point, Vec3{X: -2}), Vec3{X: 1}, 2.1, 0)
	if !ok || hit.Part != "leftArm" {
		t.Fatalf("raised arm not hit: %+v", hit)
	}
}

func TestLocalizedDamageAndInjuries(t *testing.T) {
	for _, c := range []struct {
		part   string
		damage float64
	}{{"head", 70}, {"torso", 35}, {"leftArm", 14}, {"rightArm", 14}, {"leftLeg", 23}, {"rightLeg", 23}} {
		t.Run(c.part, func(t *testing.T) {
			m, a, b := readyMatch(t)
			m.damageFrom(a, b, 35, &CombatDiagnostic{}, Vec3{}, 1, a.Life, BodyHit{Part: c.part})
			if b.Health != 100-c.damage {
				t.Fatalf("health=%v", b.Health)
			}
			e := m.events[len(m.events)-1]
			if e.Part != c.part || e.Damage != c.damage {
				t.Fatal("missing hit location")
			}
		})
	}
	for limb := 0; limb < 4; limb++ {
		m, a, b := readyMatch(t)
		b.Weapon = Bow
		b.BowDrawTicks = 60
		part := combat.Parts[limb+2].ID
		for n := 0; n < 2; n++ {
			m.damageFrom(a, b, 35, &CombatDiagnostic{}, Vec3{}, 1, a.Life, BodyHit{Part: part})
		}
		if !b.limbMissing(limb) || !m.events[len(m.events)-1].Severed || b.Health <= 0 {
			t.Fatalf("limb %d: %+v", limb, b)
		}
		if limb < 2 {
			arrows := b.Arrows
			m.updateBow(b, queuedInput{Input: Input{Seq: 1}, receivedTick: float64(m.Tick)})
			if b.canBow() || b.BowDrawTicks != 0 || b.Arrows != arrows || len(m.projectiles) != 0 {
				t.Fatal("missing arm allowed bow release")
			}
		} else {
			b.ImpulseX, b.ImpulseZ = 0, 0
			x, z := b.X, b.Z
			Move(m.World, &b.Motion, Input{Forward: 1, Strafe: 1, Sprint: true, Jump: true})
			if b.X != x || b.Z != z || b.Y != 0 {
				t.Fatal("missing leg allowed movement")
			}
		}
		if limb == 1 {
			b.Weapon = Sword
			m.attack(b)
			Move(m.World, &b.Motion, Input{Block: true, Weapon: Sword})
			if b.LastCombat.Reason != "arm" || b.Blocking || b.swing != nil {
				t.Fatal("missing sword arm still acts")
			}
		}
		oldLife := b.Life
		m.respawn(b)
		if b.Life != oldLife+1 || b.LimbDamage != [4]float64{} || !b.canBow() || !b.canWalk() {
			t.Fatal("respawn did not restore limbs")
		}
	}
}

func TestSwordWindupContactAndDodge(t *testing.T) {
	for _, scenario := range []string{"hit", "dodge", "wall", "switch", "death", "arm", "shield"} {
		t.Run(scenario, func(t *testing.T) {
			m, a, b := readyMatch(t)
			b.Dummy = true
			m.Input(a.ID, Input{Seq: 1, Attack: true})
			m.Step()
			if b.Health != 100 || a.swing == nil {
				t.Fatal("instant sword hit or absent swing")
			}
			for n := 0; n < 7; n++ {
				m.Step()
			}
			if b.Health != 100 {
				t.Fatal("windup damaged target")
			}
			switch scenario {
			case "dodge":
				b.X = 3
			case "wall":
				m.World.Obstacles = append(m.World.Obstacles, Obstacle{Z: -1, W: 4, D: .001, Height: 3})
			case "switch":
				a.Weapon = Bow
			case "death":
				a.Health = 0
				a.RespawnTick = 1000
			case "arm":
				a.LimbDamage[1] = combat.ArmHealth
			case "shield":
				b.ShieldTick = 1000
			}
			finishSwing(t, m, a)
			if scenario == "hit" {
				if b.Health >= 100 {
					t.Fatalf("blade missed torso: %+v", a.LastCombat)
				}
				hits := 0
				for _, e := range m.events {
					if e.Type == "hit" {
						hits++
					}
				}
				if hits != 1 {
					t.Fatalf("swing dealt %d hits", hits)
				}
			} else if b.Health != 100 {
				t.Fatalf("%s did not prevent hit", scenario)
			}
		})
	}
}

func TestSwordAimLocations(t *testing.T) {
	for _, c := range []struct {
		pitch  float64
		part   string
		health float64
	}{{-.65, "leftLeg", 77}, {-.35, "leftArm", 86}, {0, "torso", 65}, {.2, "head", 30}, {.4, "", 100}} {
		m, a, b := readyMatch(t)
		b.Dummy = true
		m.Input(a.ID, Input{Seq: 1, Attack: true, Pitch: c.pitch})
		m.Step()
		finishSwing(t, m, a)
		if b.Health != c.health || a.LastCombat.Part != c.part {
			t.Fatalf("pitch=%v health=%v part=%s", c.pitch, b.Health, a.LastCombat.Part)
		}
	}
}

func TestArrowsUseBodyPartsAndPassThroughGaps(t *testing.T) {
	for _, c := range []struct {
		x, y   float64
		part   string
		health float64
	}{{0, 1.93, "head", 32}, {0, 1.3, "torso", 66}, {-.46, 1.2, "leftArm", 86}, {.19, .5, "rightLeg", 78}, {0, .5, "", 100}, {.32, 1.93, "", 100}} {
		m, a, b := readyMatch(t)
		a.Z = 3
		b.Motion = Motion{Stamina: 100}
		b.Dummy = true
		d := &CombatDiagnostic{}
		m.projectiles = []Projectile{{ID: 1, Actor: a.ID, Life: a.Life, Seq: 1, Position: Vec3{c.x, c.y, 2}, Velocity: Vec3{Z: -28}, damage: 34, remaining: 6, diagnostic: d}}
		for n := 0; n < 60 && len(m.projectiles) > 0; n++ {
			m.Tick++
			m.stepProjectiles()
		}
		if b.Health != c.health || d.Part != c.part {
			t.Fatalf("x=%v y=%v: health=%v diag=%+v", c.x, c.y, b.Health, d)
		}
	}
}

func TestInjuryProtectionHistoryAndReconnect(t *testing.T) {
	m, a, b := readyMatch(t)
	b.Blocking = true
	m.damageFrom(a, b, 35, &CombatDiagnostic{}, Vec3{}, 1, a.Life, BodyHit{Part: "leftArm"})
	if b.Health != 86 || b.LimbDamage[0] != 35 || m.events[0].Severed || m.events[0].Blocked {
		t.Fatal("blocking made an exposed limb invulnerable")
	}
	saved := m.Snapshot()
	b.Blocking = false
	for n := 0; n < 2; n++ {
		m.damageFrom(a, b, 35, &CombatDiagnostic{}, Vec3{}, 1, a.Life, BodyHit{Part: "leftArm"})
	}
	if saved.Players[1].LimbDamage[0] != 35 {
		t.Fatal("later injury mutated historical snapshot")
	}
	health, damage := b.Health, b.LimbDamage
	m.Disconnect(b.ID)
	m.Resume(b.ID)
	if b.Health != health || b.LimbDamage != damage || b.canBow() {
		t.Fatal("reconnect healed injuries")
	}
	count := len(m.events)
	m.damageFrom(a, &saved.Players[1], 35, &CombatDiagnostic{}, Vec3{}, 1, a.Life, BodyHit{Part: "leftArm"})
	if len(m.events) != count || b.Health != health {
		t.Fatal("historical hit crossed life boundary")
	}
	b.Life = saved.Players[1].Life
	m.damageFrom(a, &saved.Players[1], 35, &CombatDiagnostic{}, Vec3{}, 1, a.Life, BodyHit{Part: "leftArm"})
	if len(m.events) != count || b.Health != health {
		t.Fatal("historical limb was damaged twice after loss")
	}
}

func TestSwordNearestTargetAndThinCover(t *testing.T) {
	m, a, b := readyMatch(t)
	b.Dummy = true
	c, _ := m.Add("behind")
	c.Motion = Motion{Z: -2.3, Stamina: 100}
	c.ShieldTick = 0
	m.Input(a.ID, Input{Seq: 1, Attack: true})
	m.Step()
	finishSwing(t, m, a)
	if b.Health == 100 || c.Health != 100 {
		t.Fatal("blade passed through nearest target")
	}
	m, a, b = readyMatch(t)
	m.World.Obstacles = append(m.World.Obstacles, Obstacle{Z: -.6, W: 4, D: .001, Height: 3})
	m.Input(a.ID, Input{Seq: 1, Attack: true})
	m.Step()
	finishSwing(t, m, a)
	if b.Health != 100 || a.LastCombat.Reason != "wall" {
		t.Fatalf("blade passed thin cover: %+v", a.LastCombat)
	}
}

func TestSharedRenderPoseContract(t *testing.T) {
	data, err := os.ReadFile("data/pose_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Part      string
		State           Player
		Tick            float64
		Point, Expected [3]float64
		BladeTip        *[3]float64
	}
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			p := c.State
			r := LoadWorld().Rules
			for _, part := range combat.Parts {
				if part.ID == c.Part {
					point := add(vector(part.Pivot), rotate(vector(c.Point), partRotation(&p, c.Part, c.Tick, r), false))
					point = add(Vec3{p.X, p.Y, p.Z}, rotate(point, Vec3{Y: bodyYaw(&p, c.Tick, r)}, false))
					if magnitude(sub(point, vector(c.Expected))) > 1e-9 {
						t.Fatalf("server hitbox differs from Three.js: %v vs %v", point, c.Expected)
					}
				}
			}
			if c.BladeTip != nil {
				_, tip := blade(&p, c.Tick-float64(p.AttackTick), r)
				if magnitude(sub(tip, vector(*c.BladeTip))) > 1e-9 {
					t.Fatalf("server blade differs from rendered tip: %v vs %v", tip, *c.BladeTip)
				}
			}
		})
	}
}
