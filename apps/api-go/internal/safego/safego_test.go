package safego

import (
	"strings"
	"testing"
	"time"
)

// TestCallConvertsPanicToError verifies a panicking unit becomes an ordinary
// error instead of unwinding the caller.
func TestCallConvertsPanicToError(t *testing.T) {
	err := Call("test.call", func() error {
		panic("boom")
	})
	if err == nil {
		t.Fatal("Call returned nil for a panicking unit")
	}
	if !strings.Contains(err.Error(), "test.call: panic: boom") {
		t.Fatalf("error %q does not name the unit and panic value", err)
	}
}

// TestCallReturnsNilOnSuccess verifies a normal unit keeps its return value.
func TestCallReturnsNilOnSuccess(t *testing.T) {
	if err := Call("test.ok", func() error { return nil }); err != nil {
		t.Fatalf("Call returned %v for a successful unit", err)
	}
}

// TestGoRecoversPanic verifies a panic on a Go goroutine does not crash the
// process: the test itself would die if the panic escaped. The unit signals
// completion so the assertion does not race the goroutine.
func TestGoRecoversPanic(t *testing.T) {
	done := make(chan struct{})
	Go("test.go", func() {
		defer close(done)
		panic("boom")
	})
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Go goroutine did not finish")
	}
}
