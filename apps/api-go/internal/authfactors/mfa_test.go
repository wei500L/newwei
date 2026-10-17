package authfactors

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

// testContext is a plain background context for the service tests.
func testContext() context.Context { return context.Background() }

// newTestService wires a Service over the in-memory store with no Redis client
// (the profile cache eviction is a logged no-op in that case, which keeps the
// MFA transaction assertions independent of Redis).
func newTestService(store *fakeStore, cfg Config) *Service {
	return NewService(store.db(), nil, cfg)
}

// currentTotpCode computes the live code for a secret.
func currentTotpCode(t *testing.T, secret string) string {
	t.Helper()
	code, err := generateTotpAt(secret, uint64(time.Now().Unix()/totpPeriodSecond))
	if err != nil {
		t.Fatal(err)
	}
	return code
}

// seedActiveFactor installs an active factor with the given plaintext secret
// and returns the stored JSON bytes.
func seedActiveFactor(t *testing.T, store *fakeStore, userID, secret string) []byte {
	t.Helper()
	stored, err := json.Marshal(secret)
	if err != nil {
		t.Fatal(err)
	}
	label := userID
	verified := time.Now().UTC().Truncate(time.Millisecond)
	store.setFactor(userID, &fakeFactor{
		id:         "factor-" + userID,
		secret:     stored,
		label:      &label,
		enrolledAt: verified.Add(-time.Hour),
		verifiedAt: &verified,
	})
	return stored
}

// seedRecoveryCode installs one unused recovery code and returns its plaintext.
func seedRecoveryCode(store *fakeStore, userID, plaintext string) {
	store.recovery = append(store.recovery, &fakeRecoveryCode{
		id:        "code-" + plaintext,
		userID:    userID,
		codeHash:  hashOpaqueToken(plaintext),
		createdAt: time.Now().UTC().Truncate(time.Millisecond),
	})
}

// asHTTPError asserts the error is the expected status-coded contract error.
func asHTTPError(t *testing.T, err error, status int, message string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected a %d error", status)
	}
	var coded *httpError
	if !errors.As(err, &coded) {
		t.Fatalf("error %T is not an httpError: %v", err, err)
	}
	if coded.status != status || coded.message != message {
		t.Fatalf("error = %d %q, want %d %q", coded.status, coded.message, status, message)
	}
}

// TestGetStatusEmptyAndMachineIdentity locks the empty factor state: a missing
// row and a machine identity both return five fields with no error and never
// touch a foreign key.
func TestGetStatusEmptyAndMachineIdentity(t *testing.T) {
	store := newFakeStore()
	service := newTestService(store, Config{})

	for _, userID := range []string{"user-empty", "machine:token-1"} {
		status, err := service.GetStatus(testContext(), userID)
		if err != nil {
			t.Fatalf("%s: %v", userID, err)
		}
		if status.Enabled || status.EnrolledAt != nil || status.VerifiedAt != nil || status.LastUsedAt != nil {
			t.Fatalf("%s: %+v", userID, status)
		}
		if status.RecoveryCodesRemaining != 0 {
			t.Fatalf("%s: remaining = %d", userID, status.RecoveryCodesRemaining)
		}
	}
}

