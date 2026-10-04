package game

import (
	"math"
	"testing"
)

func TestDummyStartsSoloMatchAndRemainsIdle(t *testing.T) {
	m := NewMatch()
	human, _ := m.Add("Путник")
	m.Step()
	if m.Phase != "waiting" {
		t.Fatal("solo player should wait for an opponent")
	}
	dummy, err := m.AddDummy()
	if err != nil {
		t.Fatal(err)
	}
	spawn := dummy.Motion
	m.Step()
	if m.Phase != "countdown" {
		t.Fatal("dummy did not start the countdown")
	}
	if m.Input(dummy.ID, Input{Seq: 1, Forward: 1, Attack: true, Block: true}) || m.Resume(dummy.ID) {
		t.Fatal("dummy accepted a human input stream or session")
	}
	m.Disconnect(dummy.ID)
	for n := 0; n < 25*m.World.Rules.TickRate; n++ {
		m.Step()
	}
	if m.Phase != "playing" || m.Players[dummy.ID] == nil || !dummy.Connected || !dummy.Dummy {
		t.Fatal("dummy did not remain an active match participant")
	}
	if dummy.Motion != spawn || dummy.AttackTick != 0 || dummy.Ack != 0 || human.Health != 100 {
		t.Fatalf("dummy moved, blocked, or attacked: %+v", dummy)
	}
}

func TestDummyCombatAndFixedRespawn(t *testing.T) {
	for _, weapon := range []int{Sword, Bow} {
		name := map[int]string{Sword: "sword", Bow: "bow"}[weapon]
		t.Run(name, func(t *testing.T) {
			m := NewMatch()
			human, _ := m.Add("Путник")
			dummy, _ := m.AddDummy()
			for n := 0; n <= m.World.Rules.CountdownSeconds*m.World.Rules.TickRate; n++ {
				m.Step()
			}
			dummy.Yaw = math.Pi
			dummy.dummySpawn.Yaw = math.Pi
			spawn := dummy.Motion
			life := dummy.Life
			human.Motion = Motion{X: dummy.X, Z: dummy.Z + 2, Stamina: 100}
			damage, cooldown := m.World.Rules.AttackDamage, m.World.Rules.AttackTicks
			if weapon == Bow {
				damage, cooldown = m.World.Rules.BowDamage, m.World.Rules.BowTicks
				human.Pitch = -.22
			}
			for seq := uint64(1); seq <= 3; seq++ {
				if weapon == Bow {
					fireBow(t, m, human)
					finishFlight(t, m)
				} else {
					if !m.Input(human.ID, Input{Seq: human.lastSeq + 1, Weapon: weapon, Attack: true}) {
						t.Fatal("attack input rejected")
					}
					m.Step()
					resolveSword(t, m, human)
				}
				if seq == 1 && dummy.Health != 100-damage {
					t.Fatalf("dummy did not receive ordinary weapon damage: %+v", dummy)
				}
				if seq < 3 {
					for n := uint64(0); n < cooldown; n++ {
						m.Step()
					}
				}
			}
			if dummy.Health != 0 || dummy.Deaths != 1 || human.Kills != 1 {
				t.Fatal("dummy death was not scored")
			}
			for m.Tick+1 < dummy.RespawnTick {
				m.Step()
			}
			if dummy.Health != 0 {
				t.Fatal("dummy respawned early")
			}
			m.Step()
			if dummy.Health != 100 || dummy.Life != life+1 || dummy.Motion != spawn || dummy.ShieldTick <= m.Tick {
				t.Fatalf("dummy did not respawn at its fixed position with protection: %+v", dummy)
			}
			if weapon == Bow {
				fireBow(t, m, human)
				finishFlight(t, m)
			} else {
				m.Input(human.ID, Input{Seq: human.lastSeq + 1, Weapon: weapon, Attack: true})
				m.Step()
				resolveSword(t, m, human)
			}
			if dummy.Health != 100 || human.LastCombat.Reason != "shield" {
				t.Fatal("dummy spawn protection was bypassed")
			}
		})
	}
}

func TestDummyCapacityRemovalAndRoundReset(t *testing.T) {
	m := NewMatch()
	human, _ := m.Add("Путник")
	first, _ := m.AddDummy()
	first.Health = 0 // Dead dummies still reserve their fixed spawn.
	for len(m.Players) < m.World.Rules.MaxPlayers {
		dummy, err := m.AddDummy()
		if err != nil {
			t.Fatal(err)
		}
		if dummy.X == first.X && dummy.Z == first.Z {
			t.Fatal("new dummy reused a dead dummy's spawn")
		}
	}
	if _, err := m.AddDummy(); err == nil {
		t.Fatal("dummies exceeded room capacity")
	}
	if _, err := m.Add("Лишний"); err == nil {
		t.Fatal("human ignored slots occupied by dummies")
	}
	m.Step()
	spawn := first.Motion
	m.Phase = "finished"
	m.EndTick = m.Tick + 1
	human.Kills, first.Deaths = 10, 10
	m.Step()
	if m.Phase != "countdown" || human.Kills != 0 || first.Deaths != 0 || first.Motion != spawn {
		t.Fatal("next round did not reset scores and preserve dummy placement")
	}
	if removed := m.RemoveDummies(); removed != m.World.Rules.MaxPlayers-1 {
		t.Fatalf("removed %d dummies", removed)
	}
	m.Step()
	if m.Phase != "waiting" || m.EndTick != 0 || len(m.Players) != 1 || m.Players[human.ID] != human {
		t.Fatal("removing dummies damaged the human or left a solo round running")
	}
	if m.RemoveDummies() != 0 {
		t.Fatal("removing dummies twice was not a no-op")
	}
	if _, err := m.Add("Друг"); err != nil {
		t.Fatal("removed dummies did not free room slots")
	}
}
