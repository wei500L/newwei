package crawlworker

import (
	"database/sql"
	"testing"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
)

// stubRedisClient is never connected: New only stores the handle, it performs no
// I/O until Start.
func stubRedisClient() *redis.Client {
	return redis.NewClient(&redis.Options{Addr: "127.0.0.1:0"})
}

func TestNewValidatesTheWiring(t *testing.T) {
	client := stubRedisClient()
	defer func() { _ = client.Close() }()
	blocking := func() *redis.Client { return stubRedisClient() }
	failing := []struct {
		name    string
		options Options
	}{
		{"no client", Options{NewBlockingClient: blocking}},
		{"no blocking factory", Options{Client: client}},
		{"no mysql", Options{Client: client, NewBlockingClient: blocking}},
	}
	for _, testCase := range failing {
		if _, err := New(testCase.options); err == nil {
			t.Errorf("%s: expected a wiring error", testCase.name)
		}
	}
}

func TestNewRejectsAMissingFrontierProcessor(t *testing.T) {
	client := stubRedisClient()
	defer func() { _ = client.Close() }()
	_, err := New(Options{
		Client:            client,
		NewBlockingClient: func() *redis.Client { return stubRedisClient() },
		DB:                &sql.DB{},
		Execution:         &fakeRunner{},
		Settings:          crawlqueue.NewSettingsReader(nil, nil, nil),
		Activity:          &fakeActivity{},
	})
	if err == nil {
		t.Fatal("a worker without a frontier processor must fail to build")
	}
}

func TestApplyConcurrencyUpdatesTheLimiter(t *testing.T) {
	worker := &Worker{limiter: newConcurrencyLimiter(1)}
	worker.ApplyConcurrency(7)
	if capacity, active := worker.limiter.stats(); capacity != 7 || active != 0 {
		t.Fatalf("capacity/active = %d/%d, want 7/0", capacity, active)
	}
	// The C2 payload is always in [1,20]; a stray zero still means one worker.
	worker.ApplyConcurrency(0)
	if capacity, _ := worker.limiter.stats(); capacity != 1 {
		t.Fatalf("capacity = %d, want the one-slot floor", capacity)
	}
}

func TestApplyConcurrencyIsSafeBeforeStart(t *testing.T) {
	worker := &Worker{limiter: newConcurrencyLimiter(2), settings: newSettingsCache(nil, 0, nil)}
	worker.ApplyConcurrency(3)
	if capacity, _ := worker.limiter.stats(); capacity != 3 {
		t.Fatalf("capacity = %d, want 3", capacity)
	}
}

// TestRequestTimeoutResolutionUsesTheSettingsClass pins the per-queue timeout
// the attempt resolves: the hot queue uses requestTimeoutHotMs, every other class
// requestTimeoutNormalMs.
func TestRequestTimeoutResolutionUsesTheSettingsClass(t *testing.T) {
	settings := crawlqueue.Settings{RequestTimeoutHotMs: 60_000, RequestTimeoutNormalMs: 120_000}
	if got := resolveRequestTimeoutMs(crawlqueue.PriorityClassHot, settings, 0); got != 60_000 {
		t.Errorf("hot timeout = %d", got)
	}
	if got := resolveRequestTimeoutMs(crawlqueue.PriorityClassNormal, settings, 0); got != 120_000 {
		t.Errorf("normal timeout = %d", got)
	}
	if got := resolveRequestTimeoutMs(crawlqueue.PriorityClassNormal, crawlqueue.Settings{}, 30_000); got != 30_000 {
		t.Errorf("fallback timeout = %d", got)
	}
}
