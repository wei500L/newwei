package newseventsingest

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// Scheduler keys and timings mirrored from
// NewsEventsIngestionService and ActiveOrgRegistryService.
const (
	// tickGateKey is the raw Redis key claimSchedulerTick writes (no lock:
	// prefix).
	tickGateKey = "cron:news-events-ingestion:tick-gate"
	// tickGateTTL is NEWS_EVENTS_INGESTION_TICK_GATE_TTL_MS (4m45s).
	tickGateTTL = 4*time.Minute + 45*time.Second
	// orgLockKeyPrefix is the physical organization lock key.
	// CacheService.withLock("cron:news-events-ingestion:org:<id>") adds the
	// "lock:" prefix.
	orgLockKeyPrefix = "lock:cron:news-events-ingestion:org:"
	// orgLockTTL is NEWS_EVENTS_INGESTION_ORG_LOCK_TTL_MS.
	orgLockTTL = 60 * time.Second
	// tickInterval is CronExpression.EVERY_5_MINUTES.
	tickInterval = 5 * time.Minute

	// activeOrgCacheKey and activeOrgCacheTTL mirror ActiveOrgRegistryService.
	activeOrgCacheKey = "org:active:list:v1"
	activeOrgCacheTTL = 15 * time.Second
	// activeOrgLockKey is the physical lock CacheService.wrap creates.
	activeOrgLockKey = "lock:org:active:list:v1"
	// activeOrgLockTTL is the 2 second fill lock.
	activeOrgLockTTL = 2 * time.Second
	// activeOrgRetryDelay and activeOrgWaitBudget mirror the wrap options.
	activeOrgRetryDelay = 50 * time.Millisecond
	activeOrgWaitBudget = 500 * time.Millisecond

	// orgConcurrencyMin and orgConcurrencyMax are the persisted bounds.
	orgConcurrencyMin = 1
	orgConcurrencyMax = 16
)

// Lock scripts are the CacheService.withLock scripts: both check the owner token
// before touching the key, so a lease that expired and was re-acquired by
// another instance is never released or extended by the old owner.
var (
	releaseOrgLockScript = redis.NewScript(`
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`)
	renewOrgLockScript = redis.NewScript(`
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`)
)

// tickGatePayload is the typed tick-gate value.
type tickGatePayload struct {
	ClaimedAt string `json:"claimedAt"`
}

// activeOrgEntry is one entry of the active-org cache.
type activeOrgEntry struct {
	ID string `json:"id"`
}

// OrgConcurrencyReader reads the persisted newsEventsIngestionOrgConcurrency.
type OrgConcurrencyReader interface {
	ReadNewsEventsIngestionOrgConcurrency(ctx context.Context) (int, error)
}

// SchedulerOptions wires the tick loop.
type SchedulerOptions struct {
	// DB is the MySQL pool (organizations, ingestion state, events).
	DB *sql.DB
	// RedisClient holds the tick gate, the organization leases and the active
	// organization cache.
	RedisClient *redis.Client
	// Mongo holds ProcessedItem, TaskLog and newseventclusteringfailures.
	Mongo *mongo.Database
	// Settings reads the per-organization settings.
	Settings SettingsReader
	// Concurrency reads the organization fan-out.
	Concurrency OrgConcurrencyReader
	// Model is the clustering client.
	Model ModelServiceClient
	// Vectors is the best-effort vector client.
	Vectors VectorSearcher
	// Settle is NEWS_EVENTS_INGESTION_SETTLE_MS.
	Settle time.Duration
	// Now is an optional clock for tests.
	Now func() time.Time
}

// orgRunOutcome is the per-organization result.
type orgRunOutcome string

const (
	// orgRunCompleted means ingestOrg ran to the end.
	orgRunCompleted orgRunOutcome = "completed"
	// orgRunSkipped means another owner holds the organization lease.
	orgRunSkipped orgRunOutcome = "skipped"
	// orgRunFailed means ingestOrg returned an error.
	orgRunFailed orgRunOutcome = "failed"
)

// orgRunResult is one settled organization run.
type orgRunResult struct {
	orgID   string
	outcome orgRunOutcome
	err     error
}

