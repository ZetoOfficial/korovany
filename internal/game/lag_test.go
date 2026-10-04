package game

import (
	"fmt"
	"math"
	"testing"
)

// A target leaving reach during the windup can dodge even a compensated sword.
func TestMovingTargetDodgesWindupAt200ms(t *testing.T) {
	m, a, b := readyMatch(t)
	b.Z = -2.6
	m.Snapshot()
	view := &ViewTime{Tick: float64(m.Tick), From: m.Tick, To: m.Tick}
	m.Tick += 18
	b.Z -= 2.7
	m.SetLatency(a.ID, 0.2, 0)
	m.Input(a.ID, Input{Seq: 1, Attack: true, View: view})
	m.Step()
	resolveSword(t, m, a)
	if b.Health != 100 {
		t.Fatalf("windup froze historical target: health=%v", b.Health)
	}
}

func historicalMatch(t *testing.T, weapon int, rtt float64) (*Match, *Player, *Player, Input) {
	t.Helper()
	m, a, b := readyMatch(t)
	a.Weapon = weapon
	viewTick := 240 - (rtt+InterpolationSeconds)*60
	for tick := uint64(207); tick <= 240; tick += 3 {
		m.Tick = tick
		travel := (float64(tick) - viewTick) * 9 / 60
		if weapon == Bow {
			b.X, b.Z = travel, -20
		} else {
			b.X, b.Z = 0, -2
		}
		m.Snapshot()
	}
	m.SetLatency(a.ID, rtt, 0)
	from := uint64(math.Floor(viewTick/3) * 3)
	to := uint64(math.Ceil(viewTick/3) * 3)
	return m, a, b, Input{Seq: 1, Life: a.Life, Weapon: weapon, Attack: true, View: &ViewTime{Tick: viewTick, From: from, To: to}}
}

func TestHistoricalMovingHitsAtDifferentRTT(t *testing.T) {
	for _, rtt := range []float64{0, .1, .2} {
		t.Run(fmt.Sprintf("rtt%.0f", rtt*1000), func(t *testing.T) {
			m, a, b, input := historicalMatch(t, Sword, rtt)
			input.Forward = 1 // Movement is still applied before the windup.
			x, z := b.X, b.Z
			m.Input(a.ID, input)
			m.Step()
			resolveSword(t, m, a)
			want := 65.0
			if b.Health != want || b.X != x || b.Z != z || a.LastAttackSeq != input.Seq || a.LastCombat.Outcome != "hit" {
				t.Fatalf("historical hit failed or moved target: a=%+v b=%+v", a, b)
			}
			if a.NextAttackTick <= m.Tick || a.LastCombat.QueueMS <= 0 {
				t.Fatal("missing cooldown or timing diagnostics")
			}
			if m.Input(a.ID, input) {
				t.Fatal("duplicate accepted")
			}
			m.Step()
			resolveSword(t, m, a)
			if b.Health != want {
				t.Fatal("duplicate damage")
			}
		})
	}
}

func TestHistoricalDefenseAndLifecycle(t *testing.T) {
	for _, scenario := range []string{"block", "rear-block", "shield", "wall", "target-respawn", "target-reconnect", "target-disconnect", "target-dead", "attacker-reconnect", "jump-miss", "jump-hit"} {
		t.Run(scenario, func(t *testing.T) {
			m, a, b, input := historicalMatch(t, Sword, .2)
			want := 100.0
			for i := range m.history {
				for j := range m.history[i].players {
					p := &m.history[i].players[j]
					if p.ID != b.ID {
						continue
					}
					switch scenario {
					case "block":
						p.Blocking, p.Yaw = true, math.Pi
						want = 91
					case "rear-block":
						p.Blocking, p.Yaw = true, 0
						want = 65
					case "shield":
						p.ShieldTick = 260 // Expired now, but visible at the attack's time.
					case "jump-miss", "jump-hit":
						p.Y = 3
					}
				}
			}
			switch scenario {
			case "wall":
				m.World.Obstacles = append(m.World.Obstacles, Obstacle{Z: -1, W: 8, D: .1, Height: 10})
			case "target-respawn":
				m.respawn(b)
			case "target-reconnect":
				m.Disconnect(b.ID)
				m.Resume(b.ID)
			case "target-disconnect":
				m.Disconnect(b.ID)
				want = 65
			case "target-dead":
				b.Health = 0
				b.RespawnTick = 500
				want = 0
			case "attacker-reconnect":
				m.Disconnect(a.ID)
				m.Resume(a.ID)
				m.SetLatency(a.ID, .2, 0)
				input.Life = a.Life
			case "jump-hit":
				a.Y = 3
				want = 65
			}
			m.Input(a.ID, input)
			m.Step()
			resolveSword(t, m, a)
			if b.Health != want {
				t.Fatalf("health=%v want=%v diagnostic=%+v", b.Health, want, a.LastCombat)
			}
		})
	}
}

