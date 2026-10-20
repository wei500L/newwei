package auditoutbox

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	mathrand "math/rand"
	"sync"
	"time"
)

const (
	// lockKey is the physical Redis key. NestJS calls
	// CacheService.withLock("cron:audit-log-outbox"), which prefixes "lock:".
	lockKey = "lock:cron:audit-log-outbox"
	// lockTTL matches AUDIT_LOG_OUTBOX_LOCK_TTL_MS.
	lockTTL = 55 * time.Second

	// batchSize is the global cut of one tick, not a per-status quota.
	batchSize = 200
	// deliveryConcurrency matches AUDIT_LOG_OUTBOX_DELIVERY_CONCURRENCY.
	deliveryConcurrency = 8
	// staleLockWindow is the 5-minute recovery window for processing rows.
	staleLockWindow = 5 * time.Minute

	// maxAttempts is the dead threshold applied to the claimed attempts value.
	maxAttempts = 10
	// retryBaseDelay is the 30-second base of the exponential backoff.
	retryBaseDelay = 30 * time.Second
	// backoffCapAttempt caps the exponent at 5, matching computeBackoffDelay.
	backoffCapAttempt = 5
)

// Deps are the narrow ports the scheduler needs.
type Deps struct {
	Repository Repository
	Locks      LockStore
	// Now is an optional clock used by tests.
	Now func() time.Time
	// Rand is an optional jitter source used by tests.
	Rand func() float64
}

// Scheduler owns the per-minute tick and the Redis cron lease. Start launches
// one goroutine; Close stops new ticks and new claims, drains in-flight work,
// then stops the lease renewal and releases the lease before the caller closes
// the shared Redis/MySQL connections.
type Scheduler struct {
	deps Deps

	startOnce sync.Once
	stopOnce  sync.Once
	stop      chan struct{}
	hardStop  context.CancelFunc
	wg        sync.WaitGroup
}

// NewScheduler builds the scheduler from named ports.
func NewScheduler(deps Deps) *Scheduler {
	return &Scheduler{deps: deps, stop: make(chan struct{})}
}

// Start launches the per-minute loop. It does not run a catch-up tick for
// minutes that elapsed before startup.
func (s *Scheduler) Start(parent context.Context) {
	if s == nil {
		return
	}
	s.startOnce.Do(func() {
		ctx, cancel := context.WithCancel(parent)
		s.hardStop = cancel
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.loop(ctx)
		}()
	})
}

// Close signals the loop to stop starting ticks and entries, waits for the
// in-flight tick to drain, then cancels the remaining context. The wait is
// bounded by ctx. Unfinished rows are left in place for the 5-minute stale
// recovery; shutdown never deletes them.
func (s *Scheduler) Close(ctx context.Context) error {
	if s == nil {
		return nil
	}
	s.stopOnce.Do(func() { close(s.stop) })
	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		s.closeHardStop()
		return nil
	case <-ctx.Done():
		s.closeHardStop()
		return ctx.Err()
	}
}

func (s *Scheduler) closeHardStop() {
	if s.hardStop != nil {
		s.hardStop()
	}
}

// loop aligns the first tick to the next minute boundary and repeats every
// minute. A delayed tick is re-aligned to the next future minute instead of
// replaying missed minutes.
func (s *Scheduler) loop(ctx context.Context) {
	next := s.clock().UTC().Truncate(time.Minute).Add(time.Minute)
	timer := time.NewTimer(time.Until(next))
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.stop:
			return
		case <-timer.C:
			if err := s.runTick(ctx); err != nil {
				log.Printf("auditoutbox: tick failed: %v", err)
			}
			now := s.clock().UTC()
			next = next.Add(time.Minute)
			if !next.After(now) {
				next = now.Truncate(time.Minute).Add(time.Minute)
			}
			timer.Reset(time.Until(next))
		}
	}
}

// runTick acquires the cron lease, scans the three statuses with the fixed
// batch instant, loads the payloads of the selected rows only, and processes
// them with the delivery concurrency. Any batch-level failure is logged and
// ends this tick without deleting anything.
func (s *Scheduler) runTick(ctx context.Context) error {
	if s == nil || s.deps.Repository == nil || s.deps.Locks == nil {
		return errors.New("auditoutbox: scheduler is not fully configured")
	}
	if s.stopped() {
		return nil
	}
	token, err := newToken()
	if err != nil {
		return fmt.Errorf("auditoutbox: generate cron lease token: %w", err)
	}
	acquired, err := s.deps.Locks.SetIfAbsent(ctx, lockKey, token, lockTTL)
	if err != nil {
		return fmt.Errorf("auditoutbox: acquire cron lease: %w", err)
	}
	if !acquired {
		log.Printf("auditoutbox: batch skipped because another instance holds the cron lease")
		return nil
	}
	stopRenew, release := s.startLockRenew(token)
	defer release()
	defer stopRenew()

	now := s.clock().UTC().Truncate(time.Millisecond)
	staleCutoff := now.Add(-staleLockWindow)
	candidates, err := s.collectCandidates(ctx, now, staleCutoff)
	if err != nil {
		log.Printf("auditoutbox: failed to process audit log outbox batch: %v", err)
		return nil
	}
	if len(candidates) == 0 {
		return nil
	}
	payloads, err := s.deps.Repository.LoadPayloads(ctx, candidateIDs(candidates))
	if err != nil {
		log.Printf("auditoutbox: failed to load audit log outbox payloads: %v", err)
		return nil
	}
	s.processCandidates(ctx, candidates, payloads)
	return nil
}

