package game

import "testing"

func TestSeppukuForfeitsRoundAndCancelsCombat(t *testing.T) {
	m, a, b := readyMatch(t)
	_, _ = m.Add("Третий")
	a.Kills = m.World.Rules.ScoreLimit // Surrender must override even a leading score.
	a.Blocking, a.BowDrawTicks = true, 60
	a.Y, a.VY, a.ImpulseX = 1, 2, 3
	a.swing = &swordSwing{}
	m.projectiles = []Projectile{{Actor: a.ID}, {Actor: b.ID}}
	m.Input(a.ID, Input{Seq: 1, Attack: true})
	start := m.Tick
	if !m.Seppuku(a.ID, a.Life) {
		t.Fatal("live player could not surrender")
	}
	if !a.Forfeited || a.SeppukuTick != start || a.Health != 0 || a.Deaths != 1 || a.RespawnTick != 0 {
		t.Fatalf("incorrect surrender result: %+v", a)
	}
	if a.Blocking || a.BowDrawTicks != 0 || a.swing != nil || len(a.queue) != 0 || a.Y != 0 || a.VY != 0 || a.ImpulseX != 0 {
		t.Fatal("surrender left movement or combat active")
	}
	if len(m.projectiles) != 1 || m.projectiles[0].Actor != b.ID || b.Kills != 0 {
		t.Fatal("surrender did not remove only the actor's projectiles, or awarded a kill")
	}
	// Avoid stepping an artificial projectile that has no flight diagnostic.
	m.projectiles = nil
	if m.Seppuku(a.ID, a.Life) || a.Deaths != 1 || len(m.events) != 1 || m.events[0].Type != "seppuku" {
		t.Fatal("duplicate surrender changed the result")
	}
	for i := 0; i < m.World.Rules.TickRate*5; i++ {
		m.Step()
	}
	if a.Health != 0 || !a.Forfeited || m.Phase != "playing" {
		t.Fatal("forfeited player respawned or ended a round with two contenders")
	}
	m.Input(a.ID, Input{Seq: 2, Forward: 1, Attack: true})
	m.Step()
	if a.Health != 0 || a.X != 0 || a.Z != 0 || b.Health != 100 {
		t.Fatal("a forfeited player could move or attack")
	}
}

func TestSeppukuEndsDuelAndResetsNextRound(t *testing.T) {
	m, a, b := readyMatch(t)
	a.Kills = 9
	if !m.Seppuku(a.ID, a.Life) {
		t.Fatal("surrender rejected")
	}
	m.Step()
	if m.Phase != "finished" || !a.Forfeited || b.Forfeited || b.Kills != 0 {
		t.Fatal("duel did not end with the remaining contender")
	}
	m.Disconnect(a.ID)
	if !m.Resume(a.ID) || !a.Forfeited || a.Health != 0 {
		t.Fatal("reconnect cleared the defeat")
	}
	oldLife := a.Life
	m.Tick = m.EndTick - 1
	m.Step()
	if m.Phase != "countdown" || a.Forfeited || a.SeppukuTick != 0 || a.Health != 100 || a.Deaths != 0 || a.Kills != 0 || a.Life == oldLife {
		t.Fatal("next round failed to reset the surrendered player")
	}
	m.Tick = m.EndTick - 1
	m.Step()
	if m.Seppuku(a.ID, oldLife) || a.Health != 100 {
		t.Fatal("a delayed confirmation surrendered a new life")
	}
}

func TestSeppukuRejectsInvalidStates(t *testing.T) {
	for _, kind := range []string{"waiting", "countdown", "finished", "dead", "dummy", "disconnected", "unknown", "wrong_life", "zero_life"} {
		t.Run(kind, func(t *testing.T) {
			m, a, _ := readyMatch(t)
			id, life := a.ID, a.Life
			switch kind {
			case "waiting", "countdown", "finished":
				m.Phase = kind
			case "dead":
				a.Health = 0
			case "dummy":
				a.Dummy = true
			case "disconnected":
				m.Disconnect(a.ID)
			case "unknown":
				id = "unknown"
			case "wrong_life":
				life++
			case "zero_life":
				life = 0
			}
			if m.Seppuku(id, life) || a.Forfeited || a.Deaths != 0 || len(m.events) != 0 {
				t.Fatal("invalid surrender changed match state")
			}
		})
	}
}

func TestSeppukuPersistsWhenRoomBecomesEmptyOfOpponents(t *testing.T) {
	m, a, b := readyMatch(t)
	m.Seppuku(a.ID, a.Life)
	delete(m.Players, b.ID)
	for i := 0; i < m.World.Rules.TickRate*5; i++ {
		m.Step()
	}
	if m.Phase != "waiting" || a.Health != 0 || !a.Forfeited {
		t.Fatal("waiting phase revived a surrendered player")
	}
	_, _ = m.Add("Новый соперник")
	m.Step()
	if m.Phase != "countdown" || a.Forfeited || a.Health != 100 {
		t.Fatal("new round did not restore the surrendered player")
	}
}