func TestInvalidAttackTimeStillMovesPlayer(t *testing.T) {
	for _, scenario := range []string{"stale", "future", "forged", "missing", "missing-history", "queue", "transport-queue", "bad-pair"} {
		t.Run(scenario, func(t *testing.T) {
			m, a, b, input := historicalMatch(t, Sword, .2)
			input.Forward = 1
			reason := ""
			switch scenario {
			case "stale":
				input.View.Tick = 210
				reason = "stale_view"
			case "future":
				input.View.Tick = 241
				reason = "future_view"
			case "forged":
				input.View.Tick = 239
				reason = "untrusted_view"
			case "missing":
				input.View = nil
				reason = "missing_view"
			case "missing-history":
				m.history = nil
				reason = "missing_history"
			case "bad-pair":
				input.View.From = 223
				reason = "invalid_view"
			case "queue":
				reason = "stale_view"
			case "transport-queue":
				reason = "untrusted_view"
			}
			if scenario == "transport-queue" {
				m.InputDelayed(a.ID, input, .1)
			} else {
				m.Input(a.ID, input)
			}
			if scenario == "queue" {
				m.Tick += 3
			}
			m.Step()
			if a.Z >= 0 || a.Ack != 1 || a.Arrows != 20 || a.NextAttackTick != 0 || b.Health != 100 || a.LastCombat.Reason != reason {
				t.Fatalf("rejection failed: player=%+v diagnostic=%+v", a, a.LastCombat)
			}
		})
	}
}

func TestRewindLimitAndJitter(t *testing.T) {
	m, a, b, input := historicalMatch(t, Sword, .3)
	m.Input(a.ID, input)
	m.Step()
	if a.LastCombat.Reason != "stale_view" || b.Health != 100 {
		t.Fatal("300 ms plus interpolation exceeded the cap")
	}
	m, a, b, input = historicalMatch(t, Sword, .2)
	m.SetLatency(a.ID, .16, .02) // Smoothed RTT lags a recent 40 ms spike.
	m.Input(a.ID, input)
	m.Step()
	resolveSword(t, m, a)
	if b.Health != 65 {
		t.Fatalf("jitter within the budget rejected: %+v", a.LastCombat)
	}

	m, a, b = readyMatch(t)
	m.Input(a.ID, Input{Seq: 1, Attack: true})
	m.Step()
	resolveSword(t, m, a)
	if b.Health != 65 {
		t.Fatal("first probe must not prevent uncompensated combat")
	}
}

func TestHistoryInterpolatesActualSnapshotPair(t *testing.T) {
	m, a, b, input := historicalMatch(t, Sword, .175)
	// The displayed target turns across the -pi/pi boundary between snapshots.
	for i := range m.history {
		for j := range m.history[i].players {
			p := &m.history[i].players[j]
			if p.ID == b.ID {
				p.Blocking = true
				if m.history[i].tick <= input.View.From {
					p.Yaw = math.Pi - .1
				} else {
					p.Yaw = -math.Pi + .1
				}
			}
		}
	}
	q := queuedInput{Input: input, receivedTick: 240}
	targets, _, reason := m.attackView(a, q, &CombatDiagnostic{})
	if reason != "" {
		t.Fatal(reason)
	}
	for _, p := range targets {
		if p.ID == b.ID && (math.Abs(p.X) > 1e-8 || math.Abs(p.Yaw-math.Pi) > 1e-8) {
			t.Fatalf("wrong interpolation: %+v", p)
		}
	}
	m.Input(a.ID, input)
	m.Step()
	resolveSword(t, m, a)
	if b.Health != 82 || a.LastCombat.Part != "head" {
		t.Fatalf("historical block failed: %+v", a.LastCombat)
	}
}

