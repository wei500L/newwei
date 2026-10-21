package alertworker

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"
)

// The reconciliation constants. ALERT_RULE_TASK_CONCURRENCY is the NestJS
// concurrency of ensureAllSchedules (alerts.service.ts:1298) and of the
// default-rule pass (alerts.service.ts:529); it is declared at
// apps/api/src/modules/alerts/alerts.service.ts:117.
const (
	// ruleScheduleReconcileLockName is the logical lease name; cronlock writes
	// the physical key lock:alert:rule-schedule-reconcile.
	ruleScheduleReconcileLockName = "alert:rule-schedule-reconcile"
	// ruleScheduleReconcileLockTTL bounds one cycle. The lease is renewed while
	// the runner is in flight, so a large rule table never outlives it.
	ruleScheduleReconcileLockTTL = 5 * time.Minute
	// ruleScheduleReconcileRunTimeout bounds one reconciliation. A cycle that
	// hits it is cancelled and reported as an error.
	ruleScheduleReconcileRunTimeout = 2 * time.Minute
	// activeRuleBatchSize is the keyset page size: the reconciliation never
	// loads the whole AlertRule table into memory.
	activeRuleBatchSize = 200
	// defaultRuleTaskConcurrency is ALERT_RULE_TASK_CONCURRENCY: 16 concurrent
	// schedule upserts, exactly like executeWithConcurrencyLimit
	// (alerts.service.ts:2581-2605).
	defaultRuleTaskConcurrency = 16
)

// ruleScheduleSource is the AlertRule read surface of the reconciliation.
// *repository implements it with a keyset-paginated query.
type ruleScheduleSource interface {
	listActiveRuleBatch(ctx context.Context, afterID string, limit int) ([]activeRule, error)
}

// ruleScheduleWriter is the producer surface of the reconciliation.
// *queue.Producer implements it; EnsureRuleSchedule removes the previous repeat
// schedule before writing the new one, which is what makes the reconciliation
// idempotent.
type ruleScheduleWriter interface {
	EnsureRuleSchedule(ctx context.Context, ruleID, orgID string, checkIntervalSec int) error
}

// ruleScheduleLease is the cronlock surface. *cronlock.Lock implements it; the
// non-owner of the lease skips the cycle without an error.
type ruleScheduleLease interface {
	WithLock(ctx context.Context, key string, ttl time.Duration, runner func(context.Context) error) (bool, error)
}

// ReconcileRuleSchedules ports AlertsService.ensureAllSchedules: it creates the
// missing default rules, then makes every active rule's repeat schedule match the
// rule row (checkIntervalSec floored at 60s).
//
// The NestJS method runs on every API instance at boot (alerts.processor.ts:32)
// and raises the first per-rule error through Promise.all
// (alerts.service.ts:2600). This port keeps the same error contract
// but runs under the lock:alert:rule-schedule-reconcile lease, so only one
// api-go replica reconciles and the others return nil. A per-rule failure is
// logged, counted and joined into the returned error; the remaining rules are
// still reconciled.
func (s *Service) ReconcileRuleSchedules(ctx context.Context) error {
	if s == nil {
		return nil
	}
	reconciler := &ruleScheduleReconciler{
		source:         s.repo,
		writer:         s.producer,
		lease:          s.lease,
		ensureDefaults: s.ensureDefaultRulesForAllOrgs,
		concurrency:    s.cfg.RuleTaskConcurrency,
		logger:         s.logger,
	}
	return reconciler.reconcile(ctx)
}

// ruleScheduleReconciler holds the dependencies of one reconciliation. The
// Service builds it from its own fields; the tests build it from fakes.
type ruleScheduleReconciler struct {
	source         ruleScheduleSource
	writer         ruleScheduleWriter
	lease          ruleScheduleLease
	ensureDefaults func(context.Context) error
	concurrency    int
	// batchSize overrides activeRuleBatchSize; 0 means the production page size.
	// The tests lower it so the keyset walk over several pages is observable.
	batchSize int
	logger    *log.Logger
}

// reconcile runs one leased cycle. A missing lease is a configuration error; a
// foreign lease is a normal skip.
func (r *ruleScheduleReconciler) reconcile(ctx context.Context) error {
	if r == nil {
		return nil
	}
	if r.lease == nil {
		return errors.New("alertworker: rule schedule reconciliation requires a redis lease")
	}
	runCtx, cancel := context.WithTimeout(ctx, ruleScheduleReconcileRunTimeout)
	defer cancel()
	acquired, err := r.lease.WithLock(runCtx, ruleScheduleReconcileLockName, ruleScheduleReconcileLockTTL,
		func(lockCtx context.Context) error {
			// ensureAllSchedules creates the default rules first, because a rule
			// created by that pass must also get its schedule in this cycle.
			if r.ensureDefaults != nil {
				if err := r.ensureDefaults(lockCtx); err != nil {
					return fmt.Errorf("create the missing default alert rules: %w", err)
				}
			}
			return r.ensureActiveRuleSchedules(lockCtx)
		})
	if err != nil {
		return fmt.Errorf("alertworker: reconcile alert rule schedules: %w", err)
	}
	if !acquired {
		r.logf("rule schedule reconciliation skipped, another instance holds the %s lease",
			ruleScheduleReconcileLockName)
	}
	return nil
}

