package dashboardstream

import (
	"context"
	"strconv"
	"sync"
	"time"
)

// sharedReads collapses the per-connection polling of this SSE endpoint into one
// read per parameter set per tick.
//
// NestJS recomputes the war map, the candlestick and the geo heatmap for every
// subscriber on every interval (dashboard.controller.ts publish()), so N open
// dashboards for one org issue 3N query batches per tick even when they ask for
// exactly the same range and view. Nothing in the response depends on the
// connection, so the first connection to reach a tick publishes its result and
// the connections polling in the same tick reuse it.
//
// Freshness: entries are scoped to the wall-clock bucket floor(now/interval).
// A connection's ticker fires at least interval apart, so a single connection
// never reuses its own previous result — every connection still observes data
// read inside its own interval, exactly like the per-connection workers. Only
// connections that tick inside the same bucket share one read.
//
// Lifecycle: there is no per-group goroutine and no timer, so nothing outlives
// the connections that created it. An entry is collected on the first tick after
// it stops being current, and the read itself runs under a bounded context so a
// connection that goes away mid-read cannot pin the query forever. Waiters block
// on the entry, not on the other connection, and give up as soon as their own
// request context is done.
type sharedReads[T any] struct {
	mu      sync.Mutex
	entries map[string]*sharedRead[T]
	timeout time.Duration
}

type sharedRead[T any] struct {
	value  T
	err    error
	bucket int64
	ready  chan struct{}
}

func newSharedReads[T any](timeout time.Duration) *sharedReads[T] {
	return &sharedReads[T]{entries: map[string]*sharedRead[T]{}, timeout: timeout}
}

// do returns the result for key in bucket, computing it at most once. Concurrent
// callers for the same key and bucket wait for that single computation. The
// bucket is part of the map key, so a stale entry from an earlier tick is never
// served as a fresh result.
func (c *sharedReads[T]) do(ctx context.Context, key string, bucket int64, compute func(context.Context) (T, error)) (T, error) {
	if err := ctx.Err(); err != nil {
		// The connection already gave up; do not start shared work for it.
		var zero T
		return zero, err
	}
	mapKey := strconv.FormatInt(bucket, 10) + "#" + key
	c.mu.Lock()
	c.prune(bucket)
	if entry, ok := c.entries[mapKey]; ok {
		c.mu.Unlock()
		select {
		case <-entry.ready:
			return entry.value, entry.err
		case <-ctx.Done():
			var zero T
			return zero, ctx.Err()
		}
	}
	entry := &sharedRead[T]{bucket: bucket, ready: make(chan struct{})}
	c.entries[mapKey] = entry
	c.mu.Unlock()

	// Detach the shared read from the connection that happened to start it:
	// another connection waiting on the same entry must not inherit its
	// disconnect. The timeout keeps the detached work bounded.
	readCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), c.timeout)
	defer cancel()
	value, err := compute(readCtx)
	entry.value, entry.err = value, err
	close(entry.ready)
	return value, err
}

// prune drops finished entries older than the previous bucket. Entries still
// computing are kept: their waiters hold the pointer, and dropping them early
// would let a second caller start a duplicate read.
func (c *sharedReads[T]) prune(current int64) {
	for key, entry := range c.entries {
		if entry.bucket >= current-1 {
			continue
		}
		select {
		case <-entry.ready:
			delete(c.entries, key)
		default:
		}
	}
}

// size reports how many entries are retained; tests use it to prove the cache
// does not grow with the number of connections.
func (c *sharedReads[T]) size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}
