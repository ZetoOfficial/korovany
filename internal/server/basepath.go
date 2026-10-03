package server

import (
	"fmt"
	"net/http"
	"regexp"
	"strings"
)

// WithBasePath mounts the whole application, including WebSockets, below a URL prefix.
func WithBasePath(base string, handler http.Handler) (http.Handler, error) {
	if !regexp.MustCompile(`^/([a-zA-Z0-9_-]+/)*$`).MatchString(base) {
		return nil, fmt.Errorf("base-path must start and end with / and contain plain path segments")
	}
	if base == "/" {
		return handler, nil
	}
	mux := http.NewServeMux()
	mux.HandleFunc(strings.TrimSuffix(base, "/"), func(w http.ResponseWriter, r *http.Request) {
		target := base
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, target, http.StatusPermanentRedirect)
	})
	mux.Handle(base, http.StripPrefix(strings.TrimSuffix(base, "/"), handler))
	return mux, nil
}