// Scheduler owns the five-minute tick, the tick gate and the organization
// leases. Start launches one goroutine; Close stops new ticks, drains in-flight
// organizations and releases their leases before the caller closes Redis/MySQL.
type Scheduler struct {
	options SchedulerOptions
	runner  *ingestRunner

	startOnce sync.Once
	stopOnce  sync.Once
	stop      chan struct{}
	hardStop  context.CancelFunc
	wg        sync.WaitGroup
}

// NewScheduler builds the ingestion scheduler.
func NewScheduler(options SchedulerOptions) *Scheduler {
	settle := options.Settle
	if settle < 0 {
		settle = 0
	}
	store := &store{db: options.DB, mongo: options.Mongo}
	now := options.Now
	return &Scheduler{
		options: options,
		runner: &ingestRunner{
			store:    store,
			settings: options.Settings,
			model:    options.Model,
			vectors:  options.Vectors,
			settle:   settle,
			now:      now,
		},
		stop: make(chan struct{}),
	}
}

// clock returns the current time.
func (s *Scheduler) clock() time.Time {
	if s.options.Now != nil {
		return s.options.Now().UTC()
	}
	return time.Now().UTC()
}

// Start launches the five-minute loop aligned to the wall clock.
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

// Close stops the loop and waits for in-flight organizations, bounded by ctx.
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
		s.cancel()
		return nil
	case <-ctx.Done():
		s.cancel()
		return ctx.Err()
	}
}

// cancel releases the loop context once.
func (s *Scheduler) cancel() {
	if s.hardStop != nil {
		s.hardStop()
	}
}

// loop aligns the first tick to the next five-minute boundary and repeats. A
// delayed tick is re-aligned to the next future boundary instead of replaying
// missed intervals.
func (s *Scheduler) loop(ctx context.Context) {
	next := alignToInterval(s.clock(), tickInterval)
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
				log.Printf("newseventsingest: tick failed: %v", err)
			}
			now := s.clock()
			next = next.Add(tickInterval)
			if !next.After(now) {
				next = alignToInterval(now, tickInterval)
			}
			timer.Reset(time.Until(next))
		}
	}
}

// alignToInterval returns the next multiple of interval after now.
func alignToInterval(now time.Time, interval time.Duration) time.Time {
	truncated := now.Truncate(interval)
	next := truncated.Add(interval)
	if !next.After(now) {
		next = next.Add(interval)
	}
	return next
}

// runTick claims the interval, reads the active organizations and fans them out
// with the persisted concurrency. A failed claim silently skips the interval; a
// Redis failure fails the tick instead of running without the gate.
func (s *Scheduler) runTick(ctx context.Context) error {
	if s == nil || s.options.DB == nil || s.options.RedisClient == nil || s.options.Settings == nil || s.options.Concurrency == nil {
		return errors.New("newseventsingest: scheduler is not fully configured")
	}
	claimed, err := s.claimTick(ctx)
	if err != nil {
		return err
	}
	if !claimed {
		log.Printf("newseventsingest: skipped tick because another instance already claimed this interval")
		return nil
	}

	orgIDs, err := s.listActiveOrgIDs(ctx)
	if err != nil {
		return err
	}
	if len(orgIDs) == 0 {
		return nil
	}
	concurrency, err := s.options.Concurrency.ReadNewsEventsIngestionOrgConcurrency(ctx)
	if err != nil {
		return err
	}
	if concurrency < orgConcurrencyMin || concurrency > orgConcurrencyMax {
		return fmt.Errorf("newseventsingest: organization concurrency %d is outside %d..%d",
			concurrency, orgConcurrencyMin, orgConcurrencyMax)
	}
	log.Printf("newseventsingest: tick started orgCount=%d concurrency=%d", len(orgIDs), concurrency)

	results := s.runOrgs(ctx, orgIDs, concurrency)
	completed, skipped, failed := 0, 0, 0
	for _, result := range results {
		switch result.outcome {
		case orgRunCompleted:
			completed++
		case orgRunSkipped:
			skipped++
		case orgRunFailed:
			failed++
			log.Printf("newseventsingest: org failed orgId=%s err=%v", result.orgID, result.err)
		}
	}
	log.Printf("newseventsingest: tick completed orgCount=%d completed=%d skipped=%d failed=%d",
		len(orgIDs), completed, skipped, failed)
	return nil
}

