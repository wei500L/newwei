//go:build integration

// Integration tests for the queue organization-stats tracker against a real
// Redis 7.2. They replay the BullMQ wire format the itemPipeline queue writes
// (`bull:itemPipeline:events` entries and the `bull:itemPipeline:<jobId>` hash)
// and assert the counters and the `queue:itemPipeline:job:<jobId>:meta` hashes
// the NestJS readers consume.
//
// Environment (CI injects it; a missing value skips the test):
//
//	API_GO_TEST_REDIS_ADDR=127.0.0.1:6379
package queueorgstats

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/cronlock"
)

const (
	itRetainedOpts    = `{"removeOnComplete":{"age":604800,"count":10000},"removeOnFail":{"age":604800,"count":10000}}`
	itNotRetainedOpts = `{"removeOnComplete":true,"removeOnFail":{"age":604800,"count":10000}}`
	itWaitTimeout     = 5 * time.Second
)

// integrationRedis flushes the test database and returns a command client plus
// its address. Flushing mirrors internal/bullmqcleanup: the CI service is
// ephemeral and every integration package owns its Redis database.
func integrationRedis(t *testing.T) (*redis.Client, string) {
	t.Helper()
	address := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if address == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR is not set")
	}
	client := redis.NewClient(&redis.Options{Addr: address, Protocol: 2})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		t.Fatalf("redis ping: %v", err)
	}
	if err := client.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("redis flush: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client, address
}

// integrationOrgID returns a per-run organization id so a leftover key from a
// previous run can never satisfy an assertion.
func integrationOrgID(t *testing.T) string {
	t.Helper()
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		t.Fatalf("random org id: %v", err)
	}
	return "org-it-queueorgstats-" + hex.EncodeToString(buf[:])
}

// seedJob writes the BullMQ job hash: `data` is the payload JSON, `opts` the
// resolved JobsOptions JSON (both are JSON in the BullMQ job hash).
func seedJob(t *testing.T, client *redis.Client, jobID, data, opts string) {
	t.Helper()
	ctx := context.Background()
	err := client.HSet(ctx, queueKeys.Job(jobID),
		"name", "process-item",
		"data", data,
		"opts", opts,
		"timestamp", "1700000000000",
	).Err()
	if err != nil {
		t.Fatalf("seed job %s: %v", jobID, err)
	}
}

// publishEvent appends one BullMQ event stream entry. BullMQ writes `event` and
// `jobId` on every entry; the remaining fields are irrelevant to the tracker.
func publishEvent(t *testing.T, client *redis.Client, event, jobID string) {
	t.Helper()
	err := client.XAdd(context.Background(), &redis.XAddArgs{
		Stream: queueKeys.Events,
		Values: map[string]any{"event": event, "jobId": jobID},
	}).Err()
	if err != nil {
		t.Fatalf("publish %s for %s: %v", event, jobID, err)
	}
}

// readCounts reads the five count fields, missing fields counting as zero.
func readCounts(t *testing.T, client *redis.Client, orgID string) map[JobStatus]int64 {
	t.Helper()
	values, err := client.HMGet(context.Background(), countsKey(orgID),
		string(JobStatusWaiting), string(JobStatusActive), string(JobStatusCompleted),
		string(JobStatusFailed), string(JobStatusDelayed)).Result()
	if err != nil {
		t.Fatalf("read counts of %s: %v", orgID, err)
	}
	counts := map[JobStatus]int64{}
	for index, status := range []JobStatus{
		JobStatusWaiting, JobStatusActive, JobStatusCompleted, JobStatusFailed, JobStatusDelayed,
	} {
		var raw string
		if index < len(values) {
			raw = redisString(values[index])
		}
		if raw == "" {
			continue
		}
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			t.Fatalf("count field %s of %s is not an integer: %q", status, orgID, raw)
		}
		counts[status] = parsed
	}
	return counts
}

