package authfactors

import (
	"context"
	"database/sql"
	"errors"
)

// This file is the narrow, exported factor port the auth-login batch
// (internal/authlogin) reuses. The login chain deliberately shares the existing
// TOTP, recovery-code, secret-encryption, pending-promotion and profile-cache
// invalidation implementations instead of growing a second copy: a second TOTP
// verifier or a second recovery-code claim would silently drift from the one
// the authenticated MFA management routes already use.
//
// Only the pieces the public login and forced-enrollment flows need are
// exported. No existing method, message or status code changes.

// LoginMfaStatus is the exported factor summary the login chain reads. NestJS
// derives the authenticated user's `mfaEnabled` flag and the login requirement
// from MfaService.getStatus().enabled, so only that flag is exposed.
type LoginMfaStatus struct {
	Enabled bool
}

// LoginEnrollment is the one-shot enrollment secret and its otpauth URI.
type LoginEnrollment struct {
	Secret     string
	OtpauthURI string
}

// LoginEnrollmentResult is the successful forced-enrollment completion: the
// plaintext recovery codes that are handed to the user exactly once.
type LoginEnrollmentResult struct {
	RecoveryCodes []string
}

// LoginMfaStatus wraps GetStatus for the login chain.
func (s *Service) LoginMfaStatus(ctx context.Context, userID string) (LoginMfaStatus, error) {
	status, err := s.GetStatus(ctx, userID)
	if err != nil {
		return LoginMfaStatus{}, err
	}
	return LoginMfaStatus{Enabled: status.Enabled}, nil
}

// LoginBeginEnrollment wraps BeginEnrollment. The account name stays the
// caller's stored email and is never request-supplied.
func (s *Service) LoginBeginEnrollment(ctx context.Context, userID string) (LoginEnrollment, error) {
	enrollment, err := s.BeginEnrollment(ctx, userID)
	if err != nil {
		return LoginEnrollment{}, err
	}
	return LoginEnrollment{Secret: enrollment.Secret, OtpauthURI: enrollment.OtpauthURI}, nil
}

// LoginVerifyEnrollment wraps VerifyEnrollment. It is called only after the
// enrollment challenge has been claimed, so two concurrent completions can never
// both rotate the secret and the recovery-code set.
func (s *Service) LoginVerifyEnrollment(ctx context.Context, userID, code string) (LoginEnrollmentResult, error) {
	result, err := s.VerifyEnrollment(ctx, userID, code)
	if err != nil {
		return LoginEnrollmentResult{}, err
	}
	return LoginEnrollmentResult{RecoveryCodes: result.RecoveryCodes}, nil
}

// LoginVerifyCredential runs the shared TOTP-or-recovery-code check on the
// caller's transaction, so the single-use recovery-code claim and the factor's
// lastUsedAt refresh commit together with whatever the caller does next.
//
// The caller owns the transaction: this function never opens its own, which is
// what keeps the public login challenge's single-use guarantee intact when the
// challenge is consumed after the credential verified.
func (s *Service) LoginVerifyCredential(ctx context.Context, tx *sql.Tx, userID, code string) error {
	_, err := s.verifyFactorOrRecoveryCode(ctx, tx, userID, code)
	return err
}

// IsInvalidMfaCode reports the shared "Invalid MFA verification code" failure.
// The login challenge counts only that failure against the attempt budget and
// gives a claimed enrollment challenge back only for it; a database or
// encryption error must keep its own meaning instead.
func IsInvalidMfaCode(err error) bool {
	var coded *httpError
	if errors.As(err, &coded) {
		return coded.message == mfaInvalidCodeMessage
	}
	return false
}
