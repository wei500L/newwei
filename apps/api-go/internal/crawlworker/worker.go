package crawlworker

// The Go crawl4ai queue worker. It owns the three BullMQ queues the NestJS
// CrawlQueueProcessor consumed when API_GO_CRAWL_WORKER_MODE=go:
// crawl4ai-hot, crawl4ai-normal and the legacy crawl4ai queue.
//
// Ownership is whole-process: the switch makes NestJS skip creating its crawl
// Workers (and its QueueEvents readers), and this worker claims the jobs with
// the vendored bullmq@5.63.2 Lua state machine. Producers are unchanged: both
// runtimes write the same job hash, wait/prioritized lists and events stream, so
// switching back needs no data migration and a short overlap is safe because the
// BullMQ job lock admits one owner per attempt.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlexecution"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
)

// FrontierNodeProcessor executes one queued Frontier node job. It is the
// crawl4ai frontier service the NestJS processor calls through
// crawlFrontierService.processQueuedNode for jobKind == "frontier_node"; the
// returned JSON document becomes the BullMQ job returnvalue unchanged.
type FrontierNodeProcessor interface {
	ProcessQueuedNode(ctx context.Context, nodeID, orgID string, requestTimeoutMs int) (json.RawMessage, error)
}

// RunOptions is CrawlExecutionRetryContext, the per-attempt context the
// execution service uses to size its crawl4ai timeout and to emit retry
// telemetry.
//
// It is an alias for crawlexecution.RunOptions rather than a distinct struct:
// TaskRunner must be satisfied by *crawlexecution.Service without an adapter, so
// the two declarations are the same type. Keeping the name here documents the
// worker-side contract.
type RunOptions = crawlexecution.RunOptions

// TaskRunner is the crawl task execution entry point
// (crawlexecution.Service.RunQueuedTask). It returns the FullSummary the BullMQ
// job stores as returnvalue (JSON-marshalled with the NestJS key order).
type TaskRunner interface {
	RunQueuedTask(ctx context.Context, orgID, taskID, triggeredByID string, options RunOptions) (crawlexecution.FullSummary, error)
}

// ActivityCounter is the crawl:activity terminal decrement. The production
// implementation is *crawlqueue.Activity.MarkTasksTerminalAtomic: B1 moved the
// QueueEvents 'completed'/'failed' side effect into this worker, so the counter
// is decremented exactly once, atomically, by the process that finished the job.
type ActivityCounter interface {
	MarkTasksTerminalAtomic(ctx context.Context, count int) error
}

// Snapshots is NewsSourceOpsSnapshotService.syncQueueCounts. A job that carries
// a sourceId refreshes that source's ops snapshot after a terminal transition,
// exactly like the QueueEvents handlers did. A nil Snapshots skips the refresh.
type Snapshots interface {
	SyncQueueCounts(ctx context.Context, orgID, sourceID string) error
}

// Config carries the environment fallbacks of the migration switch:
// CRAWL4AI_MAX_CONCURRENCY, CRAWL4AI_TIMEOUT_MS and the O1 settings cache TTL.
type Config struct {
	// MaxConcurrency is CRAWL4AI_MAX_CONCURRENCY, used when the crawl settings
	// cannot be read.
	MaxConcurrency int
	// DefaultTimeoutMs is CRAWL4AI_TIMEOUT_MS, used when the settings document
	// carries no positive timeout for the queue class.
	DefaultTimeoutMs int
	// SettingsTTL is the O1 cache lifetime. Zero uses five seconds.
	SettingsTTL time.Duration
}