// claimTick writes the typed tick payload with SET NX EX 285.
func (s *Scheduler) claimTick(ctx context.Context) (bool, error) {
	payload, err := json.Marshal(tickGatePayload{ClaimedAt: isoMillis(s.clock())})
	if err != nil {
		return false, err
	}
	// claimSchedulerTick rounds the TTL up to whole seconds.
	ttlSeconds := int((tickGateTTL + time.Second - 1) / time.Second)
	claimed, err := s.options.RedisClient.SetNX(ctx, tickGateKey, string(payload), time.Duration(ttlSeconds)*time.Second).Result()
	if err != nil {
		return false, fmt.Errorf("newseventsingest: claim tick gate: %w", err)
	}
	return claimed, nil
}

// listActiveOrgIDs reproduces ActiveOrgRegistryService.listActiveOrgs: the named
// Redis cache first, a short fill lock on a miss, and a MySQL fallback on any
// cache or lock failure.
func (s *Scheduler) listActiveOrgIDs(ctx context.Context) ([]string, error) {
	cached, found, cacheErr := s.readActiveOrgCache(ctx)
	if cacheErr != nil {
		log.Printf("newseventsingest: active org cache read failed; falling back to mysql err=%v", cacheErr)
		return s.listActiveOrgIDsFromMySQL(ctx)
	}
	if found {
		return cached, nil
	}

	token, tokenErr := newLockToken()
	if tokenErr != nil {
		return s.listActiveOrgIDsFromMySQL(ctx)
	}
	acquired, lockErr := s.options.RedisClient.SetNX(ctx, activeOrgLockKey, token, activeOrgLockTTL).Result()
	if lockErr != nil {
		log.Printf("newseventsingest: active org cache lock failed; falling back to mysql err=%v", lockErr)
		return s.listActiveOrgIDsFromMySQL(ctx)
	}
	if acquired {
		defer func() {
			releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = releaseOrgLockScript.Run(releaseCtx, s.options.RedisClient, []string{activeOrgLockKey}, token).Err()
		}()
		if cached, found, err := s.readActiveOrgCache(ctx); err == nil && found {
			return cached, nil
		}
		orgIDs, err := s.listActiveOrgIDsFromMySQL(ctx)
		if err != nil {
			return nil, err
		}
		if payload, err := json.Marshal(activeOrgEntries(orgIDs)); err == nil {
			_ = s.options.RedisClient.Set(ctx, activeOrgCacheKey, string(payload), activeOrgCacheTTL).Err()
		}
		return orgIDs, nil
	}

	// Another instance is filling the cache. Wait for the NestJS wrap budget
	// before falling back to a direct database read.
	deadline := time.Now().Add(activeOrgWaitBudget)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
		time.Sleep(activeOrgRetryDelay)
		if cached, found, err := s.readActiveOrgCache(ctx); err == nil && found {
			return cached, nil
		}
	}
	return s.listActiveOrgIDsFromMySQL(ctx)
}

// readActiveOrgCache decodes the named JSON array.
func (s *Scheduler) readActiveOrgCache(ctx context.Context) ([]string, bool, error) {
	raw, err := s.options.RedisClient.Get(ctx, activeOrgCacheKey).Result()
	return decodeActiveOrgCache(raw, err)
}

// decodeActiveOrgCache classifies one Redis GET result.
//
// A missing key is a miss, not a read failure. The NestJS registry resolves the
// list through CacheService.wrap, which treats an absent key as "fill it now";
// reporting redis.Nil as an error instead would skip the fill and send every
// tick of every migrated scheduler to MySQL while logging a cache failure that
// never happened.
func decodeActiveOrgCache(raw string, err error) ([]string, bool, error) {
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	var entries []activeOrgEntry
	if err := json.Unmarshal([]byte(raw), &entries); err != nil {
		return nil, false, err
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.ID != "" {
			ids = append(ids, entry.ID)
		}
	}
	return ids, true, nil
}

// activeOrgEntries converts a typed id list into the named cache shape.
func activeOrgEntries(ids []string) []activeOrgEntry {
	entries := make([]activeOrgEntry, 0, len(ids))
	for _, id := range ids {
		entries = append(entries, activeOrgEntry{ID: id})
	}
	return entries
}

