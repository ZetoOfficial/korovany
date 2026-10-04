package server

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ZetoOfficial/korovany/internal/game"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type testClient struct {
	conn      *websocket.Conn
	id, token string
	snapshots chan game.Snapshot
}

func testServer(t *testing.T) *httptest.Server {
	t.Helper()
	s := New(nil)
	h := httptest.NewServer(s.Handler(t.TempDir()))
	t.Cleanup(func() { s.Close(); h.Close() })
	return h
}

func create(t *testing.T, h *httptest.Server) string {
	t.Helper()
	response, err := http.Post(h.URL+"/api/rooms", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 201 {
		t.Fatalf("create: %v", response.Status)
	}
	var body struct{ Room string }
	if err = json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body.Room
}

func dial(t *testing.T, h *httptest.Server, room, name, token string) *testClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, strings.Replace(h.URL, "http", "ws", 1)+"/ws/"+room, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	if err = wsjson.Write(ctx, conn, envelope{Type: "hello", Version: ProtocolVersion, MapVersion: game.LoadWorld().Version, Name: name, Token: token}); err != nil {
		t.Fatal(err)
	}
	var welcome struct {
		Type, ID, Token string
		Snapshot        game.Snapshot
	}
	if err = wsjson.Read(ctx, conn, &welcome); err != nil {
		t.Fatal(err)
	}
	if welcome.Type != "welcome" || welcome.ID == "" || welcome.Token == "" {
		t.Fatalf("bad welcome: %+v", welcome)
	}
	c := &testClient{conn: conn, id: welcome.ID, token: welcome.Token, snapshots: make(chan game.Snapshot, 128)}
	c.snapshots <- welcome.Snapshot
	go func() {
		defer close(c.snapshots)
		for {
			var message struct {
				game.Snapshot
				Probe string `json:"probe"`
			}
			if err := wsjson.Read(context.Background(), conn, &message); err != nil {
				return
			}
			if message.Type == "probe" {
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				err := wsjson.Write(ctx, conn, envelope{Type: "probe_ack", Probe: message.Probe})
				cancel()
				if err != nil {
					return
				}
				continue
			}
			s := message.Snapshot
			if s.Type != "snapshot" {
				continue
			}
			select {
			case c.snapshots <- s:
			default:
			}
		}
	}()
	return c
}

func TestServerMeasurementEnablesViewValidation(t *testing.T) {
	h := testServer(t)
	room := create(t, h)
	a := dial(t, h, room, "Атакующий", "")
	dial(t, h, room, "Цель", "")
	s := a.until(t, func(s game.Snapshot) bool { return s.Phase == "playing" })
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	err := wsjson.Write(ctx, a.conn, envelope{Type: "input", Input: game.Input{Seq: 1, Life: state(s, a.id).Life, Attack: true, Forward: 1}})
	if err != nil {
		t.Fatal(err)
	}
	s = a.until(t, func(s game.Snapshot) bool { return state(s, a.id).Ack == 1 })
	p := state(s, a.id)
	if p.LastCombat == nil || p.LastCombat.Reason != "missing_view" || p.LastAttackSeq != 0 {
		t.Fatalf("server probe was not measured or invalid attack accepted: %+v", p)
	}
}

func (c *testClient) until(t *testing.T, accept func(game.Snapshot) bool) game.Snapshot {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case s, ok := <-c.snapshots:
			if !ok {
				t.Fatal("connection closed while waiting for snapshot")
			}
			if accept(s) {
				return s
			}
		case <-timer.C:
			t.Fatal("snapshot condition timed out")
		}
	}
}

func state(s game.Snapshot, id string) game.Player {
	for _, p := range s.Players {
		if p.ID == id {
			return p
		}
	}
	return game.Player{}
}

func TestTwoClientsAgreeAndReconnect(t *testing.T) {
	h := testServer(t)
	room := create(t, h)
	a := dial(t, h, room, "Эльф", "")
	b := dial(t, h, room, "Страж", "")
	before := a.until(t, func(s game.Snapshot) bool { return s.Phase == "playing" && len(s.Players) == 2 })
	start := state(before, a.id)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, a.conn, envelope{Type: "input", Input: game.Input{Seq: 1, Forward: 1, Yaw: 0}}); err != nil {
		t.Fatal(err)
	}
	after := a.until(t, func(s game.Snapshot) bool { return state(s, a.id).Ack == 1 })
	other := b.until(t, func(s game.Snapshot) bool { return s.Tick == after.Tick })
	p, q := state(after, a.id), state(other, a.id)
	if p.X != q.X || p.Z != q.Z || p.Health != q.Health {
		t.Fatal("clients received different authoritative state")
	}
	if math.Abs(p.Z-start.Z+game.LoadWorld().Rules.WalkSpeed/60) > 1e-8 {
		t.Fatalf("server did not apply exactly one step: %v -> %v", start.Z, p.Z)
	}
	_ = a.conn.CloseNow()
	b.until(t, func(s game.Snapshot) bool { return !state(s, a.id).Connected })
	resumed := dial(t, h, room, "Эльф", a.token)
	if resumed.id != a.id {
		t.Fatal("reconnect created a new player")
	}
	rejoined := resumed.until(t, func(s game.Snapshot) bool { return state(s, a.id).Connected })
	if state(rejoined, a.id).Z != p.Z || state(rejoined, a.id).Ack != 0 {
		t.Fatal("reconnect lost position or input sequence")
	}
	// A different room cannot see the two players above.
	isolated := dial(t, h, create(t, h), "Другой", "")
	isolation := isolated.until(t, func(s game.Snapshot) bool { return len(s.Players) > 0 })
	if len(isolation.Players) != 1 || isolation.Players[0].Name != "Другой" {
		t.Fatal("room state leaked")
	}
}

func TestOriginAndProtocolValidation(t *testing.T) {
	h := testServer(t)
	request, _ := http.NewRequest(http.MethodPost, h.URL+"/api/rooms", nil)
	request.Header.Set("Origin", "https://unrelated.example")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatal("cross-origin room creation was allowed")
	}
	room := create(t, h)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, strings.Replace(h.URL, "http", "ws", 1)+"/ws/"+room, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	_ = wsjson.Write(ctx, conn, envelope{Type: "hello", Version: 999, MapVersion: game.LoadWorld().Version, Name: "Боец"})
	_, _, err = conn.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("wrong version accepted: %v", err)
	}
	if _, err := decode([]byte(`{"type":"input","input":{"seq":1,"x":100}}`)); err == nil {
		t.Fatal("client-supplied position accepted")
	}
	if _, err := decode([]byte(`{"type":"ping"} {"type":"ping"}`)); err == nil {
		t.Fatal("trailing payload accepted")
	}
}
