package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBasePath(t *testing.T) {
	handler, err := WithBasePath("/korovany/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Path", r.URL.Path)
		w.Header().Set("X-Query", r.URL.RawQuery)
		w.WriteHeader(http.StatusOK)
	}))
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/health", "/ws/ABCDEF", "/arena/", "/assets/game.js"} {
		r := httptest.NewRecorder()
		handler.ServeHTTP(r, httptest.NewRequest("GET", "/korovany"+path+"?room=ABCDEF", nil))
		if r.Code != 200 || r.Header().Get("X-Path") != path || r.Header().Get("X-Query") != "room=ABCDEF" {
			t.Fatalf("path %s: %d %v", path, r.Code, r.Header())
		}
	}
	for _, path := range []string{"/", "/api/health", "/korovany-other/"} {
		r := httptest.NewRecorder()
		handler.ServeHTTP(r, httptest.NewRequest("GET", path, nil))
		if r.Code != 404 {
			t.Fatalf("unrelated path %s served: %d", path, r.Code)
		}
	}
	r := httptest.NewRecorder()
	handler.ServeHTTP(r, httptest.NewRequest("GET", "/korovany?room=ABCDEF", nil))
	if r.Code != 308 || r.Header().Get("Location") != "/korovany/?room=ABCDEF" {
		t.Fatalf("missing slash redirect: %d %v", r.Code, r.Header())
	}
}

func TestInvalidBasePath(t *testing.T) {
	for _, base := range []string{"", "korovany/", "/korovany", "//", "/../", "/a?b/"} {
		if _, err := WithBasePath(base, http.NotFoundHandler()); err == nil {
			t.Errorf("accepted invalid base %q", base)
		}
	}
}
