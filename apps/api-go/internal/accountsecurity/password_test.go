package accountsecurity

import (
	"bytes"
	"context"
	"database/sql/driver"
	"errors"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

const (
	testCurrentPassword = "current-password"
	testNewPassword     = "brand-new-password"
)

func bcryptHashForTest(t *testing.T, password string) string {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword(nodeBcryptPassword(password), bcryptCost)
	if err != nil {
		t.Fatalf("bcrypt: %v", err)
	}
	return string(hash)
}

// TestNodeBcryptPasswordTruncatesLikeNode covers the Node bcrypt@5.1.1
// behaviour: UTF-8 bytes, stop at the first NUL, cap at 72 bytes.
func TestNodeBcryptPasswordTruncatesLikeNode(t *testing.T) {
	ascii := strings.Repeat("a", 80)
	if got := nodeBcryptPassword(ascii); len(got) != 72 || !bytes.Equal(got, []byte(ascii[:72])) {
		t.Fatalf("ascii truncation = %d bytes", len(got))
	}

	// 36 two-byte characters are exactly 72 bytes; a 37th pushes past the cap.
	accented := strings.Repeat("é", 37)
	rawAccented := []byte(accented)
	if len(rawAccented) != 74 {
		t.Fatalf("fixture length = %d", len(rawAccented))
	}
	if got := nodeBcryptPassword(accented); len(got) != 72 || !bytes.Equal(got, rawAccented[:72]) {
		t.Fatalf("multibyte truncation = %d bytes", len(got))
	}

	// A three-byte character crossing byte 72 is cut mid-sequence, never rounded
	// to a character boundary.
	crossing := strings.Repeat("a", 71) + "€"
	rawCrossing := []byte(crossing)
	if len(rawCrossing) != 74 {
		t.Fatalf("crossing fixture length = %d", len(rawCrossing))
	}
	got := nodeBcryptPassword(crossing)
	if len(got) != 72 || !bytes.Equal(got, rawCrossing[:72]) {
		t.Fatalf("crossing truncation = %v", got)
	}

	if got := nodeBcryptPassword("abc\x00def"); string(got) != "abc" {
		t.Fatalf("NUL handling = %q", got)
	}
	if got := nodeBcryptPassword("short"); string(got) != "short" {
		t.Fatalf("short password mutated = %q", got)
	}
}

// TestNodeBcryptPasswordCrossLanguageCompat proves the adapter is what makes
// Node-generated and Go-generated hashes interchangeable for long passwords.
func TestNodeBcryptPasswordCrossLanguageCompat(t *testing.T) {
	base := strings.Repeat("p", 72)
	hash, err := bcrypt.GenerateFromPassword(nodeBcryptPassword(base+"SUFFIX-ONE"), bcryptCost)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}

	// The same 72-byte prefix with a different suffix must verify: Node bcrypt
	// ignores everything after byte 72.
	if err := bcrypt.CompareHashAndPassword(hash, nodeBcryptPassword(base+"SUFFIX-TWO")); err != nil {
		t.Fatalf("same 72-byte prefix must verify: %v", err)
	}
	// A different 72-byte prefix must not verify.
	if err := bcrypt.CompareHashAndPassword(hash, nodeBcryptPassword(strings.Repeat("q", 72))); err == nil {
		t.Fatalf("different prefix verified")
	}
	// Feeding the untruncated 78-byte password straight to Go bcrypt is exactly
	// the failure mode the adapter exists to prevent.
	if err := bcrypt.CompareHashAndPassword(hash, []byte(base+"SUFFIX-ONE")); !errors.Is(err, bcrypt.ErrPasswordTooLong) {
		t.Fatalf("expected ErrPasswordTooLong, got %v", err)
	}
}

func TestChangePasswordValidatesRawStringsFirst(t *testing.T) {
	service := &Service{}
	if err := service.changePassword(context.Background(), "user-1", "org-1", "", testNewPassword); err == nil {
		t.Fatalf("missing fields accepted")
	} else {
		wantBadRequest(t, err, "Password fields are required")
	}
	// The raw-string comparison runs before any bcrypt work or database access.
	if err := service.changePassword(context.Background(), "user-1", "org-1", testNewPassword, testNewPassword); err == nil {
		t.Fatalf("identical passwords accepted")
	} else {
		wantBadRequest(t, err, "New password must be different from current password")
	}
}

func TestChangePasswordRejectsWrongCurrentPassword(t *testing.T) {
	state := &fakeState{
		queryHandler: func(string, []driver.NamedValue) (driver.Rows, error) {
			return rowsWithValues([]string{"passwordHash"}, bcryptHashForTest(t, "another-password")), nil
		},
	}
	service := NewService(newFakeDB(state), nil, Config{})
	err := service.changePassword(context.Background(), "user-1", "org-1", testCurrentPassword, testNewPassword)
	if err == nil {
		t.Fatalf("wrong password accepted")
	}
	var coded *httpError
	if !errors.As(err, &coded) || coded.status != 401 || coded.message != "Invalid credentials" {
		t.Fatalf("err = %v", err)
	}
	if statements := state.executedStatements(); len(statements) != 0 {
		t.Fatalf("unexpected writes: %v", statements)
	}
}

