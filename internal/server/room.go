package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/ZetoOfficial/korovany/internal/game"
)

// A peer carries protocol bytes; the room does not depend on WebSocket.
// A WebRTC adapter can use the same command queue and authoritative simulation.
type peer struct {
	id   string
	out  chan []byte
	done chan struct{}
	once sync.Once
}

func newPeer() *peer  { return &peer{out: make(chan []byte, 16), done: make(chan struct{})} }
func (p *peer) stop() { p.once.Do(func() { close(p.done) }) }
func (p *peer) send(message any) {
	data, err := json.Marshal(message)
	if err != nil {
		p.stop()
		return
	}
	select {
	case <-p.done:
	case p.out <- data:
	default:
		p.stop() // A slow receiver never stalls the match.
	}
}

type operation struct {
	kind        string
	peer        *peer
	name, token string
	input       game.Input
	receivedAt  time.Time
	rtt, jitter float64
	reply       chan error
}

type room struct {
	code   string
	ops    chan operation
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
}

func randomToken() string {
	var bytes [24]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(bytes[:])
}

func (r *room) submit(op operation) bool {
	select {
	case <-r.ctx.Done():
		return false
	case r.ops <- op:
		return true
	default:
		return false
	}
}

func (r *room) run(remove func()) {
	defer close(r.done)
	defer remove()
	defer r.cancel()
	m := game.NewMatch()
	peers := map[string]*peer{}
	sessions := map[string]string{}
	defer func() {
		for _, p := range peers {
			p.stop()
		}
	}()
	step := time.Second / time.Duration(m.World.Rules.TickRate)
	ticker := time.NewTicker(step)
	defer ticker.Stop()
	last, emptySince := time.Now(), time.Now()
	var accumulator time.Duration
	for {
		select {
		case <-r.ctx.Done():
			return
		case op := <-r.ops:
			switch op.kind {
			case "join":
				var id string
				token := op.token
				if token != "" {
					id = sessions[token]
					if !m.Resume(id) {
						op.reply <- errors.New("Сессия истекла или уже открыта в другой вкладке.")
						continue
					}
				} else {
					p, err := m.Add(op.name)
					if err != nil {
						op.reply <- err
						continue
					}
					id = p.ID
					token = randomToken()
					sessions[token] = id
				}
				op.peer.id = id
				peers[id] = op.peer
				op.peer.send(struct {
					Type       string        `json:"type"`
					ID         string        `json:"id"`
					Token      string        `json:"token"`
					Room       string        `json:"room"`
					MapVersion string        `json:"mapVersion"`
					Snapshot   game.Snapshot `json:"snapshot"`
				}{"welcome", id, token, r.code, m.World.Version, m.Snapshot()})
				op.reply <- nil
			case "leave":
				if peers[op.peer.id] == op.peer {
					m.Disconnect(op.peer.id)
					delete(peers, op.peer.id)
				}
			case "input":
				if peers[op.peer.id] == op.peer {
					m.InputDelayed(op.peer.id, op.input, time.Since(op.receivedAt).Seconds())
				}
			case "add_dummy", "remove_dummies":
				if peers[op.peer.id] != op.peer {
					continue
				}
				var message string
				if op.kind == "add_dummy" {
					p, err := m.AddDummy()
					if err != nil {
						message = err.Error()
					} else {
						message = p.Name + " добавлен на арену."
					}
				} else {
					message = fmt.Sprintf("Манекенов убрано: %d.", m.RemoveDummies())
				}
				op.peer.send(map[string]string{"type": "dummy_result", "message": message})
			case "latency":
				if peers[op.peer.id] == op.peer {
					m.SetLatency(op.peer.id, op.rtt, op.jitter)
				}
			}
		case now := <-ticker.C:
			accumulator += now.Sub(last)
			last = now
			if accumulator > 5*step {
				accumulator = 5 * step
			}
			broadcast := false
			for accumulator >= step {
				m.Step()
				accumulator -= step
				if m.Tick%uint64(m.World.Rules.TickRate/m.World.Rules.SnapshotRate) == 0 {
					broadcast = true
				}
			}
			for id, p := range peers {
				select {
				case <-p.done:
					m.Disconnect(id)
					delete(peers, id)
				default:
				}
			}
			for token, id := range sessions {
				if m.Players[id] == nil {
					delete(sessions, token)
				}
			}
			if broadcast {
				snapshot := m.Snapshot()
				for _, p := range peers {
					p.send(snapshot)
				}
			}
			if len(peers) > 0 {
				emptySince = now
			} else if now.Sub(emptySince) > 30*time.Second {
				return
			}
		}
	}
}