func TestHistoryBoundedAndOldLifeInputRejected(t *testing.T) {
	m, a, _ := readyMatch(t)
	for n := 0; n < 500; n++ {
		m.Tick += 3
		m.Snapshot()
	}
	if len(m.history) > 12 || m.history[0].tick >= m.Tick-30 {
		t.Fatal("history lost boundary or grew without bound")
	}
	oldLife := a.Life
	m.respawn(a)
	if m.Input(a.ID, Input{Seq: 1, Life: oldLife, Forward: 1, Attack: true}) {
		t.Fatal("old life input accepted")
	}
	for _, tick := range []float64{math.NaN(), math.Inf(1), math.MaxFloat64, -math.MaxFloat64, 1 << 53} {
		if (Input{Seq: 1, View: &ViewTime{Tick: tick}}).Valid() {
			t.Fatal("unsafe view accepted")
		}
	}
}

func TestInputBurstsDoNotLeavePermanentLatency(t *testing.T) {
	m, a, _ := readyMatch(t)
	for seq := uint64(1); seq <= 8; seq++ {
		m.Input(a.ID, Input{Seq: seq, Forward: 1})
	}
	m.Step()
	if a.Ack != 7 || len(a.queue) != 1 || math.Abs(a.Z+m.World.Rules.WalkSpeed/60) > 1e-8 {
		t.Fatalf("burst caused backlog or extra movement: ack=%d queue=%d z=%v", a.Ack, len(a.queue), a.Z)
	}
	m.Input(a.ID, Input{Seq: 9, Forward: 1})
	m.Step()
	if a.Ack != 8 || len(a.queue) != 1 {
		t.Fatal("queue did not stay bounded")
	}
}

func TestCoalescingPreservesClicksJumpsAndAttackContext(t *testing.T) {
	m, a, b, _ := historicalMatch(t, Sword, .2)
	view := &ViewTime{Tick: 222, From: 222, To: 222}
	m.Input(a.ID, Input{Seq: 1})
	m.Input(a.ID, Input{Seq: 2, Attack: true, View: view, Yaw: 0})
	m.Input(a.ID, Input{Seq: 3, Jump: true, Yaw: math.Pi})
	m.Input(a.ID, Input{Seq: 4, Yaw: math.Pi})
	m.Input(a.ID, Input{Seq: 5, Yaw: math.Pi})
	m.Step()
	if a.Ack != 2 || a.LastAttackSeq != 2 || b.Health != 100 || a.swing == nil {
		t.Fatalf("isolated click lost its aim/time: %+v", a.LastCombat)
	}
	m.Step()
	if a.Ack != 3 || a.Y <= 0 {
		t.Fatal("jump edge was lost")
	}
	resolveSword(t, m, a)
	if b.Health != 30 || a.LastCombat.Part != "head" {
		t.Fatalf("committed swing lost original aim: %+v", a.LastCombat)
	}
}

func TestCoalescingPreservesFirstPredictedHeldAttack(t *testing.T) {
	m, a, b := readyMatch(t)
	for seq := uint64(1); seq <= 8; seq++ {
		m.Input(a.ID, Input{Seq: seq, Attack: true})
	}
	m.Step()
	if a.LastAttackSeq != 1 || b.Health != 100 || a.swing == nil || len(a.queue) > 2 {
		t.Fatal("first held attack changed identity")
	}
	m.Step()
	resolveSword(t, m, a)
	if b.Health != 65 {
		t.Fatal("held repeats bypassed cooldown")
	}
}