// TestChangePasswordCASConflict mirrors AS2: the conditional UPDATE affects zero
// rows, so the request aborts with 409, the transaction rolls back and the
// RefreshToken revoke never runs.
func TestChangePasswordCASConflict(t *testing.T) {
	state := &fakeState{}
	state.queryHandler = func(string, []driver.NamedValue) (driver.Rows, error) {
		return rowsWithValues([]string{"passwordHash"}, bcryptHashForTest(t, testCurrentPassword)), nil
	}
	state.execHandler = func(query string, _ []driver.NamedValue) (driver.Result, error) {
		if strings.Contains(query, "UPDATE `User`") {
			return fakeResult{rows: 0}, nil
		}
		return fakeResult{rows: 1}, nil
	}
	service := NewService(newFakeDB(state), nil, Config{})

	err := service.changePassword(context.Background(), "user-1", "org-1", testCurrentPassword, testNewPassword)
	var coded *httpError
	if !errors.As(err, &coded) || coded.status != 409 {
		t.Fatalf("err = %v", err)
	}
	if coded.message != "Password changed by another request; retry with the current password" {
		t.Fatalf("message = %q", coded.message)
	}
	commits, rollbacks := state.txCounts()
	if commits != 0 || rollbacks != 1 {
		t.Fatalf("commits=%d rollbacks=%d", commits, rollbacks)
	}
	for _, statement := range state.executedStatements() {
		if strings.Contains(statement, "RefreshToken") {
			t.Fatalf("refresh revoke ran after a failed CAS: %s", statement)
		}
	}
}

// TestChangePasswordSuccessUsesCASAndRevokesRefreshTokens asserts the winning
// path: one conditional User UPDATE plus the all-sessions RefreshToken revoke in
// the same committed transaction, with a cost-10 hash of the new password.
func TestChangePasswordSuccessUsesCASAndRevokesRefreshTokens(t *testing.T) {
	oldHash := bcryptHashForTest(t, testCurrentPassword)
	state := &fakeState{}
	state.queryHandler = func(string, []driver.NamedValue) (driver.Rows, error) {
		return rowsWithValues([]string{"passwordHash"}, oldHash), nil
	}
	var newHashValue driver.Value
	state.execHandler = func(query string, args []driver.NamedValue) (driver.Result, error) {
		if strings.Contains(query, "UPDATE `User`") {
			newHashValue = namedArg(args, 1)
		}
		return fakeResult{rows: 1}, nil
	}
	service := NewService(newFakeDB(state), nil, Config{})

	// The profile-cache invalidation needs Redis, which is intentionally not
	// injected here; the committed transaction is what this test asserts.
	err := service.changePassword(context.Background(), "user-1", "org-1", testCurrentPassword, testNewPassword)
	if err != nil && !errors.Is(err, errNoRedis) {
		t.Fatalf("unexpected error: %v", err)
	}

	commits, rollbacks := state.txCounts()
	if commits != 1 || rollbacks != 0 {
		t.Fatalf("commits=%d rollbacks=%d", commits, rollbacks)
	}

	userUpdate := ""
	refreshUpdate := ""
	for _, statement := range state.executedStatements() {
		switch {
		case strings.Contains(statement, "UPDATE `User`"):
			userUpdate = statement
		case strings.Contains(statement, "RefreshToken"):
			refreshUpdate = statement
		}
	}
	if !strings.Contains(userUpdate, "`passwordHash` = ?") || !strings.Contains(userUpdate, "AND `passwordHash` = ?") {
		t.Fatalf("user update is not a CAS: %s", userUpdate)
	}
	if !strings.Contains(refreshUpdate, "`revokedAt` = ?") || !strings.Contains(refreshUpdate, "`revokedAt` IS NULL") {
		t.Fatalf("refresh revoke statement: %s", refreshUpdate)
	}
	if !strings.Contains(refreshUpdate, "`userId` = ?") {
		t.Fatalf("refresh revoke must be scoped to the user: %s", refreshUpdate)
	}

	newHash, ok := newHashValue.(string)
	if !ok || newHash == "" {
		t.Fatalf("captured hash = %#v", newHashValue)
	}
	if cost, costErr := bcrypt.Cost([]byte(newHash)); costErr != nil || cost != bcryptCost {
		t.Fatalf("cost = %d err = %v", cost, costErr)
	}
	if err := bcrypt.CompareHashAndPassword([]byte(newHash), nodeBcryptPassword(testNewPassword)); err != nil {
		t.Fatalf("stored hash does not match the new password: %v", err)
	}
}