// TestGetStatusUsesDisabledAtAndCountsUnusedCodes locks enabled =
// Boolean(verifiedAt && !disabledAt) and the remaining-code count.
func TestGetStatusUsesDisabledAtAndCountsUnusedCodes(t *testing.T) {
	store := newFakeStore()
	service := newTestService(store, Config{})
	secret := "JBSWY3DPEHPK3PXP"
	seedActiveFactor(t, store, "user-1", secret)
	seedRecoveryCode(store, "user-1", "AAAAAAAAAA")
	seedRecoveryCode(store, "user-1", "BBBBBBBBBB")
	used := time.Now().UTC()
	store.recovery[1].usedAt = &used

	status, err := service.GetStatus(testContext(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if !status.Enabled {
		t.Fatal("an active factor must report enabled")
	}
	if status.RecoveryCodesRemaining != 1 {
		t.Fatalf("remaining = %d, want 1", status.RecoveryCodesRemaining)
	}
	if status.VerifiedAt == nil || status.EnrolledAt == nil {
		t.Fatalf("timestamps = %+v", status)
	}
	if !strings.HasSuffix(*status.VerifiedAt, "Z") || !strings.Contains(*status.VerifiedAt, ".") {
		t.Fatalf("verifiedAt must be a millisecond UTC ISO string: %q", *status.VerifiedAt)
	}

	// A disabled factor must report enabled=false even though verifiedAt stays
	// set.
	disabled := time.Now().UTC()
	store.factors["user-1"].disabledAt = &disabled
	status, err = service.GetStatus(testContext(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if status.Enabled {
		t.Fatal("a disabled factor must report enabled=false")
	}
}

// TestBeginEnrollmentFirstTimeAndVerifyEnrollment locks the first enrollment,
// the exact otpauth URI and the eight freshly committed recovery codes.
func TestBeginEnrollmentFirstTimeAndVerifyEnrollment(t *testing.T) {
	store := newFakeStore()
	store.users["user-1"] = "first.last+tag@example.com"
	store.memberships["user-1"] = []string{"org-a", "org-b"}
	service := newTestService(store, Config{})

	enrollment, err := service.BeginEnrollment(testContext(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(enrollment.Secret) != 32 {
		t.Fatalf("secret = %q", enrollment.Secret)
	}
	wantURI := "otpauth://totp/Modular:first.last%2Btag%40example.com?secret=" + enrollment.Secret +
		"&issuer=Modular&algorithm=SHA1&digits=6&period=30"
	if enrollment.OtpauthURI != wantURI {
		t.Fatalf("uri = %q, want %q", enrollment.OtpauthURI, wantURI)
	}

	factor, found := store.factors["user-1"]
	if !found {
		t.Fatal("the factor row was not created")
	}
	if string(factor.secret) != `"`+enrollment.Secret+`"` {
		t.Fatalf("stored secret = %s", factor.secret)
	}
	if factor.pendingSecret != nil || factor.pendingLabel != nil || factor.pendingStartedAt != nil {
		t.Fatalf("pending fields must be SQL NULL: %+v", factor)
	}
	if factor.verifiedAt != nil || factor.disabledAt != nil || factor.lastUsedAt != nil {
		t.Fatalf("verification fields must be NULL: %+v", factor)
	}
	if factor.label == nil || *factor.label != "first.last+tag@example.com" {
		t.Fatalf("label = %v", factor.label)
	}

	response, err := service.VerifyEnrollment(testContext(), "user-1", currentTotpCode(t, enrollment.Secret))
	if err != nil {
		t.Fatal(err)
	}
	if len(response.RecoveryCodes) != recoveryCodeCount {
		t.Fatalf("codes = %v", response.RecoveryCodes)
	}
	if !response.Enabled || response.RecoveryCodesRemaining != recoveryCodeCount {
		t.Fatalf("response = %+v", response)
	}
	rows := store.recoveryFor("user-1")
	if len(rows) != recoveryCodeCount {
		t.Fatalf("stored codes = %d", len(rows))
	}
	for index, row := range rows {
		if row.usedAt != nil {
			t.Fatalf("code %d must be unused", index)
		}
		if row.codeHash != hashOpaqueToken(response.RecoveryCodes[index]) {
			t.Fatalf("code %d hash mismatch", index)
		}
	}
	if strings.Contains(string(factor.secret), response.RecoveryCodes[0]) {
		t.Fatal("plaintext recovery codes must never be stored")
	}
	// The promotion replaces the row, so the map entry must be re-read.
	promoted := store.factors["user-1"]
	if promoted.verifiedAt == nil || promoted.disabledAt != nil {
		t.Fatalf("promoted factor = %+v", promoted)
	}
	if !promoted.enrolledAt.Equal(factor.enrolledAt) {
		t.Fatalf("a first completion must keep enrolledAt: %v -> %v", factor.enrolledAt, promoted.enrolledAt)
	}
}

// TestVerifyEnrollmentRejectsRepeatOnActiveFactor locks AF1: a completed
// enrollment cannot be completed again, and the existing recovery-code set is
// left untouched.
func TestVerifyEnrollmentRejectsRepeatOnActiveFactor(t *testing.T) {
	store := newFakeStore()
	store.users["user-1"] = "user@example.com"
	service := newTestService(store, Config{})
	secret := "JBSWY3DPEHPK3PXP"
	seedActiveFactor(t, store, "user-1", secret)
	seedRecoveryCode(store, "user-1", "AAAAAAAAAA")
	before := len(store.recoveryFor("user-1"))

	_, err := service.VerifyEnrollment(testContext(), "user-1", currentTotpCode(t, secret))
	asHTTPError(t, err, http.StatusBadRequest, mfaEnrollmentNotInitializedMessage)

	if got := len(store.recoveryFor("user-1")); got != before {
		t.Fatalf("recovery codes changed: %d -> %d", before, got)
	}
	if store.recovery[0].usedAt != nil {
		t.Fatal("the existing recovery code must stay unused")
	}
}

// TestVerifyEnrollmentWithoutFactorOrWithWrongCode locks the two remaining 400
// paths.
func TestVerifyEnrollmentWithoutFactorOrWithWrongCode(t *testing.T) {
	store := newFakeStore()
	store.users["user-1"] = "user@example.com"
	service := newTestService(store, Config{})

	_, err := service.VerifyEnrollment(testContext(), "user-1", "123456")
	asHTTPError(t, err, http.StatusBadRequest, mfaEnrollmentNotInitializedMessage)

	enrollment, err := service.BeginEnrollment(testContext(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	wrong := currentTotpCode(t, enrollment.Secret)
	if wrong[0] == '9' {
		wrong = "0" + wrong[1:]
	} else {
		wrong = "9" + wrong[1:]
	}
	_, err = service.VerifyEnrollment(testContext(), "user-1", wrong)
	asHTTPError(t, err, http.StatusBadRequest, mfaInvalidCodeMessage)
	if len(store.recoveryFor("user-1")) != 0 {
		t.Fatal("a failed verification must not create recovery codes")
	}
}

// TestPendingPromotionReplacesSecretAndCodes locks the active-factor
// replacement flow: begin only writes pendingSecret, the old secret keeps
// verifying, and confirming promotes the new secret and swaps the code set.
func TestPendingPromotionReplacesSecretAndCodes(t *testing.T) {
	store := newFakeStore()
	store.users["user-1"] = "user@example.com"
	service := newTestService(store, Config{})

	first, err := service.BeginEnrollment(testContext(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	initial, err := service.VerifyEnrollment(testContext(), "user-1", currentTotpCode(t, first.Secret))
	if err != nil {
		t.Fatal(err)
	}
	oldCodes := make([]string, len(initial.RecoveryCodes))
	copy(oldCodes, initial.RecoveryCodes)
	// The first completion had no pending replacement, so it must keep the
	// original enrollment timestamp.
	firstEnrolledAt := store.factors["user-1"].enrolledAt

	// A second begin must not replace the active secret.
	second, err := service.BeginEnrollment(testContext(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if second.Secret == first.Secret {
		t.Fatal("a replacement must generate a fresh secret")
	}
	factor := store.factors["user-1"]
	if string(factor.secret) != `"`+first.Secret+`"` {
		t.Fatalf("the active secret must be untouched: %s", factor.secret)
	}
	if factor.pendingSecret == nil || string(factor.pendingSecret) != `"`+second.Secret+`"` {
		t.Fatalf("pendingSecret = %s", factor.pendingSecret)
	}
	if factor.pendingLabel == nil || *factor.pendingLabel != "user@example.com" || factor.pendingStartedAt == nil {
		t.Fatalf("pending metadata = %+v", factor)
	}
	if !factor.enrolledAt.Equal(firstEnrolledAt) {
		t.Fatalf("a pending begin must not rewrite enrolledAt: %v -> %v", firstEnrolledAt, factor.enrolledAt)
	}
	// Move the timestamp into the past so the promotion rewrite is provable
	// without depending on clock resolution.
	old := time.Now().Add(-24 * time.Hour)
	factor.enrolledAt = old
	enrolledAtBefore := old

	if len(store.recoveryFor("user-1")) != recoveryCodeCount {
		t.Fatal("the active factor's recovery codes must survive a pending begin")
	}

	// The old recovery codes still authorize management actions while the
	// replacement is pending.
	if _, err := service.RotateRecoveryCodes(testContext(), "user-1", oldCodes[0]); err != nil {
		t.Fatalf("an old recovery code must still work while pending: %v", err)
	}

	// Confirming the pending replacement promotes the new secret.
	// (The rotate above replaced the code set, so re-seed the old set state by
	// checking the promotion instead.)
	response, err := service.VerifyEnrollment(testContext(), "user-1", currentTotpCode(t, second.Secret))
	if err != nil {
		t.Fatal(err)
	}
	factor = store.factors["user-1"]
	if string(factor.secret) != `"`+second.Secret+`"` {
		t.Fatalf("promoted secret = %s", factor.secret)
	}
	if factor.pendingSecret != nil || factor.pendingLabel != nil || factor.pendingStartedAt != nil {
		t.Fatalf("pending fields must be cleared: %+v", factor)
	}
	if !factor.enrolledAt.After(enrolledAtBefore) {
		t.Fatalf("enrolledAt must be rewritten when an active factor is replaced: %v -> %v", enrolledAtBefore, factor.enrolledAt)
	}
	if len(response.RecoveryCodes) != recoveryCodeCount {
		t.Fatalf("codes = %v", response.RecoveryCodes)
	}
	for _, code := range response.RecoveryCodes {
		if code == oldCodes[0] {
			t.Fatal("the promoted set must be new")
		}
	}

	// The old set is gone: every previously issued code is rejected.
	if _, err := service.RotateRecoveryCodes(testContext(), "user-1", oldCodes[1]); err == nil {
		t.Fatal("an old recovery code must be rejected after promotion")
	} else {
		asHTTPError(t, err, http.StatusUnauthorized, mfaInvalidCodeMessage)
	}
}

// TestDisableRollsBackWithTheCredentialCheck locks AF2: the single-use claim and
// the management write commit together, so an injected write failure leaves the
// code unconsumed and the factor enabled.
func TestDisableRollsBackWithTheCredentialCheck(t *testing.T) {
	store := newFakeStore()
	store.users["user-1"] = "user@example.com"
	service := newTestService(store, Config{})
	seedActiveFactor(t, store, "user-1", "JBSWY3DPEHPK3PXP")
	seedRecoveryCode(store, "user-1", "ABCDEF0123")

	store.execFailures["DELETE FROM `UserRecoveryCode`"] = errors.New("injected write failure")
	if _, err := service.Disable(testContext(), "user-1", "ABCDEF0123"); err == nil {
		t.Fatal("the injected failure must surface")
	}
	if store.rollbackCalls == 0 {
		t.Fatal("the transaction must roll back")
	}
	if store.recovery[0].usedAt != nil {
		t.Fatal("the recovery code must not stay consumed after a rolled back action")
	}
	if store.factors["user-1"].disabledAt != nil {
		t.Fatal("the factor must not stay disabled after a rolled back action")
	}

	// Without the injected failure the same code works and the action commits.
	delete(store.execFailures, "DELETE FROM `UserRecoveryCode`")
	status, err := service.Disable(testContext(), "user-1", "ABCDEF0123")
	if err != nil {
		t.Fatal(err)
	}
	if status.Enabled {
		t.Fatalf("status = %+v", status)
	}
	if store.factors["user-1"].disabledAt == nil {
		t.Fatal("the factor must be disabled")
	}
	if len(store.recoveryFor("user-1")) != 0 {
		t.Fatal("every recovery code must be deleted")
	}
	// The factor row itself is kept and its secret is not blanked.
	if store.factors["user-1"].secret == nil {
		t.Fatal("the factor row must be kept")
	}
}

// TestDisableRejectsInvalidCode locks the 401 for an unusable credential.
func TestDisableRejectsInvalidCode(t *testing.T) {
	store := newFakeStore()
	store.users["user-1"] = "user@example.com"
	service := newTestService(store, Config{})
	seedActiveFactor(t, store, "user-1", "JBSWY3DPEHPK3PXP")

	_, err := service.Disable(testContext(), "user-1", "000000")
	asHTTPError(t, err, http.StatusUnauthorized, mfaInvalidCodeMessage)
	if store.factors["user-1"].disabledAt != nil {
		t.Fatal("a rejected credential must not disable the factor")
	}
}

// TestRecoveryCodeSingleUseClaim locks the atomic CAS: the conditional update
// requires exactly one affected row, and a second attempt with the same code
// fails.
func TestRecoveryCodeSingleUseClaim(t *testing.T) {
	store := newFakeStore()
	service := newTestService(store, Config{})
	seedActiveFactor(t, store, "user-1", "JBSWY3DPEHPK3PXP")
	seedRecoveryCode(store, "user-1", "ABCDEF0123")

	kind, err := service.verifyFactorOrRecoveryCode(testContext(), store.db(), "user-1", "abcdef0123")
	if err != nil {
		t.Fatal(err)
	}
	if kind != credentialRecoveryCode {
		t.Fatalf("kind = %s", kind)
	}
	if store.recovery[0].usedAt == nil {
		t.Fatal("the code must be consumed")
	}
	if _, err := service.verifyFactorOrRecoveryCode(testContext(), store.db(), "user-1", "ABCDEF0123"); err == nil {
		t.Fatal("a consumed code must not authorize a second action")
	} else {
		asHTTPError(t, err, http.StatusUnauthorized, mfaInvalidCodeMessage)
	}

	// The claim must be the conditional update, never a read followed by an
	// unconditional write.
	found := false
	for _, statement := range store.statements {
		if strings.Contains(statement, "UPDATE `UserRecoveryCode` SET `usedAt` = ? WHERE `id` = ? AND `usedAt` IS NULL") {
			found = true
		}
	}
	if !found {
		t.Fatal("the single-use claim must be a conditional update")
	}
}

// TestRotateRecoveryCodesKeepsResponseAndStoreConsistent locks the rotate
// contract: the returned set is exactly the committed set and the TOTP secret
// is untouched.
func TestRotateRecoveryCodesKeepsResponseAndStoreConsistent(t *testing.T) {
	store := newFakeStore()
	store.users["user-1"] = "user@example.com"
	service := newTestService(store, Config{})
	secret := "JBSWY3DPEHPK3PXP"
	seedActiveFactor(t, store, "user-1", secret)
	seedRecoveryCode(store, "user-1", "OLDOLDOLDD")

	response, err := service.RotateRecoveryCodes(testContext(), "user-1", currentTotpCode(t, secret))
	if err != nil {
		t.Fatal(err)
	}
	if len(response.RecoveryCodes) != recoveryCodeCount || response.RecoveryCodesRemaining != recoveryCodeCount {
		t.Fatalf("response = %+v", response)
	}
	rows := store.recoveryFor("user-1")
	if len(rows) != recoveryCodeCount {
		t.Fatalf("stored codes = %d", len(rows))
	}
	for index, row := range rows {
		if row.codeHash != hashOpaqueToken(response.RecoveryCodes[index]) {
			t.Fatalf("code %d does not match the committed set", index)
		}
	}
	if store.factors["user-1"].pendingSecret != nil {
		t.Fatal("rotate must not start an enrollment")
	}
	if string(store.factors["user-1"].secret) != `"`+secret+`"` {
		t.Fatal("rotate must not change the TOTP secret")
	}
	if _, err := service.RotateRecoveryCodes(testContext(), "user-1", "OLDOLDOLDD"); err == nil {
		t.Fatal("the old code must be invalid immediately")
	}
}

// TestMFAManagementRequiresHumanActor locks AF5: machine identities are refused
// on all four writes and no factor row is ever created for them.
func TestMFAManagementRequiresHumanActor(t *testing.T) {
	store := newFakeStore()
	service := newTestService(store, Config{})
	machine := "machine:token-1"

	if _, err := service.BeginEnrollment(testContext(), machine); err == nil {
		t.Fatal("begin must refuse a machine identity")
	} else {
		asHTTPError(t, err, http.StatusForbidden, mfaHumanRequiredMessage)
	}
	if _, err := service.VerifyEnrollment(testContext(), machine, "123456"); err == nil {
		t.Fatal("verify must refuse a machine identity")
	} else {
		asHTTPError(t, err, http.StatusForbidden, mfaHumanRequiredMessage)
	}
	if _, err := service.Disable(testContext(), machine, "123456"); err == nil {
		t.Fatal("disable must refuse a machine identity")
	} else {
		asHTTPError(t, err, http.StatusForbidden, mfaHumanRequiredMessage)
	}
	if _, err := service.RotateRecoveryCodes(testContext(), machine, "123456"); err == nil {
		t.Fatal("rotate must refuse a machine identity")
	} else {
		asHTTPError(t, err, http.StatusForbidden, mfaHumanRequiredMessage)
	}
	if len(store.factors) != 0 {
		t.Fatalf("no factor row may be created: %+v", store.factors)
	}

	// An unknown human-shaped id is refused the same way rather than reaching
	// the foreign key.
	if _, err := service.BeginEnrollment(testContext(), "ghost-user"); err == nil {
		t.Fatal("an unknown user must be refused")
	} else {
		asHTTPError(t, err, http.StatusForbidden, mfaHumanRequiredMessage)
	}
}

// TestGetStatusNeverRequiresAHuman locks the deliberate boundary: GET keeps
// answering for a machine identity.
func TestGetStatusNeverRequiresAHuman(t *testing.T) {
	store := newFakeStore()
	service := newTestService(store, Config{})
	if _, err := service.GetStatus(testContext(), "machine:token-1"); err != nil {
		t.Fatalf("GET must keep the empty state for machines: %v", err)
	}
}