// waitForCounts waits until the five counters equal want; a field omitted from
// want is not asserted.
func waitForCounts(t *testing.T, client *redis.Client, orgID string, want map[JobStatus]int64) {
	t.Helper()
	deadline := time.Now().Add(itWaitTimeout)
	for {
		counts := readCounts(t, client, orgID)
		matches := true
		for status, value := range want {
			if counts[status] != value {
				matches = false
				break
			}
		}
		if matches {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("counts of %s = %v, want %v", orgID, counts, want)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// waitForLease waits until a tracker holds the single-owner lease.
func waitForLease(t *testing.T, client *redis.Client) {
	t.Helper()
	deadline := time.Now().Add(itWaitTimeout)
	for {
		exists, err := client.Exists(context.Background(), "lock:"+lockName).Result()
		if err == nil && exists == 1 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("no tracker acquired the %s lease within %s", lockName, itWaitTimeout)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// waitForStreamReader waits until one connection of the server is parked in the
// blocking XREAD of the event stream. Publishing before that would land in the
// gap between the lease acquisition and the first XREAD, which starts at `$` and
// would therefore skip the entry (the documented handover gap).
func waitForStreamReader(t *testing.T, client *redis.Client) {
	t.Helper()
	deadline := time.Now().Add(itWaitTimeout)
	for {
		lines, err := client.ClientList(context.Background()).Result()
		if err == nil {
			for _, line := range strings.Split(lines, "\n") {
				if strings.Contains(line, "cmd=xread") {
					return
				}
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no connection was parked in XREAD within %s", itWaitTimeout)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// startIntegrationTracker builds and starts the production tracker, and closes
// it when the test ends.
func startIntegrationTracker(t *testing.T, client *redis.Client, address string) *Tracker {
	t.Helper()
	tracker, err := New(Options{
		Redis:           client,
		BlockingOptions: &redis.Options{Addr: address, Protocol: 2},
		Logger:          log.New(testWriter{t}, "queueorgstats-it: ", 0),
	})
	if err != nil {
		t.Fatalf("build tracker: %v", err)
	}
	if err := tracker.Start(context.Background()); err != nil {
		t.Fatalf("start tracker: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := tracker.Close(ctx); err != nil {
			t.Errorf("close tracker: %v", err)
		}
	})
	return tracker
}

// testWriter routes the tracker log lines to the test log.
type testWriter struct{ t *testing.T }

func (w testWriter) Write(p []byte) (int, error) {
	w.t.Logf("%s", strings.TrimSpace(string(p)))
	return len(p), nil
}

// countingStore counts the stream reads of one tracker. The second tracker of
// the single-owner test must never read the stream.
type countingStore struct {
	Store
	reads atomic.Int64
}

func (s *countingStore) ReadStream(ctx context.Context, lastID string, count int64, block time.Duration) ([]StreamEvent, error) {
	s.reads.Add(1)
	return s.Store.ReadStream(ctx, lastID, count, block)
}

func (s *countingStore) readCount() int64 { return s.reads.Load() }

// TestQueueOrgStatsIntegrationTransitions replays waiting -> active -> completed
// for a retained job and asserts the counters and the meta hash.
func TestQueueOrgStatsIntegrationTransitions(t *testing.T) {
	client, address := integrationRedis(t)
	orgID := integrationOrgID(t)
	jobID := "it-transition-job"
	startIntegrationTracker(t, client, address)
	waitForLease(t, client)
	waitForStreamReader(t, client)

	seedJob(t, client, jobID, `{"orgId":"`+orgID+`","pipelineJobId":"pipe-1"}`, itRetainedOpts)
	publishEvent(t, client, eventWaiting, jobID)
	waitForCounts(t, client, orgID, map[JobStatus]int64{JobStatusWaiting: 1})

	publishEvent(t, client, eventActive, jobID)
	waitForCounts(t, client, orgID, map[JobStatus]int64{JobStatusWaiting: 0, JobStatusActive: 1})

	publishEvent(t, client, eventCompleted, jobID)
	waitForCounts(t, client, orgID, map[JobStatus]int64{
		JobStatusWaiting: 0, JobStatusActive: 0, JobStatusCompleted: 1,
	})

	meta, err := client.HGetAll(context.Background(), metaKey(jobID)).Result()
	if err != nil {
		t.Fatalf("read meta: %v", err)
	}
	if meta[metaFieldOrgID] != orgID || meta[metaFieldStatus] != string(JobStatusCompleted) {
		t.Fatalf("meta = %v, want orgId=%s status=completed", meta, orgID)
	}
	if meta[metaFieldKeepCompleted] != keepFlagTrue || meta[metaFieldKeepFailed] != keepFlagTrue {
		t.Fatalf("meta keep flags = %v, want both retained", meta)
	}
	metaTTL, err := client.TTL(context.Background(), metaKey(jobID)).Result()
	if err != nil {
		t.Fatalf("meta ttl: %v", err)
	}
	if metaTTL <= 0 || metaTTL > time.Duration(metaTTLSeconds)*time.Second {
		t.Fatalf("meta ttl = %s, want a positive value at most %ds", metaTTL, metaTTLSeconds)
	}
	countsTTL, err := client.TTL(context.Background(), countsKey(orgID)).Result()
	if err != nil {
		t.Fatalf("counts ttl: %v", err)
	}
	if countsTTL <= 0 || countsTTL > time.Duration(countsTTLSeconds)*time.Second {
		t.Fatalf("counts ttl = %s, want a positive value at most %ds", countsTTL, countsTTLSeconds)
	}
}

// TestQueueOrgStatsIntegrationTerminalWithoutRetention proves the
// TERMINAL_AND_REMOVE path: the completed counter is incremented, the meta hash
// is dropped, and a following `removed` event does not decrement the counter a
// second time.
func TestQueueOrgStatsIntegrationTerminalWithoutRetention(t *testing.T) {
	client, address := integrationRedis(t)
	orgID := integrationOrgID(t)
	jobID := "it-terminal-job"
	startIntegrationTracker(t, client, address)
	waitForLease(t, client)
	waitForStreamReader(t, client)

	seedJob(t, client, jobID, `{"orgId":"`+orgID+`"}`, itNotRetainedOpts)
	publishEvent(t, client, eventWaiting, jobID)
	waitForCounts(t, client, orgID, map[JobStatus]int64{JobStatusWaiting: 1})
	publishEvent(t, client, eventActive, jobID)
	waitForCounts(t, client, orgID, map[JobStatus]int64{JobStatusWaiting: 0, JobStatusActive: 1})

	publishEvent(t, client, eventCompleted, jobID)
	waitForCounts(t, client, orgID, map[JobStatus]int64{
		JobStatusActive: 0, JobStatusCompleted: 1,
	})
	exists, err := client.Exists(context.Background(), metaKey(jobID)).Result()
	if err != nil {
		t.Fatalf("meta exists: %v", err)
	}
	if exists != 0 {
		t.Fatal("a completed job without retention must drop its meta hash")
	}

	// The job hash and the queue entry are gone in BullMQ; the `removed` event
	// must be a no-op because there is no meta to decrement.
	if err := client.Del(context.Background(), queueKeys.Job(jobID)).Err(); err != nil {
		t.Fatalf("delete job hash: %v", err)
	}
	publishEvent(t, client, eventRemoved, jobID)
	time.Sleep(200 * time.Millisecond)
	waitForCounts(t, client, orgID, map[JobStatus]int64{
		JobStatusActive: 0, JobStatusCompleted: 1, JobStatusWaiting: 0,
	})
}

// TestQueueOrgStatsIntegrationSingleOwner proves the lease exclusivity: two
// trackers compete for `lock:queue:itemPipeline:orgstats`, only the owner reads
// the stream, and the waiter takes over once the owner releases the lease.
func TestQueueOrgStatsIntegrationSingleOwner(t *testing.T) {
	client, address := integrationRedis(t)
	orgID := integrationOrgID(t)

	ownerStore := &countingStore{Store: newRedisStore(client, redis.NewClient(&redis.Options{Addr: address, Protocol: 2}))}
	waiterStore := &countingStore{Store: newRedisStore(client, redis.NewClient(&redis.Options{Addr: address, Protocol: 2}))}
	logger := log.New(testWriter{t}, "queueorgstats-it: ", 0)
	owner := newTracker(ownerStore, cronlock.New(client), logger, true)
	waiter := newTracker(waiterStore, cronlock.New(client), logger, true)
	waiter.retryDelay = 100 * time.Millisecond
	waiter.readRetryDelay = 100 * time.Millisecond
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = waiter.Close(ctx)
	})

	if err := owner.Start(context.Background()); err != nil {
		t.Fatalf("start owner tracker: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := owner.Close(ctx); err != nil {
			t.Errorf("close owner tracker: %v", err)
		}
	})
	waitForLease(t, client)
	waitForStreamReader(t, client)

	if err := waiter.Start(context.Background()); err != nil {
		t.Fatalf("start waiting tracker: %v", err)
	}
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if waiterStore.readCount() != 0 {
			t.Fatal("the tracker that did not acquire the lease must not read the event stream")
		}
		time.Sleep(20 * time.Millisecond)
	}

	jobID := "it-owner-job"
	seedJob(t, client, jobID, `{"orgId":"`+orgID+`"}`, itRetainedOpts)
	publishEvent(t, client, eventWaiting, jobID)
	waitForCounts(t, client, orgID, map[JobStatus]int64{JobStatusWaiting: 1})
	if ownerStore.readCount() == 0 {
		t.Fatal("the lease owner must read the event stream")
	}

	// Releasing the lease lets the waiter take over and count new events.
	if err := owner.Close(context.Background()); err != nil {
		t.Fatalf("close owner tracker: %v", err)
	}
	deadline = time.Now().Add(itWaitTimeout)
	for waiterStore.readCount() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the waiting tracker did not take over the lease after the owner stopped")
		}
		time.Sleep(20 * time.Millisecond)
	}
	waitForStreamReader(t, client)
	handoverJobID := "it-handover-job"
	seedJob(t, client, handoverJobID, `{"orgId":"`+orgID+`"}`, itRetainedOpts)
	publishEvent(t, client, eventWaiting, handoverJobID)
	waitForCounts(t, client, orgID, map[JobStatus]int64{JobStatusWaiting: 2})
}