// Options wires the crawl worker.
type Options struct {
	// Client is the shared command Redis client. The worker never closes it.
	Client *redis.Client
	// NewBlockingClient creates the dedicated blocking connection of one running
	// queue worker (BZPOPMIN cannot share a connection with commands). It is
	// called once per started queue, so three times when the legacy queue still
	// has work.
	NewBlockingClient func() *redis.Client
	// DB is the MySQL handle the terminal CrawlTask writes use.
	DB *sql.DB
	// Execution runs crawl-task jobs (crawlexecution.Service).
	Execution TaskRunner
	// Frontier runs frontier_node jobs. It is required: the Go worker owns every
	// job on the three queues, including the Frontier node jobs.
	Frontier FrontierNodeProcessor
	// Settings reads the crawl client settings (crawlqueue.SettingsReader).
	Settings *crawlqueue.SettingsReader
	// Activity is the crawl:activity counter (crawlqueue.Activity).
	Activity ActivityCounter
	// Snapshots refreshes the news source ops snapshot; optional.
	Snapshots Snapshots
	Config    Config
	// Now is the clock used for BullMQ timestamps and updatedAt; optional.
	Now func() time.Time
	// Logger receives the structured log lines; optional.
	Logger func(format string, args ...any)
}

// options is the validated form of Options.
type options struct {
	client            *redis.Client
	newBlockingClient func() *redis.Client
	db                *sql.DB
	execution         TaskRunner
	frontier          FrontierNodeProcessor
	settingsReader    *crawlqueue.SettingsReader
	activity          ActivityCounter
	snapshots         Snapshots
	config            Config
	now               func() time.Time
	logger            func(format string, args ...any)
}

// Worker is the process-level crawl queue worker: the shared concurrency
// limiter, the per-queue runtimes, the C2 subscriber and the lifecycle.
type Worker struct {
	opts     options
	scripts  queueScripts
	limiter  *concurrencyLimiter
	settings *settingsCache
	attempt  *attempt
	tokens   *tokenSource
	queues   []*queueRuntime

	fetchCtx      context.Context
	cancelFetch   context.CancelFunc
	stalledCtx    context.Context
	cancelStalled context.CancelFunc
	jobCtx        context.Context
	cancelJobs    context.CancelFunc

	fetchWG      sync.WaitGroup
	stalledWG    sync.WaitGroup
	jobWG        sync.WaitGroup
	subscriberWG sync.WaitGroup

	mu        sync.Mutex
	pubsub    *redis.PubSub
	closing   bool
	closeErr  error
	closeOnce sync.Once
	started   atomic.Bool
}

