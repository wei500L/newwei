package authlogin

import (
	"context"
	"database/sql/driver"
	"fmt"
	"strings"
	"testing"
	"time"
)

// The reset tests lock the transaction's update scope: one commit that replaces
// the password hash, consumes every unused reset token of that user and revokes
// every live refresh token — or nothing at all.

func resetService(state *fakeState) *Service {
	return NewService(newFakeDB(state), nil, Config{})
}

func resetQueryHandler(state *fakeState, expiresAt time.Time) {
	state.queryHandler = func(query string, _ []driver.NamedValue) (driver.Rows, error) {
		switch {
		case strings.Contains(query, "FROM `PasswordResetToken`"):
			return rowsWithValues([]string{"userId", "expiresAt", "usedAt"}, "user-1", expiresAt, nil), nil
		case strings.Contains(query, "FROM `Membership`"):
			return emptyRows("orgId"), nil
		default:
			return nil, fmt.Errorf("unexpected query: %s", query)
		}
	}
}

func TestResetPasswordTransactionScope(t *testing.T) {
	state := &fakeState{}
	resetQueryHandler(state, time.Now().Add(time.Hour).UTC())
	state.execHandler = func(string, []driver.NamedValue) (driver.Result, error) {
		return fakeResult{rows: 1}, nil
	}

	if _, err := resetService(state).resetPassword(context.Background(), "tok", "new-password", nil); err != nil {
		t.Fatal(err)
	}

	commits, rollbacks := state.txCounts()
	if commits != 1 || rollbacks != 0 {
		t.Fatalf("commits = %d, rollbacks = %d", commits, rollbacks)
	}
	var passwordUpdate, tokenConsume, refreshRevoke bool
	for _, statement := range state.executedStatements() {
		switch {
		case strings.Contains(statement, "UPDATE `User` SET `passwordHash`"):
			passwordUpdate = true
		case strings.Contains(statement, "UPDATE `PasswordResetToken` SET `usedAt`") &&
			strings.Contains(statement, "`usedAt` IS NULL"):
			tokenConsume = true
		case strings.Contains(statement, "UPDATE `RefreshToken` SET `revokedAt`") &&
			strings.Contains(statement, "`revokedAt` IS NULL"):
			refreshRevoke = true
		}
	}
	if !passwordUpdate || !tokenConsume || !refreshRevoke {
		t.Fatalf("password=%v token=%v refresh=%v", passwordUpdate, tokenConsume, refreshRevoke)
	}
}

func TestResetPasswordRollsBackWhenRevokeFails(t *testing.T) {
	state := &fakeState{}
	resetQueryHandler(state, time.Now().Add(time.Hour).UTC())
	state.execHandler = func(query string, _ []driver.NamedValue) (driver.Result, error) {
		if strings.Contains(query, "UPDATE `RefreshToken`") {
			return nil, fmt.Errorf("connection lost")
		}
		return fakeResult{rows: 1}, nil
	}

	_, err := resetService(state).resetPassword(context.Background(), "tok", "new-password", nil)
	if err == nil {
		t.Fatal("expected a failure")
	}
	commits, rollbacks := state.txCounts()
	if commits != 0 || rollbacks != 1 {
		t.Fatalf("commits = %d, rollbacks = %d", commits, rollbacks)
	}
}

func TestResetPasswordRejectsExpiredTokenWithoutWriting(t *testing.T) {
	state := &fakeState{}
	resetQueryHandler(state, time.Now().Add(-time.Minute).UTC())

	_, err := resetService(state).resetPassword(context.Background(), "tok", "new-password", nil)
	if got := errorMessage(t, err); got != passwordResetTokenMessage {
		t.Fatalf("messages = %q", got)
	}
	if len(state.executedStatements()) != 0 {
		t.Fatal("an expired token must not write anything")
	}
}

func TestResetPasswordRejectsShortPasswordAfterTokenCheck(t *testing.T) {
	state := &fakeState{}
	resetQueryHandler(state, time.Now().Add(time.Hour).UTC())

	_, err := resetService(state).resetPassword(context.Background(), "tok", "   short   ", nil)
	if got := errorMessage(t, err); got != passwordTooShortMessage {
		t.Fatalf("messages = %q", got)
	}
	if len(state.executedStatements()) != 0 {
		t.Fatal("a rejected password must not write anything")
	}
}
