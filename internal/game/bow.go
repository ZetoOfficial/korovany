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

func (m *Match) shoot(p *Player) {
	r := m.World.Rules
	origin := Vec3{p.X, p.Y + 1.8, p.Z}
	direction := Vec3{-math.Sin(p.Yaw) * math.Cos(p.Pitch), math.Sin(p.Pitch), -math.Cos(p.Yaw) * math.Cos(p.Pitch)}
	nearest := r.BowRange
	if direction.Y < 0 {
		nearest = math.Min(nearest, -origin.Y/direction.Y)
	}
	for _, o := range m.World.Obstacles {
		if d, hit := rayBox(origin, direction, Vec3{o.X - o.W/2, 0, o.Z - o.D/2}, Vec3{o.X + o.W/2, o.Height, o.Z + o.D/2}, nearest); hit {
			nearest = d
		}
	}
	var target *Player
	for _, other := range m.ordered() {
		if other.ID == p.ID || other.Health <= 0 {
			continue
		}
		if d, hit := rayBox(origin, direction, Vec3{other.X - r.Radius, other.Y, other.Z - r.Radius}, Vec3{other.X + r.Radius, other.Y + 2.2, other.Z + r.Radius}, nearest); hit && d < nearest {
			target, nearest = other, d
		}
	}
	end := Vec3{origin.X + direction.X*nearest, origin.Y + direction.Y*nearest, origin.Z + direction.Z*nearest}
	m.emit("arrow", p.ID, "", 0)
	event := &m.events[len(m.events)-1]
	event.From, event.To = &origin, &end
	// Spawn protection stops the arrow too; it cannot hit someone behind the shield.
	if target != nil && m.Tick >= target.ShieldTick {
		m.damage(p, target, r.BowDamage)
	}
}
