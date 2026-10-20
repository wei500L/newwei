// Package startupreconcile performs the two onModuleInit reconciliations the
// NestJS API performs at boot:
//
//   - TaskLogSettingsService.onModuleInit reads the task-log retention setting
//     and applies the managed TTL index on tasklogs;
//   - LlmRequestLogSettingsService.onModuleInit does the same for
//     llmrequestlogs;
//   - ItemsElasticsearchService.onModuleInit calls ensureIndex when
//     Elasticsearch is configured.
//
// The work is asynchronous: Start launches one goroutine and returns, so a slow
// Mongo or Elasticsearch never blocks the gateway listener. Failures are logged
// as warnings and never abort startup.
//
// Multiple api-go replicas start at the same time, so the whole reconciliation
// runs under the "startup:reconcile" Redis lease (cronlock). The first replica
// to acquire it reconciles; the others log that they skipped the cycle. This is
// the same CacheService.withLock pattern the NestJS background owners use.
package startupreconcile

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"
)

const (
	// lockName is the logical lease name (physical key lock:startup:reconcile).
	lockName = "startup:reconcile"
	// lockTTL bounds the cycle; index creation on a large collection can take a
	// while, so the lease is renewed while the runner is in flight.
	lockTTL = 5 * time.Minute
	// runTimeout bounds one asynchronous reconciliation.
	runTimeout = 2 * time.Minute
)

// SettingsReconciler is the platformgovernance retention surface.
type SettingsReconciler interface {
	ReconcileTaskLogRetention(context.Context) (int, error)
	ReconcileLLMRequestLogRetention(context.Context) (int, error)
}

// IndexEnsurer is the searchreindex Elasticsearch surface.
type IndexEnsurer interface {
	EnsureIndex(context.Context) error
}

// Lease is the cronlock surface used here; *cronlock.Lock implements it.
type Lease interface {
	WithLock(ctx context.Context, key string, ttl time.Duration, runner func(context.Context) error) (bool, error)
}

// Deps wires the optional reconcilers. A nil Settings or Search skips that part;
// Lock is required to guarantee one cycle across replicas.
type Deps struct {
	Settings SettingsReconciler
	Search   IndexEnsurer
	Lock     Lease
}

// Reconciler runs the startup reconciliation once per process start.
type Reconciler struct {
	deps Deps

	mu     sync.Mutex
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// New builds the reconciler.
func New(deps Deps) *Reconciler {
	return &Reconciler{deps: deps}
}

// Start runs the reconciliation asynchronously and returns immediately.
func (r *Reconciler) Start(ctx context.Context) {
	if r == nil || r.deps.Lock == nil {
		return
	}
	r.mu.Lock()
	if r.cancel != nil {
		r.mu.Unlock()
		return
	}
	runCtx, cancel := context.WithCancel(ctx)
	r.cancel = cancel
	r.wg.Add(1)
	r.mu.Unlock()

	go func() {
		defer r.wg.Done()
		acquired, err := r.RunOnce(runCtx)
		switch {
		case err != nil:
			log.Printf("startupreconcile: %v", err)
		case !acquired:
			log.Printf("startupreconcile: skipped, another instance holds the %s lease", lockName)
		}
	}()
}

// Close waits for the in-flight reconciliation (or its cancellation) before the
// shared Mongo/MySQL connections are closed.
func (r *Reconciler) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	cancel := r.cancel
	r.cancel = nil
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	done := make(chan struct{})
	go func() {
		r.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
	return nil
}

// RunOnce executes one leased reconciliation. Each part is independent: a TTL
// failure does not skip Elasticsearch, and every failure is joined into one
// warning by the caller.
func (r *Reconciler) RunOnce(ctx context.Context) (bool, error) {
	if r == nil || r.deps.Lock == nil {
		return false, errors.New("startupreconcile: lease is not configured")
	}
	if r.deps.Settings == nil && r.deps.Search == nil {
		return false, nil
	}
	runCtx, cancel := context.WithTimeout(ctx, runTimeout)
	defer cancel()
	return r.deps.Lock.WithLock(runCtx, lockName, lockTTL, func(ctx context.Context) error {
		var failures []error
		if r.deps.Settings != nil {
			if days, err := r.deps.Settings.ReconcileTaskLogRetention(ctx); err != nil {
				failures = append(failures, fmt.Errorf("task log TTL: %w", err))
			} else {
				log.Printf("startupreconcile: TaskLog TTL index aligned retentionDays=%d", days)
			}
			if days, err := r.deps.Settings.ReconcileLLMRequestLogRetention(ctx); err != nil {
				failures = append(failures, fmt.Errorf("llm request log TTL: %w", err))
			} else {
				log.Printf("startupreconcile: LLM request log TTL index aligned retentionDays=%d", days)
			}
		}
		if r.deps.Search != nil {
			if err := r.deps.Search.EnsureIndex(ctx); err != nil {
				failures = append(failures, fmt.Errorf("elasticsearch ensureIndex: %w", err))
			} else {
				log.Printf("startupreconcile: Elasticsearch items index aligned")
			}
		}
		return errors.Join(failures...)
	})
}
