package server

import (
	"math"
	"sync"
	"time"
)

// The reader acknowledges challenges issued by the sole websocket writer.
// A client-supplied duration is never used as a latency measurement.
type latencyProbe struct {
	mu          sync.Mutex
	id          string
	sent        time.Time
	ready       bool
	rtt, jitter float64
}

func (p *latencyProbe) issue(now time.Time) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.id, p.sent = randomToken(), now
	return p.id
}

func (p *latencyProbe) acknowledge(id string, now time.Time) (float64, float64, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if id == "" || id != p.id {
		return 0, 0, false
	}
	p.id = "" // A response cannot be replayed to inflate the RTT.
	sample := now.Sub(p.sent).Seconds()
	if sample < 0 || sample > 5 {
		return 0, 0, false
	}
	if !p.ready {
		p.rtt, p.ready = sample, true
	} else {
		p.jitter += (math.Abs(sample-p.rtt) - p.jitter) * 0.25
		p.rtt += (sample - p.rtt) * 0.125
	}
	return p.rtt, p.jitter, true
}