// listActiveOrgIDsFromMySQL runs the Prisma findMany the registry falls back to.
func (s *Scheduler) listActiveOrgIDsFromMySQL(ctx context.Context) ([]string, error) {
	if s.options.DB == nil {
		return nil, errors.New("newseventsingest: mysql is not configured")
	}
	rows, err := s.options.DB.QueryContext(ctx, "SELECT `id` FROM `Org` WHERE `isActive` = true ORDER BY `id` ASC")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	ids := make([]string, 0, 16)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}

// runOrgs limits the fan-out with the persisted concurrency and waits for every
// started organization before returning.
func (s *Scheduler) runOrgs(ctx context.Context, orgIDs []string, concurrency int) []orgRunResult {
	results := make([]orgRunResult, len(orgIDs))
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	for index, orgID := range orgIDs {
		select {
		case <-s.stop:
			results[index] = orgRunResult{orgID: orgID, outcome: orgRunSkipped}
			continue
		case <-ctx.Done():
			results[index] = orgRunResult{orgID: orgID, outcome: orgRunFailed, err: ctx.Err()}
			continue
		case sem <- struct{}{}:
		}
		select {
		case <-s.stop:
			<-sem
			results[index] = orgRunResult{orgID: orgID, outcome: orgRunSkipped}
			continue
		default:
		}
		wg.Add(1)
		go func(index int, orgID string) {
			defer wg.Done()
			defer func() { <-sem }()
			results[index] = s.runOrgWithLock(ctx, orgID)
		}(index, orgID)
	}
	wg.Wait()
	return results
}

// runOrgWithLock acquires the per-organization lease, keeps it renewed while the
// organization is processed and releases it with the owner token. A lease held by
// another instance returns skipped. Because the loop is not offered another run
// until the lease is free, an overlapping instance sees the same key and skips.
func (s *Scheduler) runOrgWithLock(ctx context.Context, orgID string) orgRunResult {
	token, err := newLockToken()
	if err != nil {
		return orgRunResult{orgID: orgID, outcome: orgRunFailed, err: err}
	}
	lockKey := orgLockKeyPrefix + orgID
	acquired, err := s.options.RedisClient.SetNX(ctx, lockKey, token, orgLockTTL).Result()
	if err != nil {
		return orgRunResult{orgID: orgID, outcome: orgRunFailed, err: err}
	}
	if !acquired {
		log.Printf("newseventsingest: skipped org because previous run is still in progress orgId=%s", orgID)
		return orgRunResult{orgID: orgID, outcome: orgRunSkipped}
	}
	stopRenew := s.startOrgLockRenew(lockKey, token)
	defer func() {
		stopRenew()
		// Release with a short background context: the run context may already be
		// cancelled during shutdown, but the lease must still be removed while the
		// token matches.
		releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = releaseOrgLockScript.Run(releaseCtx, s.options.RedisClient, []string{lockKey}, token).Err()
	}()

	if err := s.runner.ingestOrg(ctx, orgID); err != nil {
		return orgRunResult{orgID: orgID, outcome: orgRunFailed, err: err}
	}
	return orgRunResult{orgID: orgID, outcome: orgRunCompleted}
}

// startOrgLockRenew renews the lease about every TTL/3 until the returned stop
// function runs. The renewal keeps running while an in-flight organization
// drains, so a shutdown never lets the lease expire under a running run.
func (s *Scheduler) startOrgLockRenew(key, token string) func() {
	interval := orgLockTTL / 3
	if interval < 500*time.Millisecond {
		interval = 500 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				renewCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				_ = renewOrgLockScript.Run(renewCtx, s.options.RedisClient,
					[]string{key}, token, strconv.FormatInt(orgLockTTL.Milliseconds(), 10)).Err()
				cancel()
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			close(stop)
			<-done
		})
	}
}

// newLockToken produces the random UUID the NestJS CacheService uses as the lock
// owner token.
func newLockToken() (string, error) {
	var buffer [16]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	buffer[6] = (buffer[6] & 0x0f) | 0x40
	buffer[8] = (buffer[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(buffer[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32], nil
}
