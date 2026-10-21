// Package queueorgstats is the api-go owner of the per-organization itemPipeline
// job counters, the Go counterpart of the NestJS QueueOrgStatsTracker and
// QueueOrgStatsService.
//
// The counters live in Redis next to the BullMQ queue: every job has a
// `queue:itemPipeline:job:<jobId>:meta` hash with its organization and last
// recorded state, and every organization has a
// `queue:itemPipeline:org:<orgId>:counts` hash with one field per tracked state.
// Three Lua scripts (see scripts.go) keep both consistent in one atomic step. The
// readers (apps/api/src/modules/queue/queue.service.ts,
// internal/dashboardstats/counts.go, internal/graphqlread/workspace/queue.go) are
// unchanged: this package writes exactly the layout QueueOrgStatsService writes.
//
// # Single owner
//
// The NestJS tracker registers six QueueEvents listeners on every API instance,
// so N instances apply every itemPipeline event N times. This tracker is a
// single-owner reader instead: it consumes the `bull:itemPipeline:events` stream
// only while it holds the `lock:queue:itemPipeline:orgstats` Redis lease
// (cronlock.WithRenewableLock, TTL 30s, renewed every TTL/3). The lease loss
// cancels the read loop, the tracker releases the lease and competes again. A
// process that does not own the lease reads no event and writes no counter.
//
// The stream is read with XREAD from `$`, so only events published after the
// lease was acquired are applied, exactly like a QueueEvents instance created at
// that moment. Taking the ownership over therefore skips the events published
// while another owner (or no owner) held it; the alternative, replaying the
// stream, would apply the same transition twice and drift the counters the same
// way the multi-instance NestJS tracker does.
package queueorgstats

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmqwire"
	"github.com/wei500L/newwei/apps/api-go/internal/cronlock"
)

// Ownership and stream constants.
const (
	// lockName is the logical lease name; cronlock writes the physical key
	// `lock:queue:itemPipeline:orgstats`.
	lockName = "queue:itemPipeline:orgstats"
	// lockTTL is the single-owner lease TTL. cronlock renews it every TTL/3
	// (10s) and cancels the runner as soon as the lease can no longer be
	// extended.
	lockTTL = 30 * time.Second

	// streamStartID is `$`: the first XREAD of every ownership starts at the
	// current end of the stream, so historical events are not replayed.
	streamStartID = "$"
	// streamReadCount is the XREAD COUNT. BullMQ's QueueEvents uses the same
	// order of magnitude; the exact value does not change the applied order.
	streamReadCount = 100
	// streamReadBlock is the XREAD BLOCK. It bounds how long Close waits for the
	// read loop and how quickly a lost lease stops the loop.
	streamReadBlock = 5 * time.Second

	// readErrorDelay is the pause after a failed XREAD before retrying.
	readErrorDelay = 200 * time.Millisecond
	// ownershipRetryDelay is the pause before competing for the lease again
	// after losing it, or after finding another owner.
	ownershipRetryDelay = 5 * time.Second
)

// Errors returned by Start.
var (
	// ErrNotConfigured is returned when the tracker has no store or lease.
	ErrNotConfigured = errors.New("queueorgstats: the tracker is not configured")
	// ErrClosed is returned by Start after Close.
	ErrClosed = errors.New("queueorgstats: the tracker is closed")
)

// Lease is the cronlock surface used for single ownership. *cronlock.Lock
// implements it; the runner context is cancelled when the lease is lost.
type Lease interface {
	WithRenewableLock(ctx context.Context, key string, ttl time.Duration, runner func(context.Context) error) (acquired bool, err error)
}

// Options wires the production tracker.
type Options struct {
	// Redis is the shared command client: the lease, the meta reads and the
	// three scripts run on it.
	Redis *redis.Client
	// BlockingOptions is the connection configuration of the dedicated XREAD
	// client. It must describe a separate connection: a client parked in
	// XREAD BLOCK cannot run the lease or the scripts.
	BlockingOptions *redis.Options
	// Logger receives the failure messages. A nil logger uses log.Default.
	Logger *log.Logger
	// Debug enables the messages the NestJS tracker writes with logger.debug
	// (a skipped job without organization context).
	Debug bool
}

// Tracker keeps the per-organization itemPipeline counters up to date.
type Tracker struct {
	store  Store
	lease  Lease
	logger *log.Logger
	debug  bool

	// retryDelay is how long the loop waits before competing for the lease
	// again; readRetryDelay is the pause after a failed XREAD.
	retryDelay     time.Duration
	readRetryDelay time.Duration

	mu     sync.Mutex
	cancel context.CancelFunc
	closed bool
	wg     sync.WaitGroup
}

