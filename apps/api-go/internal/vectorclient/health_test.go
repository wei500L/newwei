package vectorclient

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// healthWindowTestErrors are the named failures the window tests use.
func vectorUnavailableFailure() *Error {
	return &Error{Kind: "VectorServiceUnavailableError", Message: "Vector request failed"}
}

func vectorUnauthorizedFailure() *Error {
	return &Error{Kind: "VectorUnauthorizedError", Message: "Vector service authentication failed"}
}

func vectorBadResponseFailure() *Error {
	return &Error{Kind: "VectorBadResponseError", Message: "Vector search returned invalid payload"}
}

// TestHealthBackoffSequence pins the exponential schedule and the ten-failure
// cap: min(60s, 1s*2^(n-1)) for n = 1..10.
func TestHealthBackoffSequence(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	health := &Health{}
	want := []time.Duration{
		time.Second,
		2 * time.Second,
		4 * time.Second,
		8 * time.Second,
		16 * time.Second,
		32 * time.Second,
		60 * time.Second,
		60 * time.Second,
		60 * time.Second,
		60 * time.Second,
	}
	for index, expected := range want {
		health.MarkUnavailable(vectorUnavailableFailure(), OperationSearch, now)
		snapshot := health.Snapshot(now)
		if got := snapshot.UnavailableUntil.Sub(now); got != expected {
			t.Fatalf("failure %d backoff = %s, want %s", index+1, got, expected)
		}
		if snapshot.ConsecutiveFailures != index+1 {
			t.Fatalf("failure %d streak = %d, want %d", index+1, snapshot.ConsecutiveFailures, index+1)
		}
	}
	// The streak stops growing at ten; the window stays capped.
	health.MarkUnavailable(vectorUnavailableFailure(), OperationSearch, now)
	health.MarkUnavailable(vectorUnavailableFailure(), OperationSearch, now)
	snapshot := health.Snapshot(now)
	if snapshot.ConsecutiveFailures != 10 {
		t.Fatalf("streak after 12 failures = %d, want 10", snapshot.ConsecutiveFailures)
	}
	if got := snapshot.UnavailableUntil.Sub(now); got != 60*time.Second {
		t.Fatalf("capped backoff = %s, want 60s", got)
	}
}

// TestHealthSpecialErrorFloors pins the two minimum windows from NestJS
// markUnavailable: 401/403 keeps at least five minutes, a bad response at least
// one minute.
func TestHealthSpecialErrorFloors(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name string
		err  error
		want time.Duration
	}{
		{name: "unauthorized", err: vectorUnauthorizedFailure(), want: 5 * time.Minute},
		{name: "bad response", err: vectorBadResponseFailure(), want: time.Minute},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			health := &Health{}
			health.MarkUnavailable(testCase.err, OperationUpsert, now)
			snapshot := health.Snapshot(now)
			if got := snapshot.UnavailableUntil.Sub(now); got != testCase.want {
				t.Fatalf("backoff = %s, want %s", got, testCase.want)
			}
			if snapshot.LastErrorName != errorName(testCase.err) {
				t.Fatalf("last error name = %q", snapshot.LastErrorName)
			}
		})
	}
}

// TestHealthAvailableBoundaryAndRecovery pins now >= unavailableUntil as
// available and confirms markAvailable keeps the last-* diagnostic fields.
func TestHealthAvailableBoundaryAndRecovery(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	health := &Health{}
	if !health.Available(now) {
		t.Fatal("a zero Health must be available")
	}
	health.MarkUnavailable(vectorUnavailableFailure(), OperationSearch, now)
	windowEnd := health.Snapshot(now).UnavailableUntil
	if health.Available(now) {
		t.Fatal("the window must be closed right after a failure")
	}
	if health.Available(windowEnd.Add(-time.Nanosecond)) {
		t.Fatal("the window must stay closed one nanosecond before its end")
	}
	if !health.Available(windowEnd) {
		t.Fatal("the window must reopen at unavailableUntil (NestJS now >= until)")
	}

	health.MarkAvailable()
	snapshot := health.Snapshot(now)
	if !health.Available(now) || snapshot.TemporarilyUnavailable {
		t.Fatal("markAvailable must reopen the window")
	}
	if snapshot.ConsecutiveFailures != 0 {
		t.Fatalf("streak after markAvailable = %d", snapshot.ConsecutiveFailures)
	}
	if !snapshot.UnavailableUntil.IsZero() {
		t.Fatalf("window after markAvailable = %s", snapshot.UnavailableUntil)
	}
	if snapshot.LastOperation != OperationSearch || snapshot.LastErrorName != "VectorServiceUnavailableError" {
		t.Fatalf("markAvailable must keep the last-* fields: %+v", snapshot)
	}
	if snapshot.LastFailureAt.IsZero() || snapshot.LastErrorMessage == "" {
		t.Fatalf("markAvailable must keep the failure timestamp/message: %+v", snapshot)
	}
}

