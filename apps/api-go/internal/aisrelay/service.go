package aisrelay

import (
	"context"
	"net/http"
	"time"
)

// Relay is the AIS relay service: the aggregation state, the upstream client and the
// HTTP surface, plus the background workers that keep them current.
type Relay struct {
	cfg      Config
	engine   *engine
	upstream *upstreamClient
}

// New builds a relay from a resolved configuration.
func New(cfg Config) *Relay {
	return newRelayWithClock(cfg, nil)
}

// newRelayWithClock builds a relay with an injectable aggregation clock so tests can
// drive the density window, the health thresholds and the snapshot cache without
// sleeping.
func newRelayWithClock(cfg Config, now func() time.Time) *Relay {
	engine := newEngine(cfg, now)
	relay := &Relay{cfg: cfg, engine: engine}
	relay.upstream = newUpstreamClient(engine, cfg)
	return relay
}

// Handler returns the HTTP handler serving the relay endpoints.
func (r *Relay) Handler() http.Handler {
	return r
}

// Start launches the background workers and returns immediately. They run until ctx is
// cancelled: the drain loop that folds queued upstream payloads into the aggregates, the
// upstream supervisor that owns the connection lifecycle, and the ticker that refreshes
// the snapshot cache.
func (r *Relay) Start(ctx context.Context) {
	go r.engine.runDrainLoop(ctx)
	r.upstream.start(ctx)
	go r.runSnapshotTicker(ctx)
}

// runSnapshotTicker refreshes the snapshot on the configured cadence, mirroring the Node
// setInterval: it only rebuilds while the stream is live or vessels are retained, so an
// idle relay does no work.
func (r *Relay) runSnapshotTicker(ctx context.Context) {
	ticker := time.NewTicker(r.cfg.SnapshotCacheTTL)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.engine.refreshSnapshotOnTick()
		}
	}
}

// refreshSnapshotOnTick rebuilds the cached snapshot when there is something to report.
func (e *engine) refreshSnapshotOnTick() {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.state == connOpen || e.vessels.Len() > 0 {
		e.buildSnapshotLocked()
	}
}
