package crawlexecution

// The retry-context decision of the BullMQ worker path: shouldRetry,
// nextRetryAt, the PipelineJob attempts value and the request-timeout
// normalization. The pipeline path passes no context and must keep terminating
// retryable failures.

import (
	"testing"
	"time"
)

func TestRunRetryContextShouldRetry(t *testing.T) {
	cases := []struct {
		name      string
		context   *runRetryContext
		retryable bool
		want      bool
	}{
		{name: "no context never retries", context: nil, retryable: true, want: false},
		{name: "retryable with attempts left", context: &runRetryContext{Attempt: 1, MaxAttempts: 3}, retryable: true, want: true},
		{name: "retryable on the last attempt", context: &runRetryContext{Attempt: 3, MaxAttempts: 3}, retryable: true, want: false},
		{name: "retryable beyond the ceiling", context: &runRetryContext{Attempt: 4, MaxAttempts: 3}, retryable: true, want: false},
		{name: "not retryable", context: &runRetryContext{Attempt: 1, MaxAttempts: 3}, retryable: false, want: false},
		{name: "zero attempts", context: &runRetryContext{Attempt: 0, MaxAttempts: 0}, retryable: true, want: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := testCase.context.shouldRetry(testCase.retryable); got != testCase.want {
				t.Fatalf("shouldRetry = %v, want %v", got, testCase.want)
			}
		})
	}
}

func TestRunRetryContextNextRetryAt(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	backoff := 1_500
	retry := &runRetryContext{Attempt: 1, MaxAttempts: 2, BackoffDelayMs: &backoff}
	value := retry.nextRetryAt(now, true)
	if value == nil || !value.Equal(now.Add(1500*time.Millisecond)) {
		t.Fatalf("nextRetryAt = %#v", value)
	}
	if value := retry.nextRetryAt(now, false); value != nil {
		t.Fatalf("nextRetryAt without a retry = %#v", value)
	}
	negative := -50
	clamped := &runRetryContext{Attempt: 1, MaxAttempts: 2, BackoffDelayMs: &negative}
	if value := clamped.nextRetryAt(now, true); value == nil || !value.Equal(now) {
		t.Fatalf("negative backoff = %#v", value)
	}
	if value := (&runRetryContext{Attempt: 1, MaxAttempts: 2}).nextRetryAt(now, true); value != nil {
		t.Fatalf("missing backoff = %#v", value)
	}
	if value := (*runRetryContext)(nil).nextRetryAt(now, true); value != nil {
		t.Fatalf("nil context = %#v", value)
	}
}

func TestRunRetryContextAttemptLogValue(t *testing.T) {
	if value := (*runRetryContext)(nil).attemptLogValue(); value != 0 {
		t.Fatalf("nil context = %d", value)
	}
	if value := (&runRetryContext{Attempt: -2}).attemptLogValue(); value != 0 {
		t.Fatalf("negative attempt = %d", value)
	}
	if value := (&runRetryContext{Attempt: 2}).attemptLogValue(); value != 2 {
		t.Fatalf("attempt = %d", value)
	}
}

func TestRunRetryContextNormalizedRequestTimeout(t *testing.T) {
	if value := (*runRetryContext)(nil).normalizedRequestTimeoutMs(); value != 0 {
		t.Fatalf("nil context = %d", value)
	}
	if value := (&runRetryContext{RequestTimeoutMs: 0}).normalizedRequestTimeoutMs(); value != 0 {
		t.Fatalf("zero = %d", value)
	}
	if value := (&runRetryContext{RequestTimeoutMs: 400}).normalizedRequestTimeoutMs(); value != 1000 {
		t.Fatalf("sub-second = %d", value)
	}
	if value := (&runRetryContext{RequestTimeoutMs: 45_000}).normalizedRequestTimeoutMs(); value != 45_000 {
		t.Fatalf("explicit = %d", value)
	}
}

func TestJSRoundMatchesJavaScript(t *testing.T) {
	cases := map[float64]float64{
		0.5:  1,
		1.5:  2,
		2.5:  3,
		-0.5: 0,
		-1.5: -1,
		1.4:  1,
	}
	for input, want := range cases {
		if got := jsRound(input); got != want {
			t.Fatalf("jsRound(%v) = %v, want %v", input, got, want)
		}
	}
}
