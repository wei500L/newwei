package itempipeline

import (
	"errors"
	"fmt"
	"syscall"
	"testing"

	"github.com/go-sql-driver/mysql"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
)

func TestClassifyQueueError(t *testing.T) {
	zod := &namedTestError{name: "ZodError", message: "url: Required"}
	guardrail := &namedTestError{name: "LiteLlmGuardrailViolationError", message: "blocked"}
	transient := &TransientError{Message: "temporary"}
	cases := []struct {
		name   string
		err    error
		kind   ErrorKind
		reason string
	}{
		{"nil", nil, ErrorKindTransient, "unknown"},
		{"permanent", NewPermanentError("Queue job missing orgId"), ErrorKindPermanent, "explicit-permanent"},
		{"transient wrapper", transient, ErrorKindTransient, "explicit-transient"},
		{"zod", zod, ErrorKindPermanent, "validation"},
		{"guardrail", guardrail, ErrorKindPermanent, "guardrail"},
		{"crawl4ai 503", &crawl4ai.Error{Status: 503, Message: "upstream"}, ErrorKindTransient, "crawl4ai"},
		{"crawl4ai 404", &crawl4ai.Error{Status: 404, Message: "not found"}, ErrorKindPermanent, "crawl4ai"},
		{"mysql duplicate", newMySQLError(1062), ErrorKindPermanent, "prisma"},
		{"mysql deadlock", newMySQLError(1213), ErrorKindTransient, "prisma"},
		{"system reset", fmt.Errorf("write: %w", syscall.ECONNRESET), ErrorKindTransient, "system"},
		{"rate limit", errors.New("Upstream throttled, retry later"), ErrorKindTransient, "rate-limit"},
		{"unknown", errors.New("boom"), ErrorKindTransient, "unknown"},
	}
	for _, testCase := range cases {
		classified := ClassifyQueueError(testCase.err)
		if classified.Kind != testCase.kind || classified.Reason != testCase.reason {
			t.Errorf("%s: classified = %s/%s, want %s/%s", testCase.name, classified.Kind, classified.Reason, testCase.kind, testCase.reason)
		}
	}
}

func TestSerializeQueueErrorCapsCauseDepth(t *testing.T) {
	root := errors.New("root")
	level1 := fmt.Errorf("level1: %w", root)
	level2 := fmt.Errorf("level2: %w", level1)
	level3 := fmt.Errorf("level3: %w", level2)
	serialized := SerializeQueueError(level3)
	depth := 0
	for current := &serialized; current.Cause != nil; current = current.Cause {
		depth++
	}
	if depth != 3 {
		t.Fatalf("cause depth = %d, want 3", depth)
	}
	if serialized.Message != "level3: level2: level1: root" {
		t.Fatalf("message = %q", serialized.Message)
	}
}

func TestJitterBackoffMatchesMathRound(t *testing.T) {
	cases := []struct {
		base    int
		attempt int
		max     int
		random  float64
		want    int64
	}{
		{600_000, 1, 21_600_000, 0, 450_000},
		{600_000, 1, 21_600_000, 0.5, 600_000},
		{600_000, 1, 21_600_000, 1, 750_000},
		{600_000, 2, 21_600_000, 0, 900_000},
		{600_000, 3, 21_600_000, 0, 1_800_000},
		// Capped before jitter: 3_600_000 * 2^9 capped at 86_400_000.
		{3_600_000, 10, 86_400_000, 0, 64_800_000},
		// Fractional random rounds like Math.round.
		{1000, 1, 10_000, 0.001, 753},
		// attempt < 1 normalizes to 1.
		{1000, 0, 10_000, 0.5, 1000},
	}
	for _, testCase := range cases {
		got := JitterBackoff(testCase.base, testCase.attempt, testCase.max, func() float64 { return testCase.random })
		if got != testCase.want {
			t.Errorf("JitterBackoff(%d,%d,%d,%v) = %d, want %d",
				testCase.base, testCase.attempt, testCase.max, testCase.random, got, testCase.want)
		}
	}
}

func TestRetryDelayExponential(t *testing.T) {
	backoff := []byte(`{"type":"exponential","delay":2000}`)
	if got := retryDelayMS(backoff, 1); got != 2_000 {
		t.Fatalf("first retry delay = %d", got)
	}
	if got := retryDelayMS(backoff, 2); got != 4_000 {
		t.Fatalf("second retry delay = %d", got)
	}
	if got := retryDelayMS(backoff, 3); got != 8_000 {
		t.Fatalf("third retry delay = %d", got)
	}
	if got := retryDelayMS(nil, 2); got != 0 {
		t.Fatalf("nil backoff delay = %d", got)
	}
	if got := retryDelayMS([]byte(`{"type":"fixed","delay":1500}`), 4); got != 1_500 {
		t.Fatalf("fixed backoff delay = %d", got)
	}
}

func TestDecodeFailureRetryAndFinalSemantics(t *testing.T) {
	job := Job{Opts: JobOptions{Attempts: 5}}
	failure := DecodeFailure(job, errors.New("boom"))
	if failure.AttemptsMade != 1 || failure.RemainingAttempts != 4 || failure.FinalFailure || failure.Permanent {
		t.Fatalf("first failure = %+v", failure)
	}

	lastAttempt := Job{Opts: JobOptions{Attempts: 5}, AttemptsMade: 4}
	failure = DecodeFailure(lastAttempt, errors.New("boom"))
	if failure.AttemptsMade != 5 || failure.RemainingAttempts != 0 || !failure.FinalFailure {
		t.Fatalf("last failure = %+v", failure)
	}

	// A permanent error is final even with attempts remaining (the
	// UnrecoverableError semantics).
	permanent := DecodeFailure(job, NewPermanentError("Queue job missing rawItemId or itemMetaId"))
	if !permanent.Permanent || !permanent.FinalFailure || permanent.RemainingAttempts != 4 {
		t.Fatalf("permanent failure = %+v", permanent)
	}

	// Jobs without opts.attempts behave like attempts=1.
	noOptions := DecodeFailure(Job{}, errors.New("boom"))
	if noOptions.AttemptsMade != 1 || !noOptions.FinalFailure {
		t.Fatalf("no-options failure = %+v", noOptions)
	}

	// A deferred failure (stalled limit) is final even with attempts left.
	deferred := DecodeFailure(Job{Opts: JobOptions{Attempts: 5}, DeferredFailure: "job stalled more than allowable limit"}, errors.New("boom"))
	if !deferred.FinalFailure {
		t.Fatalf("deferred failure must be final: %+v", deferred)
	}
}

type namedTestError struct {
	name    string
	message string
}

func (e *namedTestError) Error() string { return e.message }
func (e *namedTestError) Name() string  { return e.name }

func newMySQLError(number uint16) error {
	return &mysql.MySQLError{Number: number, Message: "mysql error"}
}