// collectCandidates reads up to batchSize rows per status and applies the
// original global merge. The payload is not part of this read.
func (s *Scheduler) collectCandidates(ctx context.Context, now, staleCutoff time.Time) ([]Candidate, error) {
	pending, err := s.deps.Repository.ListPending(ctx, now, batchSize)
	if err != nil {
		return nil, err
	}
	failed, err := s.deps.Repository.ListFailed(ctx, now, batchSize)
	if err != nil {
		return nil, err
	}
	staleProcessing, err := s.deps.Repository.ListStaleProcessing(ctx, staleCutoff, batchSize)
	if err != nil {
		return nil, err
	}
	return mergeCandidates([][]Candidate{pending, failed, staleProcessing}, batchSize), nil
}

func candidateIDs(candidates []Candidate) []string {
	ids := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		ids = append(ids, candidate.ID)
	}
	return ids
}

// processCandidates runs the selected entries through a fixed worker pool in
// candidate order. A stop signal prevents any further claim while the entries
// already being delivered drain.
func (s *Scheduler) processCandidates(ctx context.Context, candidates []Candidate, payloads map[string]json.RawMessage) {
	work := make(chan Candidate)
	var workers sync.WaitGroup
	for index := 0; index < deliveryConcurrency; index++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for candidate := range work {
				if s.stopped() {
					continue
				}
				if err := s.processCandidate(ctx, candidate, payloads); err != nil {
					log.Printf(
						"auditoutbox: failed to process audit log outbox entry outboxId=%s orgId=%s err=%v",
						candidate.ID, candidate.OrgID, err,
					)
				}
			}
		}()
	}

	for _, candidate := range candidates {
		if s.stopped() {
			break
		}
		work <- candidate
	}
	close(work)
	workers.Wait()
}

// processCandidate validates the envelope and tenant before any write. An
// invalid payload or an orgId that does not match the outbox row is parked as
// dead with attempts+1; it never produces an AuditLog row.
func (s *Scheduler) processCandidate(ctx context.Context, candidate Candidate, payloads map[string]json.RawMessage) error {
	raw, ok := payloads[candidate.ID]
	if !ok {
		// The row was deleted between the scan and the payload read.
		return nil
	}
	payload, ok := parsePayload(raw)
	if !ok || payload.OrgID != candidate.OrgID {
		s.markDead(ctx, candidate, candidate.Attempts+1, invalidPayloadMessage)
		return nil
	}
	return s.deliver(ctx, candidate, payload)
}

// deliver claims the row, writes the recovered audit row exactly once per
// payload identity, and deletes the outbox row. A claim that loses the race is
// skipped silently. A delivery failure is written back with the claimed
// attempts value; a status write failure is only logged so the row stays
// recoverable.
func (s *Scheduler) deliver(ctx context.Context, candidate Candidate, payload *normalizedPayload) error {
	claimed, err := s.deps.Repository.Claim(ctx, candidate)
	if err != nil {
		return err
	}
	if claimed == nil {
		return nil
	}

	if err := s.writeAuditLog(ctx, payload); err != nil {
		s.failDelivery(ctx, candidate, claimed.Attempts, err)
		return nil
	}
	if err := s.deps.Repository.DeleteOutbox(ctx, candidate.ID, candidate.OrgID); err != nil {
		s.failDelivery(ctx, candidate, claimed.Attempts, err)
		return nil
	}
	return nil
}

// failDelivery records the delivery error with the tenant identifiers only —
// never the payload or metadata — and then applies the retry/dead rule.
func (s *Scheduler) failDelivery(ctx context.Context, candidate Candidate, attempts int, cause error) {
	log.Printf(
		"auditoutbox: audit log outbox delivery failed outboxId=%s orgId=%s err=%v",
		candidate.ID, candidate.OrgID, cause,
	)
	s.markFailure(ctx, candidate, attempts, cause)
}

