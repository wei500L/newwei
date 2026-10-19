//go:build integration

// Integration tests of the Redis locks used by the news backfill schedulers.
// They run against the Redis service of the existing api-go integration job
// and skip when API_GO_TEST_REDIS_ADDR is absent.
package newsbackfilljobs

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func testRedisClient(t *testing.T) *redis.Client {
	t.Helper()
	addr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if addr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR not set — integration test requires a Redis service")
	}
	client := redis.NewClient(&redis.Options{Addr: addr})
	if err := client.Ping(context.Background()).Err(); err != nil {
		t.Fatalf("redis ping: %v", err)
	}
	return client
}

func TestIntegrationScanLockIsExclusiveAndReleased(t *testing.T) {
	client := testRedisClient(t)
	defer client.Close()
	ctx := context.Background()
	key := "lock:cron:news-event-clustering-recovery:integration"
	client.Del(ctx, key)
	defer client.Del(ctx, key)

	first, err := acquireRedisLock(ctx, client, key, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if first == nil {
		t.Fatal("first acquisition failed")
	}
	second, err := acquireRedisLock(ctx, client, key, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if second != nil {
		t.Fatal("second acquisition must fail while the first is held")
	}
	first.Release()
	third, err := acquireRedisLock(ctx, client, key, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if third == nil {
		t.Fatal("acquisition after release failed")
	}
	third.Release()
	if exists, err := client.Exists(ctx, key).Result(); err != nil || exists != 0 {
		t.Fatalf("lock key still exists exists=%d err=%v", exists, err)
	}
}

func TestIntegrationLockRenewalKeepsTheLease(t *testing.T) {
	client := testRedisClient(t)
	defer client.Close()
	ctx := context.Background()
	key := "lock:cron:news-event-clustering-recovery:renew-integration"
	client.Del(ctx, key)
	defer client.Del(ctx, key)

	lock, err := acquireRedisLock(ctx, client, key, 1100*time.Millisecond)
	if err != nil || lock == nil {
		t.Fatalf("acquire: %v", err)
	}
	defer lock.Release()
	time.Sleep(1600 * time.Millisecond)
	// The lease would have expired without the renewal goroutine.
	if ttl, err := client.PTTL(ctx, key).Result(); err != nil || ttl <= 0 {
		t.Fatalf("lease expired or missing: ttl=%v err=%v", ttl, err)
	}
	other, err := acquireRedisLock(ctx, client, key, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if other != nil {
		t.Fatal("a renewed lease must not be stealable")
	}
}

func TestIntegrationSchedulerTickGateIsClaimedOnce(t *testing.T) {
	client := testRedisClient(t)
	defer client.Close()
	ctx := context.Background()
	key := "cron:news-indicator-association:tick-gate:integration"
	client.Del(ctx, key)
	defer client.Del(ctx, key)

	now := time.Date(2026, 10, 20, 6, 0, 0, 0, time.UTC)
	claimed, err := claimSchedulerTick(ctx, client, key, 5*time.Hour+55*time.Minute, now)
	if err != nil || !claimed {
		t.Fatalf("first claim = %t err=%v", claimed, err)
	}
	claimed, err = claimSchedulerTick(ctx, client, key, 5*time.Hour+55*time.Minute, now)
	if err != nil {
		t.Fatal(err)
	}
	if claimed {
		t.Fatal("second claim must fail")
	}
	payload, err := client.Get(ctx, key).Result()
	if err != nil {
		t.Fatal(err)
	}
	if payload != `{"claimedAt":"2026-10-20T06:00:00.000Z"}` {
		t.Fatalf("payload = %s", payload)
	}
	ttl, err := client.TTL(ctx, key).Result()
	if err != nil {
		t.Fatal(err)
	}
	if ttl <= 0 || ttl > 5*time.Hour+55*time.Minute {
		t.Fatalf("ttl = %v", ttl)
	}
}

func TestIntegrationSchedulerLockKeyShapes(t *testing.T) {
	if got := scanLockKey; got != "lock:cron:news-event-clustering-recovery" {
		t.Fatalf("scan lock key = %q", got)
	}
	if got := associationTickGateKey; got != "cron:news-indicator-association:tick-gate" {
		t.Fatalf("tick gate key = %q", got)
	}
	if got := associationOrgLockKeyPrefix + "org-1"; got != "lock:cron:news-indicator-association:org:org-1" {
		t.Fatalf("org lock key = %q", got)
	}
}