// New builds the production tracker over the shared Redis client and a dedicated
// blocking connection. It performs no I/O: the lease is acquired by Start.
func New(opts Options) (*Tracker, error) {
	if opts.Redis == nil {
		return nil, ErrNoRedis
	}
	if opts.BlockingOptions == nil {
		return nil, ErrNoBlockingOptions
	}
	store := newRedisStore(opts.Redis, redis.NewClient(opts.BlockingOptions))
	return newTracker(store, cronlock.New(opts.Redis), opts.Logger, opts.Debug), nil
}

// newTracker builds a tracker over explicit dependencies; the tests use it to
// substitute the store and the lease.
func newTracker(store Store, lease Lease, logger *log.Logger, debug bool) *Tracker {
	if logger == nil {
		logger = log.Default()
	}
	return &Tracker{
		store:          store,
		lease:          lease,
		logger:         logger,
		debug:          debug,
		retryDelay:     ownershipRetryDelay,
		readRetryDelay: readErrorDelay,
	}
}

// Start launches the ownership loop. It returns immediately; the loop keeps
// competing for the lease and reading the event stream until Close or the parent
// context ends. Starting an already started tracker is a no-op; starting a
// closed one is an error.
func (t *Tracker) Start(ctx context.Context) error {
	if t == nil || t.store == nil || t.lease == nil {
		return ErrNotConfigured
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return ErrClosed
	}
	if t.cancel != nil {
		return nil
	}
	runCtx, cancel := context.WithCancel(ctx)
	t.cancel = cancel
	t.wg.Add(1)
	go func() {
		defer t.wg.Done()
		t.run(runCtx)
	}()
	return nil
}

// Close stops the ownership loop and closes the blocking connection. It waits
// for the loop to return or for ctx to end, whichever comes first. Close is
// idempotent, so a shutdown path may call it after an explicit stop.
func (t *Tracker) Close(ctx context.Context) error {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return nil
	}
	t.closed = true
	cancel := t.cancel
	t.cancel = nil
	t.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	done := make(chan struct{})
	go func() {
		t.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
	if t.store == nil {
		return nil
	}
	return t.store.Close()
}

// run competes for the lease until the context ends. Losing the lease is not an
// error: the loop releases it, waits and competes again.
func (t *Tracker) run(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		acquired, err := t.acquireAndRead(ctx)
		if ctx.Err() != nil {
			return
		}
		switch {
		case err != nil:
			t.logf("ownership cycle failed: %v", err)
		case !acquired:
			t.debugf("another instance holds the %s lease", lockName)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(t.retryDelay):
		}
	}
}

// acquireAndRead becomes the single owner and reads events while the lease is
// held. acquired is false when another process owns the lease; the store is then
// neither read nor written.
func (t *Tracker) acquireAndRead(ctx context.Context) (bool, error) {
	return t.lease.WithRenewableLock(ctx, lockName, lockTTL, func(runCtx context.Context) error {
		t.readEvents(runCtx)
		if runCtx.Err() != nil {
			t.logf("stopped reading the itemPipeline event stream (lease lost or shutdown)")
		}
		return nil
	})
}

// readEvents applies the itemPipeline events until the runner context ends. A
// failed read is logged and retried; a failed event is logged and skipped,
// exactly like the per-handler try/catch of the NestJS tracker.
func (t *Tracker) readEvents(ctx context.Context) {
	lastID := streamStartID
	for {
		if ctx.Err() != nil {
			return
		}
		events, err := t.store.ReadStream(ctx, lastID, streamReadCount, streamReadBlock)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			t.logf("read the itemPipeline event stream: %v", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(t.readRetryDelay):
			}
			continue
		}
		for _, event := range events {
			// Advance the cursor even for an ignored event so a reconnect
			// resumes after the last observed entry instead of replaying it.
			lastID = event.ID
			t.handleEvent(ctx, event)
		}
	}
}

// handleEvent applies one stream entry: the five state events transition the
// counters, `removed` takes the removal path, everything else is ignored.
func (t *Tracker) handleEvent(ctx context.Context, event StreamEvent) {
	if event.JobID == "" {
		return
	}
	if status, ok := statusForEvent(event.Event); ok {
		t.trackTransition(ctx, event.JobID, status)
		return
	}
	if event.Event == eventRemoved {
		t.trackRemoval(ctx, event.JobID)
	}
}

