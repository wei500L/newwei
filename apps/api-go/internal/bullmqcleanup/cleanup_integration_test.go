//go:build integration

package bullmqcleanup

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/cronlock"
)

const (
	integrationNow = int64(1_700_000_000_000)
	dayMillis      = int64(24 * 60 * 60 * 1000)
)

func integrationRedis(t *testing.T) *redis.Client {
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
	return client
}

// seedFailed writes a failed-sorted-set entry plus the job hash. The sorted-set
// score is finishedOn, which is what cleanJobsInSet compares to the cutoff.
func seedFailed(t *testing.T, client *redis.Client, queue, id string, finishedOn int64) {
	t.Helper()
	ctx := context.Background()
	key := queueKeys(queue)
	if err := client.HSet(ctx, key+id, "timestamp", finishedOn, "name", "seed").Err(); err != nil {
		t.Fatalf("seed hash %s: %v", id, err)
	}
	if err := client.ZAdd(ctx, key+"failed", redis.Z{Score: float64(finishedOn), Member: id}).Err(); err != nil {
		t.Fatalf("seed failed zset %s: %v", id, err)
	}
}

// seedWaiting writes a waiting-list entry plus the job hash. The list is stored
// newest-first, matching BullMQ's LPUSH order; timestamp is the age field the
// clean script checks after finishedOn/processedOn.
func seedWaiting(t *testing.T, client *redis.Client, queue, id string, timestamp int64) {
	t.Helper()
	ctx := context.Background()
	key := queueKeys(queue)
	if err := client.HSet(ctx, key+id, "timestamp", timestamp, "name", "seed").Err(); err != nil {
		t.Fatalf("seed hash %s: %v", id, err)
	}
	if err := client.RPush(ctx, key+"wait", id).Err(); err != nil {
		t.Fatalf("seed wait %s: %v", id, err)
	}
}

func fixedNow() int64 { return integrationNow }

// TestBullmqCleanupIntegration proves the age clean, the count trim, the
// waiting-list ordering, the oldest-first page and per-queue error isolation
// against a real Redis 7.2 with the vendored BullMQ 5.63.2 scripts.
func TestBullmqCleanupIntegration(t *testing.T) {
	client := integrationRedis(t)
	ctx := context.Background()

	age := StateRetention{AgeSeconds: 7 * 24 * 60 * 60, Count: 1_000}
	count := StateRetention{AgeSeconds: 7 * 24 * 60 * 60, Count: 5}
	waitAge := StateRetention{AgeSeconds: 30 * 24 * 60 * 60, Count: 1_000}
	waitCount := StateRetention{AgeSeconds: 30 * 24 * 60 * 60, Count: 3}
	specs := []QueueSpec{
		{Name: "it-age", Failed: &age},
		{Name: "it-count", Failed: &count},
		{Name: "it-wait-age", Waiting: &waitAge},
		{Name: "it-wait-count", Waiting: &waitCount},
		{Name: "it-broken", Failed: &age},
	}

	// Age: 8 days old are deleted, 1 hour old survive.
	for index := 0; index < 3; index++ {
		seedFailed(t, client, "it-age", fmt.Sprintf("old-%d", index), integrationNow-8*dayMillis)
	}
	for index := 0; index < 2; index++ {
		seedFailed(t, client, "it-age", fmt.Sprintf("fresh-%d", index),
			integrationNow-60*60*1000+int64(index)*1000)
	}

	// Count: 15 fresh failed jobs keep the 5 newest (count-00..count-04).
	for index := 0; index < 15; index++ {
		seedFailed(t, client, "it-count", fmt.Sprintf("count-%02d", index),
			integrationNow-int64(index)*1000)
	}

	// Waiting age: all four are older than 30 days.
	for index := 0; index < 4; index++ {
		seedWaiting(t, client, "it-wait-age", fmt.Sprintf("wait-old-%d", index),
			integrationNow-31*dayMillis)
	}

	// Waiting count: 10 fresh entries, newest first; the 3 newest survive.
	for index := 0; index < 10; index++ {
		seedWaiting(t, client, "it-wait-count", fmt.Sprintf("wait-%02d", index),
			integrationNow-int64(index)*1000)
	}

	// A wrong-type state key must fail only its own queue.
	if err := client.Set(ctx, queueKeys("it-broken")+"failed", "not-a-zset", 0).Err(); err != nil {
		t.Fatalf("break queue: %v", err)
	}

	cleaner := NewCleanerForTest(client, specs, fixedNow)
	if err := cleaner.CleanAll(ctx); err != nil {
		t.Fatalf("CleanAll: %v", err)
	}

	// Age queue: old gone, fresh kept.
	assertMembers(t, client, queueKeys("it-age")+"failed", []string{"fresh-0", "fresh-1"})
	for index := 0; index < 3; index++ {
		if exists(t, client, queueKeys("it-age")+fmt.Sprintf("old-%d", index)) {
			t.Fatalf("old-%d hash must be deleted", index)
		}
	}

	// Count queue: exactly the five newest remain, oldest-first removal order.
	wantKept := []string{"count-04", "count-03", "count-02", "count-01", "count-00"}
	assertMembers(t, client, queueKeys("it-count")+"failed", wantKept)
	for index := 5; index < 15; index++ {
		if exists(t, client, queueKeys("it-count")+fmt.Sprintf("count-%02d", index)) {
			t.Fatalf("count-%02d hash must be deleted", index)
		}
	}

	// Waiting age: list and hashes are empty.
	if members := listRange(t, client, queueKeys("it-wait-age")+"wait"); len(members) != 0 {
		t.Fatalf("waiting age list = %v, want empty", members)
	}

	// Waiting count: the three newest survive in list order.
	assertList(t, client, queueKeys("it-wait-count")+"wait",
		[]string{"wait-00", "wait-01", "wait-02"})
	for index := 3; index < 10; index++ {
		if exists(t, client, queueKeys("it-wait-count")+fmt.Sprintf("wait-%02d", index)) {
			t.Fatalf("wait-%02d hash must be deleted", index)
		}
	}
}

