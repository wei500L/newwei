package authfactors

import (
	"context"
	"net/http"
)

// credentialKind names the credential that authorized an MFA management
// action. Both branches share one code path so the transaction boundary is
// identical.
type credentialKind string

const (
	// credentialTOTP is the current factor's live TOTP code.
	credentialTOTP credentialKind = "totp"
	// credentialRecoveryCode is one unused recovery code.
	credentialRecoveryCode credentialKind = "recovery_code"
)

// GetStatus returns the five-field factor summary for the authenticated user.
//
// Only the authenticated user id is consulted; no other user id can be
// supplied. A missing factor row yields the empty state (enabled false, three
// null dates, zero remaining codes) rather than an error — which is also what a
// machine identity gets, because a machine id simply has no factor row and no
// recovery codes. This route never creates or updates anything.
func (s *Service) GetStatus(ctx context.Context, userID string) (mfaStatus, error) {
	if s == nil || s.db == nil {
		return mfaStatus{}, errNoDatabase
	}
	factor, found, err := s.loadFactor(ctx, s.db, userID)
	if err != nil {
		return mfaStatus{}, err
	}
	remaining, err := s.countUnusedRecoveryCodes(ctx, s.db, userID)
	if err != nil {
		return mfaStatus{}, err
	}
	return statusFromFactor(factor, found, remaining), nil
}

// statusFromFactor renders the factor summary. enrolledAt is NOT NULL in the
// schema, so it is present whenever the row exists; verifiedAt and lastUsedAt
// are nullable.
func statusFromFactor(factor mfaFactorRow, found bool, remaining int) mfaStatus {
	if !found {
		return mfaStatus{Enabled: false, RecoveryCodesRemaining: remaining}
	}
	return mfaStatus{
		Enabled:                factor.active(),
		EnrolledAt:             nestTimestampPtr(timestampValue(factor.EnrolledAt)),
		VerifiedAt:             nestTimestampPtr(factor.VerifiedAt),
		LastUsedAt:             nestTimestampPtr(factor.LastUsedAt),
		RecoveryCodesRemaining: remaining,
	}
}

// BeginEnrollment starts (or restarts) a TOTP enrollment for a human user.
//
// The account name is always the caller's own stored email — it can never be
// supplied by the request, matching the NestJS handler that passes
// `user.email`. The plaintext secret is returned exactly once and is never
// logged. When an active factor already exists the new secret is written to
// pendingSecret only: the verified secret, its verification timestamp and the
// current recovery codes all keep working until the pending enrollment is
// confirmed. Any other state replaces the secret outright and clears every
// pending/verification field.
func (s *Service) BeginEnrollment(ctx context.Context, userID string) (mfaEnrollmentResponse, error) {
	accountName, err := s.requireHumanActor(ctx, userID)
	if err != nil {
		return mfaEnrollmentResponse{}, err
	}
	secret, err := generateTotpSecret()
	if err != nil {
		return mfaEnrollmentResponse{}, err
	}
	stored, err := s.encodeSecret(ctx, secret)
	if err != nil {
		return mfaEnrollmentResponse{}, err
	}

	err = s.withUserLock(ctx, userID, func(ctx context.Context) error {
		factor, found, err := s.loadFactor(ctx, s.db, userID)
		if err != nil {
			return err
		}
		if found && factor.active() {
			return s.startPendingReplacement(ctx, s.db, userID, stored, accountName)
		}
		return s.upsertFactorSecret(ctx, s.db, userID, stored, accountName)
	})
	if err != nil {
		return mfaEnrollmentResponse{}, err
	}

	return mfaEnrollmentResponse{
		Secret:     secret,
		OtpauthURI: buildOtpAuthURI(accountName, secret),
	}, nil
}

