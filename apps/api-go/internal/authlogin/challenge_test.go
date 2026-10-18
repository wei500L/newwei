package authlogin

import (
	"context"
	"database/sql/driver"
	"fmt"
	"strings"
	"testing"
)

// The challenge tests lock the single-use and attempt-budget rules: a claim that
// affects no row must fail, and a locked or over-budget challenge must answer the
// throttle instead of a plain credential failure. Every transition is a
// conditional UPDATE, so the affected-row count is the whole guarantee.

func challengeService(t *testing.T, state *fakeState) *Service {
	t.Helper()
	return NewService(newFakeDB(state), nil, Config{AuthMfaChallengeMaxAttempts: 5})
}

func TestConsumeChallengeRejectsAlreadyConsumed(t *testing.T) {
	state := &fakeState{}
	// The conditional claim affects no row: another request consumed it first.
	state.execHandler = func(query string, _ []driver.NamedValue) (driver.Result, error) {
		if strings.Contains(query, "SET `consumedAt`") {
			return fakeResult{rows: 0}, nil
		}
		return fakeResult{rows: 1}, nil
	}
	// The follow-up read shows an unlocked challenge that is neither locked nor
	// over budget, so the answer is the plain 401.
	state.queryHandler = func(query string, _ []driver.NamedValue) (driver.Rows, error) {
		return rowsWithValues([]string{"failedAttempts", "lockedAt"}, int64(0), nil), nil
	}

	err := challengeService(t, state).consumeChallenge(context.Background(), "c1", mfaLoginChallengeInvalidMessage)
	if got := errorMessage(t, err); got != mfaLoginChallengeInvalidMessage {
		t.Fatalf("messages = %q", got)
	}
}

func TestConsumeChallengeAtBudgetAnswersThrottledAndLocks(t *testing.T) {
	state := &fakeState{}
	state.execHandler = func(query string, _ []driver.NamedValue) (driver.Result, error) {
		return fakeResult{rows: 0}, nil
	}
	state.queryHandler = func(query string, _ []driver.NamedValue) (driver.Rows, error) {
		return rowsWithValues([]string{"failedAttempts", "lockedAt"}, int64(5), nil), nil
	}

	err := challengeService(t, state).consumeChallenge(context.Background(), "c1", mfaLoginChallengeInvalidMessage)
	if got := errorMessage(t, err); got != mfaChallengeLockedMessage {
		t.Fatalf("messages = %q", got)
	}
	locked := false
	for _, statement := range state.executedStatements() {
		if strings.Contains(statement, "SET `lockedAt`") {
			locked = true
		}
	}
	if !locked {
		t.Fatal("an over-budget challenge must be locked")
	}
}

func TestChallengeClaimPredicatesGuardEveryExit(t *testing.T) {
	state := &fakeState{}
	state.execHandler = func(string, []driver.NamedValue) (driver.Result, error) {
		return fakeResult{rows: 1}, nil
	}
	service := challengeService(t, state)
	ctx := context.Background()

	if err := service.consumeChallenge(ctx, "c1", mfaLoginChallengeInvalidMessage); err != nil {
		t.Fatal(err)
	}
	statements := state.executedStatements()
	if len(statements) != 1 {
		t.Fatalf("statements = %d", len(statements))
	}
	claim := statements[0]
	// Consumption is only valid while the challenge is unconsumed, unlocked,
	// under budget and unexpired — the same predicate the NestJS claim uses.
	for _, guard := range []string{
		"`consumedAt` IS NULL",
		"`lockedAt` IS NULL",
		"`failedAttempts` < ?",
		"`expiresAt` > ?",
	} {
		if !strings.Contains(claim, guard) {
			t.Fatalf("claim is missing guard %q: %s", guard, claim)
		}
	}
}

func TestRecordChallengeFailureKeepsForeignErrors(t *testing.T) {
	// A database or encryption failure is not a wrong code: it must not consume
	// an attempt and must keep its own meaning.
	state := &fakeState{}
	service := challengeService(t, state)
	databaseFailure := fmt.Errorf("driver exploded")
	got := service.recordChallengeFailure(context.Background(), "c1", mfaLoginChallengeInvalidMessage, databaseFailure)
	if got != databaseFailure {
		t.Fatalf("error = %v, want the original failure", got)
	}
	if len(state.executedStatements()) != 0 {
		t.Fatal("a foreign error must not touch the attempt counter")
	}
}
