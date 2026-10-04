package server

import (
	"testing"
	"time"
)

func TestLatencyProbeRequiresUniqueServerChallenge(t *testing.T) {
	p := &latencyProbe{}
	now := time.Now()
	id := p.issue(now)
	if _, _, ok := p.acknowledge("invented", now.Add(time.Second)); ok {
		t.Fatal("forged probe accepted")
	}
	rtt, jitter, ok := p.acknowledge(id, now.Add(200*time.Millisecond))
	if !ok || rtt != .2 || jitter != 0 {
		t.Fatalf("bad measurement: %v %v %v", rtt, jitter, ok)
	}
	if _, _, ok := p.acknowledge(id, now.Add(time.Second)); ok {
		t.Fatal("replayed probe accepted")
	}
	id = p.issue(now)
	newID := p.issue(now.Add(time.Second))
	if _, _, ok := p.acknowledge(id, now.Add(2*time.Second)); ok {
		t.Fatal("superseded probe accepted")
	}
	rtt, jitter, ok = p.acknowledge(newID, now.Add(1240*time.Millisecond))
	if !ok || rtt <= .2 || rtt >= .24 || jitter <= 0 {
		t.Fatal("RTT and jitter were not smoothed")
	}
	id = p.issue(now)
	if _, _, ok := p.acknowledge(id, now.Add(6*time.Second)); ok {
		t.Fatal("expired probe accepted")
	}
}
