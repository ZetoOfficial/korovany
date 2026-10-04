package game

import (
	_ "embed"
	"encoding/json"
	"math"
)

// One source of geometry, damage tuning and keyframes for Go and Three.js.
//
//go:embed data/combat.json
var combatData []byte

type BodyPart struct {
	ID         string
	Limb       int
	Multiplier float64
	Pivot      [3]float64
	Boxes      []struct{ Center, Size [3]float64 }
}

type CombatRules struct {
	ArmHealth, LegHealth, WindupTicks, StrikeTicks, BladeRadius float64
	BladeBase, BladeTip                                         [3]float64
	Shield                                                      struct{ Center, Size [3]float64 }
	Swing                                                       []struct {
		Time     float64
		Rotation [3]float64
	}
	Parts []BodyPart
}

var combat = func() CombatRules {
	var c CombatRules
	if err := json.Unmarshal(combatData, &c); err != nil {
		panic(err)
	}
	return c
}()

func (p *Motion) limbMissing(index int) bool {
	limit := combat.ArmHealth
	if index >= 2 {
		limit = combat.LegHealth
	}
	return p.LimbDamage[index] >= limit
}
func (p *Motion) canWalk() bool { return !p.limbMissing(2) && !p.limbMissing(3) }
func (p *Motion) canBow() bool  { return !p.limbMissing(0) && !p.limbMissing(1) }

func add(a, b Vec3) Vec3           { return Vec3{a.X + b.X, a.Y + b.Y, a.Z + b.Z} }
func sub(a, b Vec3) Vec3           { return Vec3{a.X - b.X, a.Y - b.Y, a.Z - b.Z} }
func scale(a Vec3, s float64) Vec3 { return Vec3{a.X * s, a.Y * s, a.Z * s} }
func vector(a [3]float64) Vec3     { return Vec3{a[0], a[1], a[2]} }
func magnitude(a Vec3) float64     { return math.Sqrt(a.X*a.X + a.Y*a.Y + a.Z*a.Z) }

// Three.js Euler XYZ applies Z, then Y, then X to column vectors.
func rotate(v, r Vec3, inverse bool) Vec3 {
	rx := func(a float64) { c, s := math.Cos(a), math.Sin(a); v.Y, v.Z = c*v.Y-s*v.Z, s*v.Y+c*v.Z }
	ry := func(a float64) { c, s := math.Cos(a), math.Sin(a); v.X, v.Z = c*v.X+s*v.Z, -s*v.X+c*v.Z }
	rz := func(a float64) { c, s := math.Cos(a), math.Sin(a); v.X, v.Y = c*v.X-s*v.Y, s*v.X+c*v.Y }
	if inverse {
		rx(-r.X)
		ry(-r.Y)
		rz(-r.Z)
	} else {
		rz(r.Z)
		ry(r.Y)
		rx(r.X)
	}
	return v
}

func swordRotation(age, duration float64) Vec3 {
	t := clamp(age/duration, 0, 1)
	for i := 1; i < len(combat.Swing); i++ {
		a, b := combat.Swing[i-1], combat.Swing[i]
		if t <= b.Time {
			f := clamp((t-a.Time)/(b.Time-a.Time), 0, 1)
			f = f * f * (3 - 2*f)
			return add(vector(a.Rotation), scale(sub(vector(b.Rotation), vector(a.Rotation)), f))
		}
	}
	return vector(combat.Swing[len(combat.Swing)-1].Rotation)
}

func partRotation(p *Player, part string, tick float64, r Rules) Vec3 {
	walk := math.Sin(p.Gait) * .5
	if part == "leftLeg" {
		return Vec3{X: walk}
	}
	if part == "rightLeg" {
		return Vec3{X: -walk}
	}
	if part != "leftArm" && part != "rightArm" {
		return Vec3{}
	}
	if p.Weapon == Bow && p.canBow() {
		return Vec3{X: 1.15 + p.Pitch + float64(p.BowDrawTicks)/float64(r.BowDrawTicks)*.25}
	}
	if part == "rightArm" && !p.Dummy {
		age := tick - float64(p.AttackTick)
		if swordActive(p, tick, r) {
			v := swordRotation(age, float64(r.AttackTicks))
			v.X += p.AttackPitch
			return v
		}
		if p.Blocking {
			return Vec3{X: 1.2, Z: -.8}
		}
		return Vec3{X: .45 + p.Pitch}
	}
	return Vec3{X: -walk * .5}
}

type BodyHit struct {
	Part     string
	Distance float64
	Point    Vec3
}

func shieldActive(p *Player, tick float64, r Rules) bool {
	return p.Blocking && p.Weapon == Sword && p.Health > 0 && !p.limbMissing(1) && !swordActive(p, tick, r)
}

// The shield is a solid, upright box in front of the player. Whichever surface
// the weapon reaches first wins, so a hit around the shield still damages flesh.
func combatHit(p *Player, tick float64, r Rules, origin, direction Vec3, limit, padding float64) (BodyHit, bool) {
	result, found := bodyHit(p, tick, r, origin, direction, limit, padding)
	if !shieldActive(p, tick, r) {
		return result, found
	}
	yaw := Vec3{Y: bodyYaw(p, tick, r)}
	o := rotate(sub(origin, Vec3{p.X, p.Y, p.Z}), yaw, true)
	d := rotate(direction, yaw, true)
	center := vector(combat.Shield.Center)
	half := add(scale(vector(combat.Shield.Size), .5), Vec3{padding, padding, padding})
	if distance, hit := rayBox(o, d, sub(center, half), add(center, half), result.Distance); hit && (!found || distance < result.Distance) {
		return BodyHit{"shield", distance, add(origin, scale(direction, distance))}, true
	}
	return result, found
}

// Intersect each animated oriented box, leaving the gaps between limbs empty.
func bodyHit(p *Player, tick float64, r Rules, origin, direction Vec3, limit, padding float64) (BodyHit, bool) {
	root := Vec3{p.X, p.Y, p.Z}
	yaw := Vec3{Y: bodyYaw(p, tick, r)}
	o := rotate(sub(origin, root), yaw, true)
	d := rotate(direction, yaw, true)
	result := BodyHit{Distance: limit}
	found := false
	for _, part := range combat.Parts {
		if part.Limb >= 0 && p.limbMissing(part.Limb) {
			continue
		}
		rotation := partRotation(p, part.ID, tick, r)
		localOrigin := rotate(sub(o, vector(part.Pivot)), rotation, true)
		localDirection := rotate(d, rotation, true)
		for _, box := range part.Boxes {
			half := add(scale(vector(box.Size), .5), Vec3{padding, padding, padding})
			distance, hit := rayBox(localOrigin, localDirection, sub(vector(box.Center), half), add(vector(box.Center), half), result.Distance)
			if hit && (!found || distance < result.Distance) {
				result = BodyHit{part.ID, distance, add(origin, scale(direction, distance))}
				found = true
			}
		}
	}
	return result, found
}

func swordActive(p *Player, tick float64, r Rules) bool {
	age := tick - float64(p.AttackTick)
	return p.Weapon == Sword && p.AttackWeapon == Sword && p.AttackTick > 0 && age >= 0 && age < float64(r.AttackTicks)
}

func bodyYaw(p *Player, tick float64, r Rules) float64 {
	if swordActive(p, tick, r) {
		return p.AttackYaw
	}
	return p.Yaw
}