// TestBullmqCleanupLockedJobIsSkipped proves the removeJob script's lock guard:
// a locked failed job is not removed by the count trim, while the page budget is
// still consumed (NestJS Promise.allSettled behaves the same).
func TestBullmqCleanupLockedJobIsSkipped(t *testing.T) {
	client := integrationRedis(t)
	ctx := context.Background()

	retention := StateRetention{AgeSeconds: 7 * 24 * 60 * 60, Count: 1}
	seedFailed(t, client, "it-locked", "locked-job", integrationNow-60*1000)
	seedFailed(t, client, "it-locked", "free-job", integrationNow-30*1000)
	if err := client.Set(ctx, queueKeys("it-locked")+"locked-job:lock", "owner", 0).Err(); err != nil {
		t.Fatalf("set lock: %v", err)
	}

	cleaner := NewCleanerForTest(client, []QueueSpec{
		{Name: "it-locked", Failed: &retention},
	}, fixedNow)
	if err := cleaner.CleanAll(ctx); err != nil {
		t.Fatalf("CleanAll: %v", err)
	}

	// The trim page is the oldest job (locked). removeJob refuses it, the page
	// budget is consumed, and the loop stops: both jobs survive, exactly like
	// the NestJS Promise.allSettled loop.
	if !exists(t, client, queueKeys("it-locked")+"locked-job") {
		t.Fatal("locked job must not be removed")
	}
	if !exists(t, client, queueKeys("it-locked")+"free-job") {
		t.Fatal("the free job was not in the first page and stays")
	}
}

// TestBullmqCleanupLeaseIntegration proves B1 deterministically: while one
// instance holds the real Redis lease, a second Scheduler performs no cycle at
// all; once the lease is released the next cycle runs.
func TestBullmqCleanupLeaseIntegration(t *testing.T) {
	client := integrationRedis(t)
	ctx := context.Background()

	retention := StateRetention{AgeSeconds: 7 * 24 * 60 * 60, Count: 1_000}
	seedFailed(t, client, "it-lease", "old", integrationNow-8*dayMillis)
	seedFailed(t, client, "it-lease", "fresh", integrationNow-1000)
	specs := []QueueSpec{{Name: "it-lease", Failed: &retention}}

	holder := cronlock.New(client)
	held := make(chan struct{})
	release := make(chan struct{})
	holderResult := make(chan bool, 1)
	go func() {
		acquired, err := holder.WithLock(ctx, "cron:bullmq-retained-cleanup", 55*time.Minute, func(context.Context) error {
			close(held)
			<-release
			return nil
		})
		if err != nil {
			t.Errorf("holder: %v", err)
		}
		holderResult <- acquired
	}()
	select {
	case <-held:
	case <-time.After(3 * time.Second):
		t.Fatal("holder did not acquire the lease")
	}

	scheduler := NewScheduler(NewCleanerForTest(client, specs, fixedNow), cronlock.New(client))
	acquired, err := scheduler.RunOnce(ctx)
	if err != nil {
		t.Fatalf("contended RunOnce: %v", err)
	}
	if acquired {
		t.Fatal("a second instance must not acquire the lease while it is held")
	}
	if !exists(t, client, queueKeys("it-lease")+"old") {
		t.Fatal("the contended instance must not clean anything")
	}

	close(release)
	if !<-holderResult {
		t.Fatal("holder did not report acquisition")
	}

	acquired, err = scheduler.RunOnce(ctx)
	if err != nil {
		t.Fatalf("RunOnce after release: %v", err)
	}
	if !acquired {
		t.Fatal("the lease must be acquirable after release")
	}
	if exists(t, client, queueKeys("it-lease")+"old") {
		t.Fatal("the winning cycle must delete the old job")
	}
	if !exists(t, client, queueKeys("it-lease")+"fresh") {
		t.Fatal("the fresh job must survive")
	}
}

func exists(t *testing.T, client *redis.Client, key string) bool {
	t.Helper()
	count, err := client.Exists(context.Background(), key).Result()
	if err != nil {
		t.Fatalf("exists %s: %v", key, err)
	}
	return count > 0
}

func listRange(t *testing.T, client *redis.Client, key string) []string {
	t.Helper()
	values, err := client.LRange(context.Background(), key, 0, -1).Result()
	if err != nil {
		t.Fatalf("lrange %s: %v", key, err)
	}
	return values
}

func assertList(t *testing.T, client *redis.Client, key string, want []string) {
	t.Helper()
	got := listRange(t, client, key)
	if len(got) != len(want) {
		t.Fatalf("list %s = %v, want %v", key, got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("list %s = %v, want %v", key, got, want)
		}
	}
}

func assertMembers(t *testing.T, client *redis.Client, key string, want []string) {
	t.Helper()
	got, err := client.ZRange(context.Background(), key, 0, -1).Result()
	if err != nil {
		t.Fatalf("zrange %s: %v", key, err)
	}
	if len(got) != len(want) {
		t.Fatalf("zset %s = %v, want %v", key, got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("zset %s = %v, want %v", key, got, want)
		}
	}
}