// New validates the wiring and builds the worker. Start opens the connections
// and starts the loops; New itself performs no I/O.
func New(opts Options) (*Worker, error) {
	switch {
	case opts.Client == nil:
		return nil, fmt.Errorf("crawlworker: a shared redis client is required")
	case opts.NewBlockingClient == nil:
		return nil, fmt.Errorf("crawlworker: a blocking redis client factory is required")
	case opts.DB == nil:
		return nil, fmt.Errorf("crawlworker: a mysql handle is required")
	case opts.Execution == nil:
		return nil, fmt.Errorf("crawlworker: a crawl execution runner is required")
	case opts.Frontier == nil:
		return nil, fmt.Errorf("crawlworker: a frontier node processor is required")
	case opts.Settings == nil:
		return nil, fmt.Errorf("crawlworker: a crawl settings reader is required")
	case opts.Activity == nil:
		return nil, fmt.Errorf("crawlworker: a crawl activity counter is required")
	}
	scripts, err := loadQueueScripts()
	if err != nil {
		return nil, err
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	logger := opts.Logger
	if logger == nil {
		logger = log.Printf
	}
	normalized := options{
		client:            opts.Client,
		newBlockingClient: opts.NewBlockingClient,
		db:                opts.DB,
		execution:         opts.Execution,
		frontier:          opts.Frontier,
		settingsReader:    opts.Settings,
		activity:          opts.Activity,
		snapshots:         opts.Snapshots,
		config:            opts.Config,
		now:               now,
		logger:            logger,
	}
	worker := &Worker{
		opts:     normalized,
		scripts:  scripts,
		limiter:  newConcurrencyLimiter(1),
		settings: newSettingsCache(normalized.settingsReader, normalized.config.SettingsTTL, now),
		tokens:   newTokenSource(),
	}
	worker.attempt = &attempt{
		runner:       normalized.execution,
		frontier:     normalized.frontier,
		limiter:      worker.limiter,
		settings:     worker.settings,
		activity:     normalized.activity,
		tasks:        newSQLTaskStore(normalized.db, now),
		snapshots:    normalized.snapshots,
		rateLimitAll: worker.rateLimitAllQueues,
		config:       normalized.config,
		log:          normalized.logger,
	}
	return worker, nil
}

// Start reads the initial concurrency, writes the BullMQ meta concurrency,
// starts one worker per configured queue and subscribes the C2 broadcast. It
// returns once the loops are running; Close performs the ordered drain.
func (w *Worker) Start(ctx context.Context) error {
	if w == nil {
		return fmt.Errorf("crawlworker: worker is nil")
	}
	if !w.started.CompareAndSwap(false, true) {
		return errWorkerAlreadyStarted
	}
	if ctx == nil {
		ctx = context.Background()
	}
	pingCtx, cancelPing := context.WithTimeout(ctx, 5*time.Second)
	defer cancelPing()
	if err := w.opts.client.Ping(pingCtx).Err(); err != nil {
		return fmt.Errorf("crawlworker: redis ping failed: %w", err)
	}

	concurrency := w.applyStartupConcurrency(ctx)
	w.fetchCtx, w.cancelFetch = context.WithCancel(context.Background())
	w.stalledCtx, w.cancelStalled = context.WithCancel(context.Background())
	w.jobCtx, w.cancelJobs = context.WithCancel(context.Background())

	includeLegacy := w.shouldStartLegacyWorker(ctx)
	for _, spec := range queueSpecs() {
		if spec.Legacy && !includeLegacy {
			w.logf("crawlworker: legacy crawl queue holds no waiting/active/delayed/paused job; not starting its worker")
			continue
		}
		runtime, err := w.newQueueRuntime(spec)
		if err != nil {
			w.abortStart()
			return err
		}
		// The per-queue pull concurrency starts at the settings value and follows
		// the C2 broadcast afterwards.
		runtime.setConcurrency(concurrency)
		w.queues = append(w.queues, runtime)
		runtime.start(w.fetchCtx, w.stalledCtx)
	}
	w.subscribeWorkerConcurrency()
	w.logf("crawlworker: started queues=%d concurrency=%d legacy=%t", len(w.queues), concurrency, includeLegacy)
	return nil
}

// Close stops claiming jobs, drains the in-flight attempts while their locks keep
// renewing, then stops the stalled checkers and the C2 subscription and closes
// the dedicated blocking connections. The shared command client stays open.
//
// An attempt still running at the deadline is canceled: it leaves its job in the
// active list, the lock expires and BullMQ stalled recovery hands the job to the
// next attempt. This is the itempipeline.Worker.Close contract.
func (w *Worker) Close(ctx context.Context) error {
	if w == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	w.closeOnce.Do(func() {
		w.mu.Lock()
		w.closing = true
		w.mu.Unlock()
		if w.cancelFetch != nil {
			w.cancelFetch()
		}
		// The fetch loops are the only goroutines that start attempts, so wait for
		// them before waiting on the attempt group.
		w.fetchWG.Wait()
		drained := make(chan struct{})
		go func() {
			w.jobWG.Wait()
			close(drained)
		}()
		select {
		case <-drained:
		case <-ctx.Done():
			if w.cancelJobs != nil {
				w.cancelJobs()
			}
			graceCtx, cancelGrace := context.WithTimeout(context.Background(), 5*time.Second)
			select {
			case <-drained:
			case <-graceCtx.Done():
				w.closeErr = fmt.Errorf("crawlworker: in-flight crawl jobs did not stop before the shutdown deadline")
			}
			cancelGrace()
		}
		if w.cancelStalled != nil {
			w.cancelStalled()
		}
		if w.cancelJobs != nil {
			w.cancelJobs()
		}
		w.stalledWG.Wait()
		w.closeSubscriber()
		w.limiter.close()
		for _, runtime := range w.queues {
			runtime.close()
		}
		w.queues = nil
	})
	return w.closeErr
}

// ApplyConcurrency is the C2 broadcast effect: change the shared limiter
// capacity and the pull concurrency of every running queue worker, then
// invalidate the O1 settings cache so the next attempt re-reads the document.
func (w *Worker) ApplyConcurrency(concurrency int) {
	if w == nil {
		return
	}
	capacity := maxInt(1, jsRound(float64(concurrency)))
	w.limiter.setCapacity(capacity)
	w.settings.Invalidate()
	for _, runtime := range w.queues {
		runtime.setConcurrency(capacity)
	}
}

// applyStartupConcurrency is onModuleInit's concurrency block: read the settings
// value, write the BullMQ meta concurrency for the three queues (warn only on
// failure), set the limiter capacity and return the pull concurrency.
func (w *Worker) applyStartupConcurrency(ctx context.Context) int {
	configured := maxInt(1, jsRound(float64(w.opts.config.MaxConcurrency)))
	settings, err := w.settings.Read(ctx)
	if err != nil {
		w.logf("crawlworker: failed to read crawl settings for the initial concurrency: %v; using the environment fallback", err)
	} else {
		configured = maxInt(1, jsRound(float64(settings.MaxConcurrency)))
		if err := w.applyGlobalConcurrency(ctx, configured); err != nil {
			w.logf("crawlworker: failed to apply crawl queue global concurrency %d: %v; using worker-local concurrency fallback", configured, err)
		}
	}
	concurrency := resolveInitialWorkerConcurrency(configured, w.opts.config.MaxConcurrency)
	w.limiter.setCapacity(concurrency)
	return concurrency
}

// applyGlobalConcurrency is Queue.setGlobalConcurrency for the three crawl
// queues in one pipeline: HSET bull:<queue>:meta concurrency N. The Lua
// moveToActive/moveToFinished scripts read that field as the hard active-list cap.
func (w *Worker) applyGlobalConcurrency(ctx context.Context, concurrency int) error {
	pipeline := w.opts.client.Pipeline()
	for _, spec := range queueSpecs() {
		pipeline.HSet(ctx, newKeys(spec.Name).Meta, "concurrency", concurrency)
	}
	_, err := pipeline.Exec(ctx)
	return err
}

// shouldStartLegacyWorker is shouldStartLegacyWorker: the legacy queue gets a
// worker only while it still holds waiting, active, delayed or paused jobs. A
// count failure starts the worker defensively so no leftover job is stranded.
func (w *Worker) shouldStartLegacyWorker(ctx context.Context) bool {
	legacyKeys := newKeys(crawlqueue.QueueLegacy)
	pipeline := w.opts.client.Pipeline()
	waiting := pipeline.LLen(ctx, legacyKeys.Wait)
	active := pipeline.LLen(ctx, legacyKeys.Active)
	paused := pipeline.LLen(ctx, legacyKeys.Paused)
	delayed := pipeline.ZCard(ctx, legacyKeys.Delayed)
	if _, err := pipeline.Exec(ctx); err != nil {
		w.logf("crawlworker: failed to inspect the legacy crawl queue: %v; starting its worker defensively", err)
		return true
	}
	total := waiting.Val() + active.Val() + paused.Val() + delayed.Val()
	return total > 0
}

// newQueueRuntime builds one queue worker and its dedicated blocking connection.
func (w *Worker) newQueueRuntime(spec queueSpec) (*queueRuntime, error) {
	blocking := w.opts.newBlockingClient()
	if blocking == nil {
		return nil, fmt.Errorf("crawlworker: blocking redis client factory returned nil for %s", spec.Name)
	}
	pingCtx, cancelPing := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelPing()
	if err := blocking.Ping(pingCtx).Err(); err != nil {
		_ = blocking.Close()
		return nil, fmt.Errorf("crawlworker: blocking redis ping for %s failed: %w", spec.Name, err)
	}
	return &queueRuntime{
		worker:   w,
		spec:     spec,
		keys:     newKeys(spec.Name),
		scripts:  w.scripts,
		client:   w.opts.client,
		blocking: blocking,
		wake:     make(chan struct{}, 1),
	}, nil
}

// abortStart releases the resources of a partially started worker.
func (w *Worker) abortStart() {
	if w.cancelFetch != nil {
		w.cancelFetch()
	}
	if w.cancelStalled != nil {
		w.cancelStalled()
	}
	if w.cancelJobs != nil {
		w.cancelJobs()
	}
	w.fetchWG.Wait()
	w.stalledWG.Wait()
	for _, runtime := range w.queues {
		runtime.close()
	}
	w.queues = nil
	w.limiter.close()
}

// subscribeWorkerConcurrency is subscribeWorkerConcurrency: a dedicated PubSub
// connection watches crawl:worker-concurrency:v1. An invalid message is warned
// and ignored; the settings document and the BullMQ meta stay authoritative.
func (w *Worker) subscribeWorkerConcurrency() {
	// The subscription outlives Start's context: Close owns its lifetime.
	subscribeCtx := context.Background()
	pubsub := w.opts.client.Subscribe(subscribeCtx, crawlqueue.WorkerConcurrencyChannel)
	if _, err := pubsub.Receive(subscribeCtx); err != nil {
		w.logf("crawlworker: failed to subscribe crawl worker concurrency channel: %v", err)
		_ = pubsub.Close()
		return
	}
	w.mu.Lock()
	w.pubsub = pubsub
	w.mu.Unlock()
	w.subscriberWG.Add(1)
	go func() {
		defer w.subscriberWG.Done()
		for message := range pubsub.Channel() {
			if message.Channel != crawlqueue.WorkerConcurrencyChannel {
				continue
			}
			concurrency, err := parseWorkerConcurrencyMessage(message.Payload)
			if err != nil {
				w.logf("crawlworker: ignored crawl worker concurrency message (%v): %s", err, message.Payload)
				continue
			}
			w.ApplyConcurrency(concurrency)
			w.logf("crawlworker: applied crawl worker concurrency broadcast maxConcurrency=%d", concurrency)
		}
	}()
}

// closeSubscriber unsubscribes and closes the C2 PubSub connection.
func (w *Worker) closeSubscriber() {
	w.mu.Lock()
	pubsub := w.pubsub
	w.pubsub = nil
	w.mu.Unlock()
	if pubsub == nil {
		return
	}
	closeCtx, cancelClose := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelClose()
	if err := pubsub.Unsubscribe(closeCtx, crawlqueue.WorkerConcurrencyChannel); err != nil {
		w.logf("crawlworker: failed to unsubscribe crawl worker concurrency channel: %v", err)
	}
	if err := pubsub.Close(); err != nil {
		w.logf("crawlworker: failed to close crawl worker concurrency subscriber: %v", err)
	}
	w.subscriberWG.Wait()
}

// rateLimitAllQueues is rateLimitAllWorkers: during a memory pressure requeue
// every crawl queue worker of this process is rate limited (O3: one pipeline).
// BullMQ's Worker.rateLimit writes Number.MAX_SAFE_INTEGER with a PX cooldown, so
// moveToActive returns the limiter TTL instead of a job until the cooldown
// expires. A failed SET is reported to the caller, which then rethrows the
// original crawl error.
func (w *Worker) rateLimitAllQueues(ctx context.Context, cooldownMs int64) error {
	pipeline := w.opts.client.Pipeline()
	for _, spec := range queueSpecs() {
		pipeline.Set(ctx, newKeys(spec.Name).Limiter, "9007199254740991", time.Duration(cooldownMs)*time.Millisecond)
	}
	if _, err := pipeline.Exec(ctx); err != nil {
		return fmt.Errorf("crawlworker: failed to apply crawl queue rate limit: %w", err)
	}
	return nil
}

// logf writes one structured line.
func (w *Worker) logf(format string, args ...any) {
	if w == nil || w.opts.logger == nil {
		return
	}
	w.opts.logger(format, args...)
}

// closing reports whether Close already started. The fetch loops check it before
// starting another attempt.
func (w *Worker) closingState() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.closing
}