// TestHealthFingerprintReset pins RefreshFingerprint: the first call and every
// change clear the streak and the window, an unchanged fingerprint does not.
func TestHealthFingerprintReset(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	health := &Health{}
	health.RefreshFingerprint("base|1000|0|aaaa")
	health.MarkUnavailable(vectorUnauthorizedFailure(), OperationSearch, now)
	if health.Available(now) {
		t.Fatal("the window must be open after a failure")
	}
	// The same configuration must not reset the window on every request.
	health.RefreshFingerprint("base|1000|0|aaaa")
	snapshot := health.Snapshot(now)
	if health.Available(now) || snapshot.ConsecutiveFailures != 1 {
		t.Fatalf("an unchanged fingerprint reset the window: %+v", snapshot)
	}
	// A rotated token (or a changed endpoint/timeout/retry count) resets it.
	health.RefreshFingerprint("base|1000|0|bbbb")
	snapshot = health.Snapshot(now)
	if !health.Available(now) || snapshot.ConsecutiveFailures != 0 || !snapshot.UnavailableUntil.IsZero() {
		t.Fatalf("a changed fingerprint must reset the window: %+v", snapshot)
	}
	if snapshot.LastOperation != OperationSearch {
		t.Fatalf("a fingerprint reset must keep the last-* fields: %+v", snapshot)
	}
}

// TestHealthSnapshotZeroValue pins the diagnostics-friendly empty shape and the
// nil-receiver safety.
func TestHealthSnapshotZeroValue(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	for name, health := range map[string]*Health{"zero": &Health{}, "nil": nil} {
		t.Run(name, func(t *testing.T) {
			snapshot := health.Snapshot(now)
			if !snapshot.Now.Equal(now) {
				t.Fatalf("Now = %s", snapshot.Now)
			}
			if snapshot.TemporarilyUnavailable || snapshot.ConsecutiveFailures != 0 {
				t.Fatalf("snapshot = %+v", snapshot)
			}
			if !snapshot.UnavailableUntil.IsZero() || !snapshot.LastFailureAt.IsZero() {
				t.Fatalf("times must be zero: %+v", snapshot)
			}
			if snapshot.LastOperation != "" || snapshot.LastErrorName != "" || snapshot.LastErrorMessage != "" {
				t.Fatalf("last fields must be empty: %+v", snapshot)
			}
			if !health.Available(now) {
				t.Fatal("an empty health must be available")
			}
		})
	}
}

// TestHealthErrorName pins the error classification used by the diagnostics
// response: the NestJS-compatible class name for named errors, "" otherwise.
func TestHealthErrorName(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{name: "nil", err: nil, want: ""},
		{name: "named", err: vectorUnauthorizedFailure(), want: "VectorUnauthorizedError"},
		{name: "wrapped named", err: fmt.Errorf("wrapped: %w", vectorBadResponseFailure()), want: "VectorBadResponseError"},
		{name: "plain", err: errors.New("plain"), want: ""},
	}
	for _, testCase := range cases {
		if got := errorName(testCase.err); got != testCase.want {
			t.Fatalf("%s: errorName = %q, want %q", testCase.name, got, testCase.want)
		}
	}
}

// TestSharedHealthWindowAcrossSearchAndUpsert proves the B1 contract: one
// failed search opens the window for the upsert client of the same process, and
// a later upsert success closes it again for the search client.
func TestSharedHealthWindowAcrossSearchAndUpsert(t *testing.T) {
	var calls atomic.Int64
	var fail atomic.Bool
	fail.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if fail.Load() {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path == "/v1/search" {
			_, _ = w.Write([]byte(`{"collection":"c","matches":[]}`))
			return
		}
		_, _ = w.Write([]byte(`{"upserted":1,"collection":"processed"}`))
	}))
	defer server.Close()

	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	health := &Health{}
	searcher := NewSearcher(SearcherOptions{
		Env: SearcherEnv{
			Enabled:    true,
			BaseURL:    server.URL,
			Token:      "secret",
			TimeoutMS:  1000,
			MaxRetries: 0,
		},
		Health: health,
		Now:    func() time.Time { return now },
	})
	searcher.sleep = noSleep
	upsert := &Client{
		HTTPClient: server.Client(),
		Sleep:      noSleep,
		Rand:       func() float64 { return 0.5 },
		Health:     health,
		now:        func() time.Time { return now },
	}
	config := Config{Enabled: true, BaseURL: server.URL, Token: "secret", TimeoutMs: 1000, MaxRetries: 0}

	if _, err := searcher.SearchBestEffort(context.Background(), SearchRequest{OrgID: "org", EmbeddingModel: "m", Vector: []float64{1}, Limit: 1}); err == nil {
		t.Fatal("want the search to fail")
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want 1", calls.Load())
	}
	if health.Available(now) {
		t.Fatal("the failed search must open the shared window")
	}

	// The upsert client is a different instance (the outbox call site) but shares
	// the Health, so it must short-circuit without a network call.
	err := upsert.Upsert(context.Background(), config, UpsertRequest{Points: []Point{{Vector: []float64{1}}}})
	var vectorError *Error
	if !errors.As(err, &vectorError) || vectorError.Kind != "VectorServiceUnavailableError" {
		t.Fatalf("in-window upsert error = %v", err)
	}
	if err.Error() != "Vector service is temporarily unavailable" {
		t.Fatalf("in-window upsert message = %q", err.Error())
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want the in-window upsert to skip the request", calls.Load())
	}

	// After the 401 window a successful upsert closes the shared window.
	now = now.Add(5*time.Minute + time.Second)
	fail.Store(false)
	if err := upsert.Upsert(context.Background(), config, UpsertRequest{Points: []Point{{Vector: []float64{1}}}}); err != nil {
		t.Fatalf("post-window upsert error = %v", err)
	}
	if health.Snapshot(now).ConsecutiveFailures != 0 {
		t.Fatal("a success must clear the shared failure streak")
	}
	if _, err := searcher.SearchBestEffort(context.Background(), SearchRequest{OrgID: "org", EmbeddingModel: "m", Vector: []float64{1}, Limit: 1}); err != nil {
		t.Fatalf("post-recovery search error = %v", err)
	}
	if calls.Load() != 3 {
		t.Fatalf("calls = %d, want 3", calls.Load())
	}
}