// writeAuditLog performs the at-least-once dedupe. The lookup identity is
// (orgId, actorId, resource, action, createdAt); metadata and ipAddress are not
// part of it, and a re-delivery after a failed delete must not insert a second
// row. The two statements are not one transaction, matching the NestJS order:
// insert first, delete second.
func (s *Scheduler) writeAuditLog(ctx context.Context, payload *normalizedPayload) error {
	identity := AuditIdentity{
		OrgID:     payload.OrgID,
		ActorID:   payload.ActorID,
		Resource:  payload.Resource,
		Action:    payload.Action,
		CreatedAt: payload.CreatedAt,
	}
	if _, found, err := s.deps.Repository.FindAuditLog(ctx, identity); err != nil {
		return err
	} else if found {
		return nil
	}

	id, err := newRowID()
	if err != nil {
		return fmt.Errorf("auditoutbox: generate audit log id: %w", err)
	}
	return s.deps.Repository.InsertAuditLog(ctx, AuditLogEntry{
		ID:          id,
		OrgID:       payload.OrgID,
		ActorID:     payload.ActorID,
		Resource:    payload.Resource,
		Action:      payload.Action,
		Metadata:    payload.Metadata,
		HasMetadata: payload.Metadata != nil,
		IPAddress:   payload.IPAddress,
		CreatedAt:   payload.CreatedAt,
	})
}

// markFailure applies the dead threshold and the millisecond backoff from the
// claimed attempts value: round(30000 * 2^max(min(attempt,5)-1,0) *
// (0.5+random())) milliseconds after the failure instant.
func (s *Scheduler) markFailure(ctx context.Context, candidate Candidate, attempts int, cause error) {
	message := cause.Error()
	if attempts >= maxAttempts {
		s.markDead(ctx, candidate, attempts, message)
		return
	}
	availableAt := s.clock().UTC().Truncate(time.Millisecond).Add(s.backoffDelay(attempts))
	if err := s.deps.Repository.MarkFailed(ctx, StatusUpdate{
		ID:          candidate.ID,
		OrgID:       candidate.OrgID,
		Attempts:    attempts,
		Message:     message,
		AvailableAt: availableAt,
	}); err != nil {
		log.Printf(
			"auditoutbox: failed to update outbox status after delivery error outboxId=%s orgId=%s err=%v",
			candidate.ID, candidate.OrgID, err,
		)
	}
}

// markDead parks the row and clears the claim so a replayed batch never picks
// it up again.
func (s *Scheduler) markDead(ctx context.Context, candidate Candidate, attempts int, message string) {
	if err := s.deps.Repository.MarkDead(ctx, StatusUpdate{
		ID:          candidate.ID,
		OrgID:       candidate.OrgID,
		Attempts:    attempts,
		Message:     message,
		AvailableAt: s.clock().UTC().Truncate(time.Millisecond),
	}); err != nil {
		log.Printf(
			"auditoutbox: failed to mark outbox dead outboxId=%s orgId=%s err=%v",
			candidate.ID, candidate.OrgID, err,
		)
	}
}

// backoffDelay renders the exact NestJS formula at millisecond precision.
func (s *Scheduler) backoffDelay(attempt int) time.Duration {
	exponent := attempt
	if exponent > backoffCapAttempt {
		exponent = backoffCapAttempt
	}
	if exponent < 1 {
		exponent = 1
	}
	exponential := float64(retryBaseDelay) * math.Pow(2, float64(exponent-1))
	return time.Duration(math.Round(exponential * (0.5 + s.rand())))
}

// startLockRenew renews the lease about every TTL/3 until the returned stop
// function runs. The returned release function removes the lease with the owner
// token using a background context, so a cancelled tick still releases it.
func (s *Scheduler) startLockRenew(token string) (stop func(), release func()) {
	interval := lockTTL / 3
	if interval <= 0 {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	stopCh := make(chan struct{})
	var once sync.Once

	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-stopCh:
				return
			case <-ticker.C:
				renewCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				_ = s.deps.Locks.RenewLock(renewCtx, lockKey, token, lockTTL)
				cancel()
			}
		}
	}()

	return func() { once.Do(func() { close(stopCh) }) }, func() {
		releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.deps.Locks.ReleaseLock(releaseCtx, lockKey, token)
	}
}

func (s *Scheduler) stopped() bool {
	select {
	case <-s.stop:
		return true
	default:
		return false
	}
}

func (s *Scheduler) clock() time.Time {
	if s != nil && s.deps.Now != nil {
		return s.deps.Now()
	}
	return time.Now()
}

func (s *Scheduler) rand() float64 {
	if s != nil && s.deps.Rand != nil {
		return s.deps.Rand()
	}
	return mathrand.Float64()
}

// nowMillis returns the current UTC instant truncated to milliseconds, because
// every DATETIME(3) column Prisma writes has millisecond precision.
func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// newToken returns a random 16-byte hex owner token for the cron lease.
func newToken() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}

// newRowID generates a client-side identifier in the shape Prisma's cuid()
// produces ('c' plus 24 hex characters) because AuditLog.id has no database
// default in the Go path.
func newRowID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}