// VerifyEnrollment completes an enrollment, promotes the pending secret when
// one exists, and replaces the recovery-code set.
//
// AF1: a factor that is already active with no pending replacement has already
// completed its enrollment. Completing it again would rotate the recovery codes
// out from under the previous response, so it is refused with the same message
// as "no enrollment in progress".
//
// The factor promotion and the recovery-code replacement commit in one
// transaction. The profile cache is invalidated after the commit, inside the
// per-user lock, and the transaction is never replayed — so a cache failure can
// never regenerate a second set of codes.
func (s *Service) VerifyEnrollment(ctx context.Context, userID, code string) (mfaRecoveryResponse, error) {
	if _, err := s.requireHumanActor(ctx, userID); err != nil {
		return mfaRecoveryResponse{}, err
	}
	codes, err := generateRecoveryCodes(recoveryCodeCount)
	if err != nil {
		return mfaRecoveryResponse{}, err
	}
	hashes := hashRecoveryCodes(codes)

	err = s.withUserLock(ctx, userID, func(ctx context.Context) error {
		factor, found, err := s.loadFactor(ctx, s.db, userID)
		if err != nil {
			return err
		}
		if !found {
			return &httpError{status: http.StatusBadRequest, message: mfaEnrollmentNotInitializedMessage}
		}
		if factor.active() && !factor.hasPending() {
			return &httpError{status: http.StatusBadRequest, message: mfaEnrollmentNotInitializedMessage}
		}

		enrollmentSecret := factor.Secret
		if factor.hasPending() {
			enrollmentSecret = factor.PendingSecret
		}
		secret, ok, err := s.decodeSecret(enrollmentSecret)
		if err != nil {
			return err
		}
		if !ok || !verifyTotpCode(secret, code) {
			return &httpError{status: http.StatusBadRequest, message: mfaInvalidCodeMessage}
		}

		verifiedAt := nowMillis()
		// NestJS rewrites enrolledAt only when an already active factor's
		// pending replacement is promoted; every other completion keeps the
		// original enrollment timestamp.
		enrolledAt := factor.EnrolledAt
		if factor.hasPending() && factor.active() {
			enrolledAt = verifiedAt
		}
		label := factor.Label.String
		if factor.PendingLabel.Valid {
			label = factor.PendingLabel.String
		}

		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if err := s.promotePendingFactor(ctx, tx, userID, enrollmentSecret, label, enrolledAt, verifiedAt); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := s.deleteRecoveryCodes(ctx, tx, userID); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := s.insertRecoveryCodes(ctx, tx, userID, hashes); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		return s.invalidateProfileCache(ctx, userID)
	})
	if err != nil {
		return mfaRecoveryResponse{}, err
	}

	status, err := s.GetStatus(ctx, userID)
	if err != nil {
		return mfaRecoveryResponse{}, err
	}
	return recoveryResponse(codes, status), nil
}

// Disable turns the factor off after verifying the current TOTP code or one
// unused recovery code.
//
// AF2: the credential check (including the single-use recovery-code claim and
// the lastUsedAt refresh), the disabledAt write and the recovery-code deletion
// share one transaction, so a failure anywhere rolls the whole management
// action back and a consumed code can never authorize an action that did not
// commit. The factor row itself is kept; no secret field is blanked.
func (s *Service) Disable(ctx context.Context, userID, code string) (mfaStatus, error) {
	if _, err := s.requireHumanActor(ctx, userID); err != nil {
		return mfaStatus{}, err
	}

	err := s.withUserLock(ctx, userID, func(ctx context.Context) error {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := s.verifyFactorOrRecoveryCode(ctx, tx, userID, code); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := s.disableFactor(ctx, tx, userID); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := s.deleteRecoveryCodes(ctx, tx, userID); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		return s.invalidateProfileCache(ctx, userID)
	})
	if err != nil {
		return mfaStatus{}, err
	}
	return s.GetStatus(ctx, userID)
}

// RotateRecoveryCodes replaces the whole recovery-code set after verifying the
// current TOTP code or one unused recovery code.
//
// The plaintext set is generated once, before the transaction, so the response
// always carries exactly the set this call commits. AF2: the authorization and
// the replacement are one transaction, so two concurrent rotations cannot each
// be authorized against the old set and then overwrite each other. The TOTP
// secret is untouched and no enrollment is started.
func (s *Service) RotateRecoveryCodes(ctx context.Context, userID, code string) (mfaRecoveryResponse, error) {
	if _, err := s.requireHumanActor(ctx, userID); err != nil {
		return mfaRecoveryResponse{}, err
	}
	codes, err := generateRecoveryCodes(recoveryCodeCount)
	if err != nil {
		return mfaRecoveryResponse{}, err
	}
	hashes := hashRecoveryCodes(codes)

	err = s.withUserLock(ctx, userID, func(ctx context.Context) error {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := s.verifyFactorOrRecoveryCode(ctx, tx, userID, code); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := s.deleteRecoveryCodes(ctx, tx, userID); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := s.insertRecoveryCodes(ctx, tx, userID, hashes); err != nil {
			_ = tx.Rollback()
			return err
		}
		return tx.Commit()
	})
	if err != nil {
		return mfaRecoveryResponse{}, err
	}

	status, err := s.GetStatus(ctx, userID)
	if err != nil {
		return mfaRecoveryResponse{}, err
	}
	return recoveryResponse(codes, status), nil
}