// TestUpsertCallSitesShareHealthWindow proves the two upsert call sites
// (itemPipeline immediate delivery and the processed-item compensation
// scanner) share one window when both clients are wired to the same Health.
func TestUpsertCallSitesShareHealthWindow(t *testing.T) {
	var calls atomic.Int64
	var fail atomic.Bool
	fail.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if fail.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(`{"upserted":1,"collection":"processed"}`))
	}))
	defer server.Close()

	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	health := &Health{}
	clock := func() time.Time { return now }
	firstCallSite := &Client{HTTPClient: server.Client(), Sleep: noSleep, Rand: func() float64 { return 0.5 }, Health: health, now: clock}
	secondCallSite := &Client{HTTPClient: server.Client(), Sleep: noSleep, Rand: func() float64 { return 0.5 }, Health: health, now: clock}
	config := Config{Enabled: true, BaseURL: server.URL, Token: "secret", TimeoutMs: 1000, MaxRetries: 0}
	request := UpsertRequest{Points: []Point{{Vector: []float64{1}}}}

	// The retryable 5xx is retried MaxRetries+1 = 1 time, then marks the window.
	err := firstCallSite.Upsert(context.Background(), config, request)
	if err == nil {
		t.Fatal("want a failure")
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want 1", calls.Load())
	}
	snapshot := health.Snapshot(now)
	if snapshot.LastOperation != OperationUpsert || snapshot.LastErrorName != "VectorServiceUnavailableError" {
		t.Fatalf("health snapshot = %+v", snapshot)
	}

	// The second call site short-circuits on the same window.
	if err := secondCallSite.Upsert(context.Background(), config, request); err == nil {
		t.Fatal("want the in-window error")
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want the second call site to skip the request", calls.Load())
	}

	// Advance past the first backoff (1s for a generic failure), then the
	// second call site succeeds and marks the shared state available.
	now = now.Add(time.Second)
	fail.Store(false)
	if err := secondCallSite.Upsert(context.Background(), config, request); err != nil {
		t.Fatalf("post-window upsert error = %v", err)
	}
	if snapshot := health.Snapshot(now); snapshot.ConsecutiveFailures != 0 || snapshot.TemporarilyUnavailable {
		t.Fatalf("health after recovery = %+v", snapshot)
	}
	if calls.Load() != 2 {
		t.Fatalf("calls = %d, want 2", calls.Load())
	}
}

// TestUpsertWithoutHealthKeepsBehaviour pins the nil-Health compatibility: the
// zero-value client still performs the request and records no window.
func TestUpsertWithoutHealthKeepsBehaviour(t *testing.T) {
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`{"upserted":1,"collection":"processed"}`))
	}))
	defer server.Close()
	client := &Client{HTTPClient: server.Client(), Sleep: noSleep}
	config := Config{Enabled: true, BaseURL: server.URL, Token: "secret", TimeoutMs: 1000, MaxRetries: 0}
	for attempt := 0; attempt < 2; attempt++ {
		if err := client.Upsert(context.Background(), config, UpsertRequest{Points: []Point{{Vector: []float64{1}}}}); err != nil {
			t.Fatalf("Upsert without Health error = %v", err)
		}
	}
	if calls.Load() != 2 {
		t.Fatalf("calls = %d, want 2", calls.Load())
	}
}
