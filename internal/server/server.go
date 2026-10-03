package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/ZetoOfficial/korovany/internal/game"
	"github.com/coder/websocket"
)

const ProtocolVersion = 1

// BuildRevision is set by the release build to identify the running artifact.
var BuildRevision = "dev"

type Server struct {
	mu      sync.Mutex
	rooms   map[string]*room
	ctx     context.Context
	cancel  context.CancelFunc
	origins []string
}

func New(origins []string) *Server {
	ctx, cancel := context.WithCancel(context.Background())
	return &Server{rooms: map[string]*room{}, ctx: ctx, cancel: cancel, origins: origins}
}

func (s *Server) Close() {
	s.cancel()
	s.mu.Lock()
	rooms := make([]*room, 0, len(s.rooms))
	for _, r := range s.rooms {
		rooms = append(rooms, r)
	}
	s.mu.Unlock()
	for _, r := range rooms {
		<-r.done
	}
}

func (s *Server) Handler(assets string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "protocol": ProtocolVersion, "mapVersion": game.LoadWorld().Version, "revision": BuildRevision})
	})
	mux.HandleFunc("POST /api/rooms", s.createRoom)
	mux.HandleFunc("GET /ws/{room}", s.connect)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	mux.Handle("/", http.FileServer(http.Dir(assets)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		mux.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func (s *Server) sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	if strings.EqualFold(u.Host, r.Host) {
		return true
	}
	for _, host := range s.origins {
		if strings.EqualFold(u.Host, host) {
			return true
		}
	}
	return false
}

func (s *Server) createRoom(w http.ResponseWriter, r *http.Request) {
	if !s.sameOrigin(r) {
		http.Error(w, "Недопустимый источник запроса.", http.StatusForbidden)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ctx.Err() != nil || len(s.rooms) >= 64 {
		http.Error(w, "Сервер занят. Попробуйте позже.", http.StatusServiceUnavailable)
		return
	}
	var code string
	for {
		var b [3]byte
		if _, err := rand.Read(b[:]); err != nil {
			http.Error(w, "Не удалось создать комнату.", 500)
			return
		}
		code = strings.ToUpper(hex.EncodeToString(b[:]))
		if s.rooms[code] == nil {
			break
		}
	}
	ctx, cancel := context.WithCancel(s.ctx)
	room := &room{code: code, ops: make(chan operation, 256), ctx: ctx, cancel: cancel, done: make(chan struct{})}
	s.rooms[code] = room
	go room.run(func() { s.mu.Lock(); delete(s.rooms, code); s.mu.Unlock() })
	writeJSON(w, http.StatusCreated, map[string]string{"room": code})
}

type envelope struct {
	Type       string     `json:"type"`
	Version    int        `json:"version,omitempty"`
	MapVersion string     `json:"mapVersion,omitempty"`
	Name       string     `json:"name,omitempty"`
	Token      string     `json:"token,omitempty"`
	Input      game.Input `json:"input,omitempty"`
	Time       float64    `json:"time,omitempty"`
}

func decode(data []byte) (envelope, error) {
	var e envelope
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(&e); err != nil {
		return e, err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return e, errors.New("trailing data")
	}
	return e, nil
}

func validName(name string) bool {
	if !utf8.ValidString(name) || utf8.RuneCountInString(name) < 1 || utf8.RuneCountInString(name) > 24 {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func (s *Server) connect(w http.ResponseWriter, r *http.Request) {
	if !s.sameOrigin(r) {
		http.Error(w, "Недопустимый источник запроса.", http.StatusForbidden)
		return
	}
	s.mu.Lock()
	room := s.rooms[strings.ToUpper(r.PathValue("room"))]
	s.mu.Unlock()
	if room == nil {
		http.Error(w, "Комната не найдена.", http.StatusNotFound)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: s.origins})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(2048)
	ctx, cancel := context.WithCancel(room.ctx)
	defer cancel()
	helloCtx, helloCancel := context.WithTimeout(ctx, 5*time.Second)
	_, data, err := conn.Read(helloCtx)
	helloCancel()
	if err != nil {
		return
	}
	hello, err := decode(data)
	hello.Name = strings.TrimSpace(hello.Name)
	if err != nil || hello.Type != "hello" || hello.Version != ProtocolVersion || hello.MapVersion != game.LoadWorld().Version || !validName(hello.Name) || len(hello.Token) > 48 {
		_ = conn.Close(websocket.StatusPolicyViolation, "Версия игры или имя не подходит. Обновите страницу.")
		return
	}
	p := newPeer()
	defer p.stop()
	joined := make(chan error, 1)
	if !room.submit(operation{kind: "join", peer: p, name: hello.Name, token: hello.Token, reply: joined}) {
		return
	}
	select {
	case <-ctx.Done():
		return
	case err = <-joined:
	}
	if err != nil {
		_ = conn.Close(websocket.StatusPolicyViolation, err.Error())
		return
	}
	defer room.submit(operation{kind: "leave", peer: p})
	go func() {
		defer cancel()
		for {
			select {
			case <-ctx.Done():
				return
			case <-p.done:
				return
			case payload := <-p.out:
				writeCtx, done := context.WithTimeout(ctx, 3*time.Second)
				err := conn.Write(writeCtx, websocket.MessageText, payload)
				done()
				if err != nil {
					return
				}
			}
		}
	}()
	window, count := time.Now(), 0
	for {
		readCtx, done := context.WithTimeout(ctx, 15*time.Second)
		_, data, err := conn.Read(readCtx)
		done()
		if err != nil {
			return
		}
		if time.Since(window) > time.Second {
			window = time.Now()
			count = 0
		}
		count++
		if count > 120 {
			_ = conn.Close(websocket.StatusPolicyViolation, "Слишком много сообщений.")
			return
		}
		e, err := decode(data)
		if err != nil {
			_ = conn.Close(websocket.StatusPolicyViolation, "Некорректное сообщение.")
			return
		}
		switch e.Type {
		case "input":
			if !e.Input.Valid() {
				_ = conn.Close(websocket.StatusPolicyViolation, "Некорректное управление.")
				return
			}
			if !room.submit(operation{kind: "input", peer: p, input: e.Input}) {
				return
			}
		case "ping":
			p.send(map[string]any{"type": "pong", "time": e.Time})
		default:
			_ = conn.Close(websocket.StatusPolicyViolation, "Неизвестное сообщение.")
			return
		}
	}
}