// ensureActiveRuleSchedules walks the active rules in id order, one keyset page
// at a time, and upserts each schedule with ALERT_RULE_TASK_CONCURRENCY workers.
func (r *ruleScheduleReconciler) ensureActiveRuleSchedules(ctx context.Context) error {
	concurrency := r.concurrency
	if concurrency < 1 {
		concurrency = defaultRuleTaskConcurrency
	}
	batchSize := r.batchSize
	if batchSize < 1 {
		batchSize = activeRuleBatchSize
	}
	afterID := ""
	total := 0
	failures := make([]error, 0, 4)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		batch, err := r.source.listActiveRuleBatch(ctx, afterID, batchSize)
		if err != nil {
			return errors.Join(append(failures, fmt.Errorf("list the active alert rules after %q: %w", afterID, err))...)
		}
		if len(batch) == 0 {
			break
		}
		failures = append(failures, r.ensureRuleBatch(ctx, batch, concurrency)...)
		total += len(batch)
		afterID = batch[len(batch)-1].ID
		if len(batch) < batchSize {
			break
		}
	}
	if len(failures) > 0 {
		return fmt.Errorf("reconcile %d of %d active alert rule schedules: %w",
			len(failures), total, errors.Join(failures...))
	}
	r.logf("reconciled the schedules of %d active alert rule(s)", total)
	return nil
}

// ensureRuleBatch upserts one page with at most concurrency workers in flight,
// mirroring executeWithConcurrencyLimit. A failed rule is reported to the caller
// and does not stop the rest of the page.
func (r *ruleScheduleReconciler) ensureRuleBatch(ctx context.Context, rules []activeRule, concurrency int) []error {
	if len(rules) == 0 {
		return nil
	}
	workers := concurrency
	if workers > len(rules) {
		workers = len(rules)
	}
	var (
		mu       sync.Mutex
		failures []error
		next     int
		wg       sync.WaitGroup
	)
	wg.Add(workers)
	for worker := 0; worker < workers; worker++ {
		go func() {
			defer wg.Done()
			for {
				mu.Lock()
				if next >= len(rules) || ctx.Err() != nil {
					mu.Unlock()
					return
				}
				rule := rules[next]
				next++
				mu.Unlock()

				if err := r.writer.EnsureRuleSchedule(ctx, rule.ID, rule.OrgID, rule.CheckIntervalSec); err != nil {
					ruleErr := fmt.Errorf("rule %s: %w", rule.ID, err)
					r.logf("schedule active alert rule: %v", ruleErr)
					mu.Lock()
					failures = append(failures, ruleErr)
					mu.Unlock()
				}
			}
		}()
	}
	wg.Wait()
	return failures
}

// logf writes one reconciliation line with the alertworker prefix.
func (r *ruleScheduleReconciler) logf(format string, args ...any) {
	logger := r.logger
	if logger == nil {
		logger = log.Default()
	}
	logger.Printf("alertworker: "+format, args...)
}

// listActiveRuleBatch is the keyset-paginated variant of listActiveRules: it
// selects the same columns, ordered by id, but reads one page after afterID so a
// large rule table is never loaded into memory. It is the repository
// implementation of ruleScheduleSource.
func (r *repository) listActiveRuleBatch(ctx context.Context, afterID string, limit int) ([]activeRule, error) {
	if limit <= 0 {
		limit = activeRuleBatchSize
	}
	rows, err := r.db.QueryContext(ctx,
		"SELECT `id`, `orgId`, `checkIntervalSec` FROM `AlertRule`"+
			" WHERE `status` = ? AND `id` > ? ORDER BY `id` ASC LIMIT ?",
		StatusActive, afterID, limit)
	if err != nil {
		return nil, fmt.Errorf("alertworker: list active alert rules after %q: %w", afterID, err)
	}
	defer rows.Close()
	rules := make([]activeRule, 0, limit)
	for rows.Next() {
		var rule activeRule
		if err := rows.Scan(&rule.ID, &rule.OrgID, &rule.CheckIntervalSec); err != nil {
			return nil, fmt.Errorf("alertworker: scan active alert rule: %w", err)
		}
		rules = append(rules, rule)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("alertworker: iterate active alert rules: %w", err)
	}
	return rules, nil
}
