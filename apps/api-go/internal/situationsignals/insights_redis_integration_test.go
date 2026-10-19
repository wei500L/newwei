//go:build integration

package situationsignals

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

type insightsRedisFixture struct {
	Value int `json:"value"`
}

func TestInsightsRedisIntegration(t *testing.T) {
	addr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if addr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR not set")
	}
	client := redis.NewClient(&redis.Options{Addr: addr, DB: 0, Protocol: 2})
	defer client.Close()
	ctx := context.Background()
	if err := client.Ping(ctx).Err(); err != nil {
		t.Fatalf("redis ping: %v", err)
	}
	cache := newInsightsCache(client)
	key := "situation-monitor:insights:v2:core:integration-org:wh72:mi400:scall:gd1:dbg0:lr0"
	_ = client.Del(ctx, key, "lock:"+key)

	loaderCalls := 0
	value, err := insightsWrap(ctx, cache, key, 45*time.Second, func(context.Context) (insightsRedisFixture, error) {
		loaderCalls++
		return insightsRedisFixture{Value: 1}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if value.Value != 1 || loaderCalls != 1 {
		t.Fatalf("first wrap = %+v calls=%d", value, loaderCalls)
	}
	raw, err := client.Get(ctx, key).Result()
	if err != nil {
		t.Fatal(err)
	}
	if raw != `{"value":1}` {
		t.Fatalf("cached payload = %q", raw)
	}
	ttl, err := client.TTL(ctx, key).Result()
	if err != nil || ttl <= 0 || ttl > 45*time.Second {
		t.Fatalf("ttl = %s err=%v", ttl, err)
	}
	value, err = insightsWrap(ctx, cache, key, 45*time.Second, func(context.Context) (insightsRedisFixture, error) {
		loaderCalls++
		return insightsRedisFixture{Value: 2}, nil
	})
	if err != nil || value.Value != 1 || loaderCalls != 1 {
		t.Fatalf("second wrap = %+v err=%v calls=%d", value, err, loaderCalls)
	}
	if exists, err := client.Exists(ctx, "lock:"+key).Result(); err != nil || exists != 0 {
		t.Fatalf("lock exists = %d err=%v", exists, err)
	}

	// A competing lock must make wrap wait for the other worker's cache entry
	// instead of executing the loader.
	_ = client.Del(ctx, key)
	if err := client.Set(ctx, "lock:"+key, "other", 2*time.Second).Err(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		time.Sleep(120 * time.Millisecond)
		_ = client.Set(ctx, key, `{"value":7}`, 45*time.Second).Err()
		close(done)
	}()
	value, err = insightsWrap(ctx, cache, key, 45*time.Second, func(context.Context) (insightsRedisFixture, error) {
		loaderCalls++
		return insightsRedisFixture{Value: 99}, nil
	})
	if err != nil || value.Value != 7 || loaderCalls != 1 {
		t.Fatalf("waiting wrap = %+v err=%v calls=%d", value, err, loaderCalls)
	}
	<-done
	_ = client.Del(ctx, key, "lock:"+key)
}

func TestInsightsRedisKeyConstants(t *testing.T) {
	if insightsCorrelationTTLSeconds != 2700 {
		t.Fatalf("correlation ttl = %d", insightsCorrelationTTLSeconds)
	}
	if !strings.HasPrefix(insightsCacheKey("o", "core", 1, 50, "all", true, true, 1), "situation-monitor:insights:v2:core:") {
		t.Fatal("core key prefix")
	}
	if insightsCacheKey("o", "external", 1, 50, "all", true, true, 1) != "situation-monitor:insights:v2:external:o" {
		t.Fatal("external key")
	}
}
