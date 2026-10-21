package socketio

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestNewLimiterDefaults(t *testing.T) {
	limiter := NewLimiter(nil, 0, 0, 0)
	if limiter.limitPerIP != 60 {
		t.Fatalf("limitPerIP = %d, want 60", limiter.limitPerIP)
	}
	if limiter.limitPerUser != 30 {
		t.Fatalf("limitPerUser = %d, want 30", limiter.limitPerUser)
	}
	if limiter.windowSeconds != 60 {
		t.Fatalf("windowSeconds = %d, want 60", limiter.windowSeconds)
	}
	if limiter.timeout != limiterRedisTimeout {
		t.Fatalf("timeout = %v, want %v", limiter.timeout, limiterRedisTimeout)
	}

	configured := NewLimiter(nil, 10, 5, 30)
	if configured.limitPerIP != 10 || configured.limitPerUser != 5 || configured.windowSeconds != 30 {
		t.Fatalf("configured limiter = %#v", configured)
	}
}

func TestLimiterKeysMatchNest(t *testing.T) {
	keys := rateLimitKeys("ws:connect:ip:203.0.113.9")
	want := []string{"rate:ws:connect:ip:203.0.113.9", "rate:ws:connect:ip:203.0.113.9:seq"}
	if len(keys) != len(want) || keys[0] != want[0] || keys[1] != want[1] {
		t.Fatalf("rateLimitKeys() = %v, want %v", keys, want)
	}
	if got := backoffKey("203.0.113.9"); got != "ws:backoff:203.0.113.9" {
		t.Fatalf("backoffKey() = %q", got)
	}
}

func TestToInt64(t *testing.T) {
	cases := []struct {
		value any
		want  int64
	}{
		{int64(3), 3},
		{int(4), 4},
		{"5", 5},
		{"not-a-number", 0},
		{nil, 0},
	}
	for _, testCase := range cases {
		if got := toInt64(testCase.value); got != testCase.want {
			t.Fatalf("toInt64(%#v) = %d, want %d", testCase.value, got, testCase.want)
		}
	}
}

// newUnavailableRedisClient returns a client whose connections are immediately
// closed by an in-process listener, so every Redis call fails without an
// external service.
func newUnavailableRedisClient(t *testing.T) *redis.Client {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen() error = %v", err)
	}
	accepted := make(chan struct{})
	go func() {
		defer close(accepted)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()
	client := redis.NewClient(&redis.Options{
		Addr:         listener.Addr().String(),
		DialTimeout:  200 * time.Millisecond,
		ReadTimeout:  200 * time.Millisecond,
		WriteTimeout: 200 * time.Millisecond,
		MaxRetries:   -1,
	})
	t.Cleanup(func() {
		_ = client.Close()
		_ = listener.Close()
		<-accepted
	})
	return client
}

func TestLimiterFailsOpenWhenRedisIsUnavailable(t *testing.T) {
	client := newUnavailableRedisClient(t)
	limiter := NewLimiter(client, 1, 1, 60)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if allowed, retryAfter := limiter.CheckIP(ctx, "203.0.113.9"); !allowed || retryAfter != 0 {
		t.Fatalf("CheckIP() = %v, %d; Redis errors must fail open", allowed, retryAfter)
	}
	if allowed, retryAfter := limiter.CheckUser(ctx, "user-1"); !allowed || retryAfter != 0 {
		t.Fatalf("CheckUser() = %v, %d; Redis errors must fail open", allowed, retryAfter)
	}
	if delay := limiter.BackoffDelay(ctx, "203.0.113.9"); delay != 0 {
		t.Fatalf("BackoffDelay() = %v, want 0 on Redis error", delay)
	}
	// Both helpers must swallow Redis errors rather than panic.
	limiter.RecordFailure(ctx, "203.0.113.9")
	limiter.ClearBackoff(ctx, "203.0.113.9")
}

func TestLimiterSkipsEmptyIdentifiers(t *testing.T) {
	limiter := NewLimiter(nil, 1, 1, 60)
	ctx := context.Background()
	if allowed, retryAfter := limiter.CheckIP(ctx, ""); !allowed || retryAfter != 0 {
		t.Fatalf("CheckIP(empty) = %v, %d", allowed, retryAfter)
	}
	if allowed, retryAfter := limiter.CheckUser(ctx, ""); !allowed || retryAfter != 0 {
		t.Fatalf("CheckUser(empty) = %v, %d", allowed, retryAfter)
	}
	if delay := limiter.BackoffDelay(ctx, ""); delay != 0 {
		t.Fatalf("BackoffDelay(empty) = %v", delay)
	}
	// Empty identifiers must not touch the Redis client (nil here).
	limiter.RecordFailure(ctx, "")
	limiter.ClearBackoff(ctx, "")
}
