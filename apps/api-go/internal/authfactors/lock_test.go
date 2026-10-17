package authfactors

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
)

// TestMfaUserLockNameShape locks the exact lock name contract: the `mfa:`
// prefix followed by the first 60 hex characters of the SHA-256 of the UTF-8
// user id, giving exactly 64 ASCII characters. The NestJS helper
// `mfaUserLockName` computes the identical string, which is what lets a Nest
// writer and a Go writer for the same user serialize against each other.
func TestMfaUserLockNameShape(t *testing.T) {
	for _, userID := range []string{
		"clx0a1b2c3d4e5f6g7h8i9j0",
		"machine:token-1",
		"",
		strings.Repeat("u", 200),
	} {
		sum := sha256.Sum256([]byte(userID))
		want := mfaUserLockPrefix + hex.EncodeToString(sum[:])[:mfaLockHashHexChars]
		got := mfaUserLockName(userID)
		if got != want {
			t.Fatalf("mfaUserLockName(%q) = %q, want %q", userID, got, want)
		}
		if len(got) != 64 {
			t.Fatalf("lock name %q length = %d, want 64", got, len(got))
		}
		if !strings.HasPrefix(got, mfaUserLockPrefix) {
			t.Fatalf("lock name %q is missing the prefix", got)
		}
		if strings.Contains(got, userID) && userID != "" {
			t.Fatalf("lock name %q must not embed the raw identity", got)
		}
	}
	if mfaUserLockName("user-a") == mfaUserLockName("user-b") {
		t.Fatal("different users must not share a lock name")
	}
	// The name carries no organization dimension: the same user keeps one lock
	// across organizations.
	if mfaUserLockName("user-a") != mfaUserLockName("user-a") {
		t.Fatal("the lock name must be deterministic")
	}
}

// TestWithUserLockBusyAndPropagation locks the error mapping: GET_LOCK returning
// 0 is the contention signal, and a business error raised by the callback is
// re-thrown unchanged.
func TestWithUserLockBusyAndPropagation(t *testing.T) {
	store := newFakeStore()
	service := newTestService(store, Config{})

	store.getLock = 0
	err := service.withUserLock(testContext(), "user-1", func(ctx context.Context) error {
		t.Fatal("the callback must not run when the lock was not acquired")
		return nil
	})
	if !errors.Is(err, errLockBusy) {
		t.Fatalf("busy error = %v", err)
	}

	store.getLock = 1
	business := &httpError{status: 401, message: mfaInvalidCodeMessage}
	err = service.withUserLock(testContext(), "user-1", func(ctx context.Context) error {
		return business
	})
	if !errors.Is(err, business) {
		t.Fatalf("business error = %v", err)
	}

	// A successful callback returns its result and the lock is released.
	called := false
	if err := service.withUserLock(testContext(), "user-1", func(ctx context.Context) error {
		called = true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("the callback must run when the lock was acquired")
	}
	releaseFound := false
	for _, statement := range store.statements {
		if strings.Contains(statement, "SELECT RELEASE_LOCK") {
			releaseFound = true
		}
	}
	if !releaseFound {
		t.Fatal("the lock must be released")
	}
}

// TestWithUserLockWithoutDatabase locks the fail-closed path.
func TestWithUserLockWithoutDatabase(t *testing.T) {
	service := &Service{}
	if err := service.withUserLock(testContext(), "user-1", func(contextContext) error {
		return nil
	}); !errors.Is(err, errNoDatabase) {
		t.Fatalf("error = %v", err)
	}
}
