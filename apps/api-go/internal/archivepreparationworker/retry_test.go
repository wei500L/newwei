package archivepreparationworker

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"
)

func sha256Hex(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

// The archive preparation queue is configured with attempts=5 and
// backoff={type:"exponential",delay:15000}. BullMQ's Job.moveToFailed only takes
// the moveToDelayed path when Backoffs.calculate returns a positive delay, and
// shouldRetryJob calls it with attemptsMade+1, so the first retry waits
// round(2^0 * 15000) = 15s and each later retry doubles.
func TestJobRetryDelayMatchesBullMQExponentialBackoff(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name         string
		attemptsMade int
		want         int64
	}{
		{name: "first failure waits the base delay", attemptsMade: 0, want: 15000},
		{name: "second failure doubles", attemptsMade: 1, want: 30000},
		{name: "third failure doubles again", attemptsMade: 2, want: 60000},
		{name: "fourth failure doubles again", attemptsMade: 3, want: 120000},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			job := Job{AttemptsMade: testCase.attemptsMade, Opts: JobOptions{
				Attempts: 5,
				Backoff:  json.RawMessage(`{"type":"exponential","delay":15000}`),
			}}
			if got := job.RetryDelayMs(); got != testCase.want {
				t.Fatalf("RetryDelayMs() = %d, want %d", got, testCase.want)
			}
		})
	}
}

func TestJobRetryDelayWithoutBackoffIsImmediate(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		opts JobOptions
	}{
		{name: "no backoff option", opts: JobOptions{Attempts: 5}},
		{name: "null backoff", opts: JobOptions{Attempts: 5, Backoff: json.RawMessage(`null`)}},
		{name: "unknown strategy", opts: JobOptions{Attempts: 5, Backoff: json.RawMessage(`{"type":"linear","delay":15000}`)}},
		{name: "zero delay", opts: JobOptions{Attempts: 5, Backoff: json.RawMessage(`{"type":"exponential","delay":0}`)}},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			job := Job{AttemptsMade: 1, Opts: testCase.opts}
			if got := job.RetryDelayMs(); got != 0 {
				t.Fatalf("RetryDelayMs() = %d, want 0 (immediate retryJob path)", got)
			}
		})
	}
}

// A numeric backoff is normalized to the fixed strategy, exactly like
// Backoffs.normalize, so the delay never changes between attempts.
func TestJobRetryDelayFixedNumberBackoff(t *testing.T) {
	t.Parallel()
	for _, attemptsMade := range []int{0, 1, 2} {
		job := Job{AttemptsMade: attemptsMade, Opts: JobOptions{
			Attempts: 5,
			Backoff:  json.RawMessage(`5000`),
		}}
		if got := job.RetryDelayMs(); got != 5000 {
			t.Fatalf("RetryDelayMs() with numeric backoff at attemptsMade=%d = %d, want 5000", attemptsMade, got)
		}
	}
}

// FinalFailure must keep BullMQ's `attemptsMade + 1 >= attempts` boundary so the
// job runs exactly `attempts` times: with attempts=5 the first four failures
// retry and the fifth is terminal.
func TestJobFinalFailureBoundary(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name         string
		attemptsMade int
		attempts     int
		terminal     bool
	}{
		{name: "first failure retries", attemptsMade: 0, attempts: 5, terminal: false},
		{name: "fourth failure retries", attemptsMade: 3, attempts: 5, terminal: false},
		{name: "fifth failure is terminal", attemptsMade: 4, attempts: 5, terminal: true},
		{name: "missing attempts means one run", attemptsMade: 0, attempts: 0, terminal: true},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			job := Job{AttemptsMade: testCase.attemptsMade, Opts: JobOptions{Attempts: testCase.attempts}}
			if got := job.FinalFailure(); got != testCase.terminal {
				t.Fatalf("FinalFailure() = %v, want %v", got, testCase.terminal)
			}
		})
	}
}

// A job carrying the stalled deferred failure must never be retried, even while
// BullMQ attempts remain.
func TestJobDeferredFailureIsTerminal(t *testing.T) {
	t.Parallel()
	job := Job{
		AttemptsMade:    0,
		DeferredFailure: "job stalled more than allowable limit",
		Opts:            JobOptions{Attempts: 5},
	}
	if !job.FinalFailure() {
		t.Fatal("FinalFailure() = false for a deferred failure, want true")
	}
}

// The vendored moveToDelayed script must be the BullMQ 5.63.2 build whose
// expanded SHA-256 the NOTICE records; a wrong version would silently change the
// delayed-retry state transition.
func TestMoveToDelayedScriptIsEmbedded(t *testing.T) {
	t.Parallel()
	scripts, err := loadQueueScripts()
	if err != nil {
		t.Fatalf("loadQueueScripts() error = %v", err)
	}
	if scripts.moveToDelayed == nil {
		t.Fatal("loadQueueScripts() did not load moveToDelayed-8.lua")
	}
	content, err := scriptFiles.ReadFile("scripts/moveToDelayed-8.lua")
	if err != nil {
		t.Fatalf("read embedded moveToDelayed-8.lua: %v", err)
	}
	const wantExpandedSHA256 = "3140607f9078063c1cd35f984ad4fec26f49240aa037fb0c9f787c50b17660a7"
	if got := sha256Hex(content); got != wantExpandedSHA256 {
		t.Fatalf("moveToDelayed-8.lua SHA-256 = %s, want %s", got, wantExpandedSHA256)
	}
}
