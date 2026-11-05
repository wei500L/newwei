package bullmq

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestBackoffDelayExponentialAndFixed(t *testing.T) {
	exponential := &Backoff{Type: "exponential", Delay: 1000}
	cases := map[int64]int64{1: 1000, 2: 2000, 3: 4000, 4: 8000}
	for attemptsMade, want := range cases {
		if got := BackoffDelay(exponential, attemptsMade); got != want {
			t.Fatalf("attemptsMade=%d delay=%d, want %d", attemptsMade, got, want)
		}
	}
	if got := BackoffDelay(&Backoff{Type: "fixed", Delay: 500}, 3); got != 500 {
		t.Fatalf("fixed delay = %d, want 500", got)
	}
	if got := BackoffDelay(nil, 2); got != 0 {
		t.Fatalf("nil backoff = %d, want 0", got)
	}
}

func TestDefaultFailureDecision(t *testing.T) {
	job := &Job{AttemptsMade: 0, Opts: json.RawMessage(`{"attempts":3,"backoff":{"type":"fixed","delay":500}}`)}
	decision := defaultFailureDecision(job, errors.New("boom"))
	if decision.Final {
		t.Fatal("a retryable failure with attempts remaining must not be final")
	}
	if decision.DelayMillis != 500 {
		t.Fatalf("delay = %d, want 500", decision.DelayMillis)
	}

	last := &Job{AttemptsMade: 2, Opts: json.RawMessage(`{"attempts":3}`)}
	if decision := defaultFailureDecision(last, errors.New("boom")); !decision.Final {
		t.Fatal("the last allowed attempt must be final")
	}

	if decision := defaultFailureDecision(job, Unrecoverable(errors.New("permanent"))); !decision.Final || !decision.Permanent {
		t.Fatalf("unrecoverable decision = %+v", decision)
	}

	retryAfter := defaultFailureDecision(job, RetryAfter(errors.New("busy"), 2*time.Second))
	if retryAfter.Final || retryAfter.DelayMillis != 2000 {
		t.Fatalf("retry-after decision = %+v", retryAfter)
	}

	deferred := defaultFailureDecision(&Job{DeferredFailure: "job stalled more than allowable limit"}, errors.New("boom"))
	if !deferred.Final || !deferred.Permanent {
		t.Fatalf("deferred decision = %+v", deferred)
	}
}

func TestOriginalErrorUnwrapsMarkers(t *testing.T) {
	base := errors.New("root cause")
	if got := originalError(Unrecoverable(base)); got != base {
		t.Fatalf("unrecoverable unwrap = %v", got)
	}
	if got := originalError(RetryAfter(base, time.Second)); got != base {
		t.Fatalf("retry-after unwrap = %v", got)
	}
	if got := originalError(base); got != base {
		t.Fatalf("plain error = %v", got)
	}
}

func TestFailureReasonLimit(t *testing.T) {
	w := &Worker{opts: WorkerOptions{FailureReasonLimit: 10}}
	got := w.failureReason(errors.New("0123456789abcdef"))
	if len([]rune(got)) != 10 {
		t.Fatalf("reason length = %d (%q), want 10", len([]rune(got)), got)
	}
	if !strings.HasSuffix(got, "...") {
		t.Fatalf("truncated reason = %q, want ellipsis suffix", got)
	}
	if short := (&Worker{}).failureReason(errors.New("short")); short != "short" {
		t.Fatalf("unlimited reason = %q", short)
	}
}

func TestDecodeKeepJobsValueShapes(t *testing.T) {
	cases := []struct {
		raw   string
		count int64
		ok    bool
	}{
		{"", -1, false},
		{"null", -1, false},
		{"true", 0, true},
		{"false", -1, true},
		{"250", 250, true},
	}
	for _, tc := range cases {
		keep, ok := decodeKeepJobsValue(json.RawMessage(tc.raw))
		if ok != tc.ok {
			t.Fatalf("raw %q present = %v, want %v", tc.raw, ok, tc.ok)
		}
		if ok && (keep.Count == nil || *keep.Count != tc.count) {
			t.Fatalf("raw %q count = %v, want %d", tc.raw, keep.Count, tc.count)
		}
	}
	keep, ok := decodeKeepJobsValue(json.RawMessage(`{"age":604800,"count":10000}`))
	if !ok || keep.Age == nil || *keep.Age != 604800 || keep.Count == nil || *keep.Count != 10000 {
		t.Fatalf("object keep = %+v ok=%v", keep, ok)
	}
}

func TestJobAttemptsAndBackoff(t *testing.T) {
	job := &Job{Opts: json.RawMessage(`{"attempts":5,"backoff":{"type":"exponential","delay":1000}}`)}
	if got := job.Attempts(); got != 5 {
		t.Fatalf("attempts = %d, want 5", got)
	}
	backoff := job.Backoff()
	if backoff == nil || backoff.Delay != 1000 || backoff.Type != "exponential" {
		t.Fatalf("backoff = %+v", backoff)
	}
	if got := (&Job{}).Attempts(); got != 1 {
		t.Fatalf("default attempts = %d, want 1", got)
	}
}