// trackTransition is QueueOrgStatsTracker.trackTransition
// (queue-org-stats.tracker.ts:57-84): a job with metadata is transitioned, a job
// without metadata is upserted from its job hash, and a job without an
// organization (or already removed) is skipped.
func (t *Tracker) trackTransition(ctx context.Context, jobID string, status JobStatus) {
	meta, found, err := t.store.GetJobMeta(ctx, jobID)
	if err != nil {
		t.logf("read meta of job %s for the %s transition: %v", jobID, status, err)
		return
	}
	if found {
		if err := t.transition(ctx, jobID, meta, status); err != nil {
			t.logf("transition job %s to %s: %v", jobID, status, err)
		}
		return
	}

	job, err := t.store.GetJob(ctx, jobID)
	if err != nil {
		t.logf("read job %s for the %s transition: %v", jobID, status, err)
		return
	}
	if job == nil {
		t.debugf("skipping job %s without job hash (status %s)", jobID, status)
		return
	}
	orgID := bullmqwire.OrgIDFromData(job.Data)
	if orgID == "" {
		t.debugf("skipping job %s without org context (status %s)", jobID, status)
		return
	}
	if err := t.store.UpsertJobMetaAndCount(ctx, UpsertJobMetaInput{JobID: jobID, Meta: JobMeta{
		OrgID:         orgID,
		Status:        status,
		KeepCompleted: job.KeepCompleted(),
		KeepFailed:    job.KeepFailed(),
	}}); err != nil {
		t.logf("upsert job %s with the %s status: %v", jobID, status, err)
	}
}

// trackRemoval is QueueOrgStatsTracker.trackRemoval
// (queue-org-stats.tracker.ts:86-96): only a job with metadata has a counter to
// decrement.
func (t *Tracker) trackRemoval(ctx context.Context, jobID string) {
	meta, found, err := t.store.GetJobMeta(ctx, jobID)
	if err != nil {
		t.logf("read meta of removed job %s: %v", jobID, err)
		return
	}
	if !found {
		return
	}
	if err := t.store.RemoveJob(ctx, meta.OrgID, jobID); err != nil {
		t.logf("remove job %s from the counters: %v", jobID, err)
	}
}

// transition applies one status change to an existing meta document.
func (t *Tracker) transition(ctx context.Context, jobID string, meta JobMeta, newStatus JobStatus) error {
	switch selectTransition(meta, newStatus) {
	case transitionSkip:
		return nil
	case transitionTerminalRemove:
		return t.store.TransitionTerminalAndRemove(ctx, jobID, meta.OrgID, newStatus)
	default:
		meta.Status = newStatus
		return t.store.UpsertJobMetaAndCount(ctx, UpsertJobMetaInput{JobID: jobID, Meta: meta})
	}
}

// transitionAction is the branch QueueOrgStatsService.transitionJob picks.
type transitionAction int

const (
	// transitionSkip is the early return when the stored and the new state are
	// equal (queue-org-stats.service.ts:95-97).
	transitionSkip transitionAction = iota
	// transitionUpsert is UPSERT_AND_TRANSITION_LUA
	// (queue-org-stats.service.ts:119-130).
	transitionUpsert
	// transitionTerminalRemove is TERMINAL_AND_REMOVE_LUA
	// (queue-org-stats.service.ts:99-117): the terminal state is counted but the
	// meta hash is dropped because BullMQ removes the job.
	transitionTerminalRemove
)

// selectTransition ports the branch selection of
// QueueOrgStatsService.transitionJob: a repeated state is a no-op, a completed or
// failed state whose keep flag is off is counted then removed, every other
// change is an upsert.
func selectTransition(meta JobMeta, newStatus JobStatus) transitionAction {
	if meta.Status == newStatus {
		return transitionSkip
	}
	if (newStatus == JobStatusCompleted && !meta.KeepCompleted) ||
		(newStatus == JobStatusFailed && !meta.KeepFailed) {
		return transitionTerminalRemove
	}
	return transitionUpsert
}

// logf writes one failure line. The prefix matches the package name so a
// deployment can grep the tracker in a shared log stream.
func (t *Tracker) logf(format string, args ...any) {
	t.logger.Printf("queueorgstats: "+format, args...)
}

// debugf writes one debug line. The NestJS tracker logs the skipped jobs at
// debug level, which is off unless Options.Debug is set.
func (t *Tracker) debugf(format string, args ...any) {
	if !t.debug {
		return
	}
	t.logger.Printf("queueorgstats: "+format, args...)
}
