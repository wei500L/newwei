package crawl4ai

import (
	"errors"
	"fmt"
	"testing"
)

// TestStatusOfUnwrapsWrappedError pins the retryable-status contract: the crawl
// worker and the execution service annotate a client error with %w before the
// status is read, and losing the status there would turn a retryable upstream
// answer (429/503/...) into a permanent failure.
func TestStatusOfUnwrapsWrappedError(t *testing.T) {
	base := newError(503, "service unavailable")
	if got := StatusOf(base); got != 503 {
		t.Fatalf("direct status = %d, want 503", got)
	}

	wrapped := fmt.Errorf("crawl preflight: %w", base)
	if got := StatusOf(wrapped); got != 503 {
		t.Fatalf("wrapped status = %d, want 503", got)
	}

	doubleWrapped := fmt.Errorf("run task: %w", wrapped)
	if got := StatusOf(doubleWrapped); got != 503 {
		t.Fatalf("double wrapped status = %d, want 503", got)
	}

	if got := StatusOf(errors.New("connection reset by peer")); got != 0 {
		t.Fatalf("plain error status = %d, want 0", got)
	}
	if got := StatusOf(nil); got != 0 {
		t.Fatalf("nil status = %d, want 0", got)
	}
}
