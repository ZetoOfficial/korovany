package game

import (
	"encoding/json"
	"math"
	"os"
	"testing"
)

func TestMovementContract(t *testing.T) {
	data, err := os.ReadFile("data/movement_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name  string
		Start Motion
		Steps []struct {
			Count int
			Input Input
		}
		Expected Motion
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			p := c.Start
			for _, step := range c.Steps {
				for n := 0; n < step.Count; n++ {
					Move(LoadWorld(), &p, step.Input)
				}
			}
			for _, pair := range [][2]float64{{p.X, c.Expected.X}, {p.Y, c.Expected.Y}, {p.Z, c.Expected.Z}, {p.Stamina, c.Expected.Stamina}} {
				if math.Abs(pair[0]-pair[1]) > 1e-8 {
					t.Errorf("got %.12f, want %.12f", pair[0], pair[1])
				}
			}
		})
	}
}

func readyMatch(t *testing.T) (*Match, *Player, *Player) {
	t.Helper()
	m := NewMatch()
	a, err := m.Add("Эльф")
	if err != nil {
		t.Fatal(err)
	}
	b, err := m.Add("Страж")
	if err != nil {
		t.Fatal(err)
	}
	m.Phase = "playing"
	m.Tick = 200
	m.EndTick = 10000
	a.Motion = Motion{X: 0, Z: 0, Stamina: 100}
	b.Motion = Motion{X: 0, Z: -2, Yaw: math.Pi, Stamina: 100}
	a.ShieldTick = 0
	b.ShieldTick = 0
	return m, a, b
}

func TestAttackAndBlockAreAuthoritative(t *testing.T) {
	m, a, b := readyMatch(t)
	m.Input(a.ID, Input{Seq: 1, Attack: true})
	m.Input(b.ID, Input{Seq: 1, Block: true, Yaw: math.Pi})
	m.Step()
	if b.Health != 91 {
		t.Fatalf("front block should reduce damage, health=%v", b.Health)
	}
	for n := uint64(2); n < 20; n++ {
		m.Input(a.ID, Input{Seq: n, Attack: true})
		m.Step()
	}
	if b.Health != 91 {
		t.Fatal("attack cooldown was bypassed")
	}
	// Blocking the wrong direction does not protect the defender.
	m.Tick += 40
	m.Input(a.ID, Input{Seq: 20, Attack: true})
	m.Input(b.ID, Input{Seq: 2, Block: true, Yaw: 0})
	m.Step()
	if b.Health != 56 {
		t.Fatalf("rear hit should do full damage: %v", b.Health)
	}
}

func TestAttacksRespectRangeWallsAndSpawnProtection(t *testing.T) {
	for _, kind := range []string{"range", "wall", "shield", "facing", "height"} {
		t.Run(kind, func(t *testing.T) {
			m, a, b := readyMatch(t)
			switch kind {
			case "range":
				b.Z = -4
			case "wall":
				m.World.Obstacles = append(m.World.Obstacles, Obstacle{X: 0, Z: -1, W: 4, D: .1, Height: 3})
			case "shield":
				b.ShieldTick = 1000
			case "facing":
				b.Z = 2
			case "height":
				b.Y = 3
			}
			m.Input(a.ID, Input{Seq: 1, Attack: true})
			m.Step()
			if b.Health != 100 {
				t.Fatalf("%s did not prevent damage: %v", kind, b.Health)
			}
		})
	}
}

func TestDeathRespawnAndWin(t *testing.T) {
	m, a, b := readyMatch(t)
	b.Health = 30
	m.Input(a.ID, Input{Seq: 1, Attack: true})
	m.Step()
	if b.Health != 0 || b.Deaths != 1 || a.Kills != 1 {
		t.Fatalf("invalid kill: %+v %+v", a, b)
	}
	originalX := b.X
	m.Input(b.ID, Input{Seq: 1, Strafe: 1, Attack: true})
	m.Step()
	if b.X != originalX || a.Health != 100 {
		t.Fatal("dead player acted")
	}
	life := b.Life
	for b.Health == 0 {
		m.Step()
	}
	if b.Health != 100 || b.Life != life+1 || b.ShieldTick <= m.Tick {
		t.Fatal("invalid respawn")
	}
	a.Kills = 10
	m.Step()
	if m.Phase != "finished" {
		t.Fatal("score limit did not end match")
	}
	end := m.EndTick
	for m.Tick < end {
		m.Step()
	}
	if m.Phase != "countdown" || a.Kills != 0 || b.Deaths != 0 {
		t.Fatal("next round was not reset")
	}
}

func TestInputCannotSpeedUpTime(t *testing.T) {
	m, a, _ := readyMatch(t)
	for n := uint64(1); n <= 100; n++ {
		m.Input(a.ID, Input{Seq: n, Forward: 1})
	}
	m.Step()
	if math.Abs(a.Z+m.World.Rules.WalkSpeed/60) > 1e-10 {
		t.Fatal("flood advanced more than one tick")
	}
	if len(a.queue) > 15 {
		t.Fatal("unbounded input queue")
	}
	if m.Input(a.ID, Input{Seq: 1}) {
		t.Fatal("replayed input accepted")
	}
	for _, input := range []Input{{Seq: 101, Forward: 100}, {Seq: 101, Yaw: math.NaN()}, {Seq: 101, Pitch: 2}, {Seq: 101, Strafe: math.Inf(1)}} {
		if m.Input(a.ID, input) {
			t.Fatalf("invalid input accepted: %+v", input)
		}
	}
}

func TestDisconnectResumeAndExpiry(t *testing.T) {
	m, a, _ := readyMatch(t)
	m.Input(a.ID, Input{Seq: 1, Forward: 1, Block: true})
	m.Step()
	m.Disconnect(a.ID)
	z := a.Z
	for n := 0; n < 60; n++ {
		m.Step()
	}
	if a.Z != z || a.Blocking {
		t.Fatal("disconnected player kept moving or blocking")
	}
	if !m.Resume(a.ID) || m.Resume(a.ID) {
		t.Fatal("session ownership is incorrect")
	}
	if !m.Input(a.ID, Input{Seq: 1}) {
		t.Fatal("resumed sequence was not reset")
	}
	m.Disconnect(a.ID)
	for n := 0; n < 1200; n++ {
		m.Step()
	}
	if m.Players[a.ID] != nil || m.Resume(a.ID) {
		t.Fatal("expired player still exists")
	}
}

func TestRoomLifecycleAndMap(t *testing.T) {
	m := NewMatch()
	for _, spawn := range m.World.Spawns {
		if m.World.Blocked(spawn.X, spawn.Z) {
			t.Fatal("blocked spawn")
		}
	}
	m.Add("Один")
	m.Step()
	if m.Phase != "waiting" {
		t.Fatal("solo round started")
	}
	m.Add("Два")
	m.Step()
	if m.Phase != "countdown" {
		t.Fatal("countdown missing")
	}
	for n := 0; n < 180; n++ {
		m.Step()
	}
	if m.Phase != "playing" {
		t.Fatal("match did not start")
	}
	for n := 2; n < 8; n++ {
		if _, err := m.Add("Боец"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := m.Add("Лишний"); err == nil {
		t.Fatal("capacity exceeded")
	}
	m.EndTick = m.Tick + 1
	m.Step()
	if m.Phase != "finished" {
		t.Fatal("timer did not end match")
	}
}
