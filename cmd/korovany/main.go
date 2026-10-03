package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/ZetoOfficial/korovany/internal/server"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "HTTP listen address; use :8080 for LAN")
	assets := flag.String("assets", "dist", "built client directory")
	basePath := flag.String("base-path", "/", "public URL prefix, matching the client's Vite base")
	origin := flag.String("origin", "", "additional allowed browser origin host, e.g. localhost:5173")
	flag.Parse()
	if _, err := os.Stat(*assets + "/index.html"); err != nil {
		log.Printf("Client not built yet; run npm ci && npm run build, or use npm run dev.")
	}
	var origins []string
	if *origin != "" {
		origins = strings.Split(*origin, ",")
	}
	app := server.New(origins)
	handler, err := server.WithBasePath(*basePath, app.Handler(*assets))
	if err != nil {
		log.Fatal(err)
	}
	httpServer := &http.Server{Addr: *addr, Handler: handler, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		app.Close()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
	}()
	log.Printf("Korovany: http://%s%s · revision: %s", *addr, *basePath, server.BuildRevision)
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
