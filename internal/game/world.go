// Package game contains the match simulation. It has no networking or rendering dependencies.
package game

import (
	_ "embed"
	"encoding/json"
	"math"
)

//go:embed data/arena.json
var arenaJSON []byte

type Rules struct {
	TickRate, SnapshotRate, MaxPlayers, RoundSeconds, ScoreLimit, CountdownSeconds int
	RespawnSeconds, ShieldSeconds, Radius, WalkSpeed, RunSpeed, Gravity, JumpSpeed float64
	JumpCost, RunDrain, StaminaRegen, BlockRegen, AttackCost                       float64
	AttackTicks                                                                    uint64
	AttackRange, AttackDamage                                                      float64
	BowCost, BowRange, BowDamage                                                   float64
	BowTicks                                                                       uint64
	Arrows                                                                         int
}

type Obstacle struct{ X, Z, W, D, Height float64 }
type Spawn struct{ X, Z, Yaw float64 }
type World struct {
	Version   string
	Bounds    struct{ X, Z float64 }
	Rules     Rules
	Spawns    []Spawn
	Obstacles []Obstacle
}

func LoadWorld() World {
	var w World
	if err := json.Unmarshal(arenaJSON, &w); err != nil {
		panic(err)
	}
	return w
}

func clamp(v, low, high float64) float64 { return math.Max(low, math.Min(v, high)) }

func (w World) Blocked(x, z float64) bool {
	r := w.Rules.Radius
	for _, o := range w.Obstacles {
		if math.Abs(x-o.X) < o.W/2+r && math.Abs(z-o.Z) < o.D/2+r {
			return true
		}
	}
	return false
}

// Clear uses an exact segment/AABB intersection; thin walls cannot fall between samples.
func (w World) Clear(ax, az, bx, bz float64) bool {
	for _, o := range w.Obstacles {
		lo, hi := 0.0, 1.0
		for _, axis := range [][4]float64{{ax, bx - ax, o.X - o.W/2, o.X + o.W/2}, {az, bz - az, o.Z - o.D/2, o.Z + o.D/2}} {
			if math.Abs(axis[1]) < 1e-9 {
				if axis[0] < axis[2] || axis[0] > axis[3] {
					lo = 2
					break
				}
				continue
			}
			a, b := (axis[2]-axis[0])/axis[1], (axis[3]-axis[0])/axis[1]
			lo, hi = math.Max(lo, math.Min(a, b)), math.Min(hi, math.Max(a, b))
		}
		if lo <= hi {
			return false
		}
	}
	return true
}

type Input struct {
	Life    uint64    `json:"life,omitempty"`
	View    *ViewTime `json:"view,omitempty"`
	Weapon  int       `json:"weapon,omitempty"`
	Seq     uint64    `json:"seq"`
	Forward float64   `json:"forward"`
	Strafe  float64   `json:"strafe"`
	Yaw     float64   `json:"yaw"`
	Pitch   float64   `json:"pitch"`
	Jump    bool      `json:"jump"`
	Sprint  bool      `json:"sprint"`
	Attack  bool      `json:"attack"`
	Block   bool      `json:"block"`
}

func (i Input) Valid() bool {
	for _, v := range []float64{i.Forward, i.Strafe, i.Yaw, i.Pitch} {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return false
		}
	}
	if i.View != nil {
		// Keep arithmetic and JSON diagnostics finite, including for hostile
		// finite values near MaxFloat64. Ticks must also be exact JS integers.
		if math.IsNaN(i.View.Tick) || math.IsInf(i.View.Tick, 0) || math.Abs(i.View.Tick) >= 1<<53 || i.View.From >= 1<<53 || i.View.To >= 1<<53 {
			return false
		}
	}
	return i.Weapon >= 0 && i.Weapon <= Bow && i.Seq > 0 && i.Seq < 1<<53 && math.Abs(i.Forward) <= 1 && math.Abs(i.Strafe) <= 1 && math.Abs(i.Yaw) <= math.Pi && math.Abs(i.Pitch) <= 1.35
}

type Motion struct {
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	Z        float64 `json:"z"`
	VY       float64 `json:"vy"`
	Yaw      float64 `json:"yaw"`
	Pitch    float64 `json:"pitch"`
	Stamina  float64 `json:"stamina"`
	Blocking bool    `json:"blocking"`
}

// Move is mirrored by client/simulation.ts and checked with shared movement fixtures.
// Every input advances exactly one server-owned tick, never a client-supplied duration.
func Move(w World, p *Motion, i Input) {
	r, dt := w.Rules, 1/float64(w.Rules.TickRate)
	p.Yaw, p.Pitch = i.Yaw, i.Pitch
	p.Blocking = i.Block && i.Weapon != Bow && p.Stamina > 5
	f, s := i.Forward, i.Strafe
	length := math.Hypot(f, s)
	if length > 1 {
		f /= length
		s /= length
	}
	running := i.Sprint && !p.Blocking && p.Stamina > 5 && length > 0
	speed := r.WalkSpeed
	if running {
		speed = r.RunSpeed
	}
	nx := clamp(p.X+(-math.Sin(p.Yaw)*f+math.Cos(p.Yaw)*s)*speed*dt, -w.Bounds.X+r.Radius, w.Bounds.X-r.Radius)
	nz := clamp(p.Z+(-math.Cos(p.Yaw)*f-math.Sin(p.Yaw)*s)*speed*dt, -w.Bounds.Z+r.Radius, w.Bounds.Z-r.Radius)
	if !w.Blocked(nx, p.Z) {
		p.X = nx
	}
	if !w.Blocked(p.X, nz) {
		p.Z = nz
	}
	if i.Jump && p.Y == 0 && p.Stamina >= r.JumpCost {
		p.VY = r.JumpSpeed
		p.Stamina -= r.JumpCost
	}
	p.VY -= r.Gravity * dt
	p.Y = math.Max(0, p.Y+p.VY*dt)
	if p.Y == 0 {
		p.VY = 0
	}
	regen := r.StaminaRegen
	if running {
		regen = -r.RunDrain
	} else if p.Blocking {
		regen = r.BlockRegen
	}
	p.Stamina = clamp(p.Stamina+regen*dt, 0, 100)
}