// recoveryResponse renders the shared recovery-code response shape.
func recoveryResponse(codes []string, status mfaStatus) mfaRecoveryResponse {
	return mfaRecoveryResponse{
		RecoveryCodes:          codes,
		Enabled:                status.Enabled,
		EnrolledAt:             status.EnrolledAt,
		VerifiedAt:             status.VerifiedAt,
		LastUsedAt:             status.LastUsedAt,
		RecoveryCodesRemaining: status.RecoveryCodesRemaining,
	}
}

// hashRecoveryCodes maps one plaintext set onto its stored hashes.
func hashRecoveryCodes(codes []string) []string {
	hashes := make([]string, 0, len(codes))
	for _, code := range codes {
		hashes = append(hashes, hashOpaqueToken(code))
	}
	return hashes
}

// requireHumanActor enforces AF5 and returns the caller's real account email.
//
// A machine access token authenticates as `machine:<tokenId>`, which is not a
// User row, so writing a UserTotpFactor for it would fail the userId foreign
// key and surface as a generic 500. The four MFA write routes therefore require
// a real human User and answer 403 otherwise. This gate is deliberately scoped
// to the writes: GET /api/auth/mfa keeps returning the empty factor state for
// machine identities, and the OIDC tenant settings keep their own boundary.
func (s *Service) requireHumanActor(ctx context.Context, userID string) (string, error) {
	if actorIsMachine(userID) {
		return "", &httpError{status: http.StatusForbidden, message: mfaHumanRequiredMessage}
	}
	if s == nil || s.db == nil {
		return "", errNoDatabase
	}
	email, found, err := s.loadUserEmail(ctx, s.db, userID)
	if err != nil {
		return "", err
	}
	if !found {
		return "", &httpError{status: http.StatusForbidden, message: mfaHumanRequiredMessage}
	}
	return email, nil
}

// verifyFactorOrRecoveryCode accepts either the current factor's live TOTP code
// or one unused recovery code, running entirely on the caller's client so the
// credential check participates in the caller's transaction.
//
// The recovery-code claim is a conditional update whose affected-row count must
// be exactly one: the preceding lookup is inherently racy on its own. The TOTP
// branch keeps the exact six-digit requirement; the recovery branch normalizes
// with trim + uppercase, so a recovery code is never rejected as a malformed
// TOTP code.
func (s *Service) verifyFactorOrRecoveryCode(ctx context.Context, q dbtx, userID, code string) (credentialKind, error) {
	factor, found, err := s.loadFactor(ctx, q, userID)
	if err != nil {
		return "", err
	}
	var secret string
	var secretOK bool
	if found {
		// Decoded whenever the row exists (not only when it is active), so a
		// broken ciphertext propagates as an error exactly like NestJS instead
		// of silently falling through to the recovery-code branch.
		secret, secretOK, err = s.decodeSecret(factor.Secret)
		if err != nil {
			return "", err
		}
	}
	if found && factor.active() && secretOK && verifyTotpCode(secret, code) {
		if err := s.touchFactorLastUsed(ctx, q, userID); err != nil {
			return "", err
		}
		return credentialTOTP, nil
	}

	id, foundCode, err := s.findUnusedRecoveryCodeID(ctx, q, userID, hashRecoveryCode(code))
	if err != nil {
		return "", err
	}
	if !foundCode {
		return "", &httpError{status: http.StatusUnauthorized, message: mfaInvalidCodeMessage}
	}
	affected, err := s.claimRecoveryCode(ctx, q, id)
	if err != nil {
		return "", err
	}
	if affected != 1 {
		return "", &httpError{status: http.StatusUnauthorized, message: mfaInvalidCodeMessage}
	}
	if err := s.touchFactorLastUsed(ctx, q, userID); err != nil {
		return "", err
	}
	return credentialRecoveryCode, nil
}
