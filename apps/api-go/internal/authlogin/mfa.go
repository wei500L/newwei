package authlogin

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authfactors"
)

// This file ports the public MFA challenge flows (mfa/verify-login and the forced
// enrollment start/complete pair) plus the AuthChallenge consumption rules. The
// challenge row is the single-use state; every transition is a conditional UPDATE
// whose affected-row count is checked, because the row can be claimed by two
// concurrent requests and only one may win.

// challengeRef is the (id, expiry) pair both challenge creators return.
type challengeRef struct {
	challengeID string
	expiresAt   string
}

// maxChallengeAttempts mirrors MfaService.maxChallengeAttempts:
// max(1, floor(AUTH_MFA_CHALLENGE_MAX_ATTEMPTS)).
func (s *Service) maxChallengeAttempts() int {
	attempts := s.cfg.AuthMfaChallengeMaxAttempts
	if attempts < 1 {
		return 1
	}
	return attempts
}

// createLoginChallenge writes an mfa_login challenge with a 10 minute TTL. The
// payload records the organization, the requesting IP and the user agent so the
// session that is eventually issued keeps the original request metadata.
func (s *Service) createLoginChallenge(ctx context.Context, userID, orgID string, ipAddress, userAgent *string) (challengeRef, error) {
	payload, err := marshalRaw(loginChallengePayload{OrgID: orgID, IPAddress: ipAddress, UserAgent: userAgent})
	if err != nil {
		return challengeRef{}, err
	}
	return s.insertChallenge(ctx, challengeTypeMfaLogin, userID, orgID, payload, mfaChallengeTTL)
}

// createEnrollmentChallenge writes an mfa_enrollment challenge with a 15 minute
// TTL and the action label that must survive into the audit record of the
// session it eventually produces.
func (s *Service) createEnrollmentChallenge(ctx context.Context, userID, orgID string, ipAddress, userAgent *string, action string) (challengeRef, error) {
	if action == "" {
		action = "login"
	}
	payload, err := marshalRaw(loginChallengePayload{OrgID: orgID, IPAddress: ipAddress, UserAgent: userAgent, Action: action})
	if err != nil {
		return challengeRef{}, err
	}
	return s.insertChallenge(ctx, challengeTypeMfaEnrollment, userID, orgID, payload, mfaEnrollmentTTL)
}

func (s *Service) insertChallenge(ctx context.Context, challengeType, userID, orgID string, payload json.RawMessage, ttl time.Duration) (challengeRef, error) {
	if s.db == nil {
		return challengeRef{}, errNoDatabase
	}
	challengeID, err := newRowID()
	if err != nil {
		return challengeRef{}, err
	}
	now := nowMillis()
	expiresAt := now.Add(ttl)
	if _, err := s.db.ExecContext(ctx,
		"INSERT INTO `AuthChallenge` (`id`, `type`, `userId`, `orgId`, `payload`, `expiresAt`, "+
			"`consumedAt`, `failedAttempts`, `lockedAt`, `createdAt`) "+
			"VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?)",
		challengeID, challengeType, userID, orgID, []byte(payload), expiresAt, now); err != nil {
		return challengeRef{}, dbWrap(err)
	}
	return challengeRef{challengeID: challengeID, expiresAt: nestTimestamp(expiresAt)}, nil
}

// loadActiveChallenge re-reads a challenge and applies the NestJS acceptance
// rules in order: wrong or missing type, then the locked/attempt budget, then
// consumption or expiry. A row that is locked or over budget is locked for good
// and answers the 429; everything else answers the caller's 401 message.
func (s *Service) loadActiveChallenge(ctx context.Context, challengeID, challengeType, message string) (authChallengeRow, error) {
	if s.db == nil {
		return authChallengeRow{}, errNoDatabase
	}
	var challenge authChallengeRow
	var userID, orgID sql.NullString
	var consumedAt, lockedAt sql.NullTime
	err := s.db.QueryRowContext(ctx,
		"SELECT `id`, `type`, `userId`, `orgId`, `payload`, `expiresAt`, `consumedAt`, `failedAttempts`, `lockedAt` "+
			"FROM `AuthChallenge` WHERE `id` = ? LIMIT 1", challengeID).
		Scan(&challenge.ID, &challenge.Type, &userID, &orgID, &challenge.Payload, &challenge.ExpiresAt,
			&consumedAt, &challenge.FailedAttempts, &lockedAt)
	if isNoRows(err) {
		return authChallengeRow{}, unauthorized(message)
	}
	if err != nil {
		return authChallengeRow{}, dbWrap(err)
	}
	if challenge.Type != challengeType {
		return authChallengeRow{}, unauthorized(message)
	}
	challenge.UserID = nullableString(userID)
	challenge.OrgID = nullableString(orgID)
	challenge.ConsumedAt = nullableTime(consumedAt)
	challenge.LockedAt = nullableTime(lockedAt)

	if challenge.LockedAt != nil || challenge.FailedAttempts >= s.maxChallengeAttempts() {
		s.lockChallenge(ctx, challenge.ID)
		return authChallengeRow{}, tooManyRequests(mfaChallengeLockedMessage)
	}
	if challenge.ConsumedAt != nil || challenge.ExpiresAt.Before(time.Now()) {
		return authChallengeRow{}, unauthorized(message)
	}
	return challenge, nil
}

// consumeChallenge claims the challenge atomically. The predicate repeats the
// acceptance rules so a challenge that expired, was consumed or reached the
// attempt budget between the read and this claim can never be claimed.
func (s *Service) consumeChallenge(ctx context.Context, challengeID, message string) error {
	if s.db == nil {
		return errNoDatabase
	}
	now := nowMillis()
	result, err := s.db.ExecContext(ctx,
		"UPDATE `AuthChallenge` SET `consumedAt` = ? WHERE `id` = ? AND `consumedAt` IS NULL "+
			"AND `lockedAt` IS NULL AND `failedAttempts` < ? AND `expiresAt` > ?",
		now, challengeID, s.maxChallengeAttempts(), now)
	if err != nil {
		return dbWrap(err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return dbWrap(err)
	}
	if affected != 1 {
		return s.inactiveChallengeError(ctx, challengeID, message)
	}
	return nil
}

// releaseChallenge returns a claimed enrollment challenge after a wrong code, so
// the user can retry with the same challenge instead of restarting the whole
// enrollment.
func (s *Service) releaseChallenge(ctx context.Context, challengeID string) {
	if s.db == nil {
		return
	}
	if _, err := s.db.ExecContext(ctx,
		"UPDATE `AuthChallenge` SET `consumedAt` = NULL WHERE `id` = ? AND `consumedAt` IS NOT NULL",
		challengeID); err != nil {
		logBackgroundFailure("challenge release", dbWrap(err))
	}
}

// recordChallengeFailure counts one wrong credential against the budget. Only the
// shared "invalid MFA verification code" failure is counted; a database or
// encryption error keeps its own meaning and is never disguised as a wrong code.
func (s *Service) recordChallengeFailure(ctx context.Context, challengeID, message string, cause error) error {
	if !isInvalidMfaCode(cause) {
		return cause
	}
	if s.db == nil {
		return errNoDatabase
	}
	now := nowMillis()
	result, err := s.db.ExecContext(ctx,
		"UPDATE `AuthChallenge` SET `failedAttempts` = `failedAttempts` + 1 WHERE `id` = ? "+
			"AND `consumedAt` IS NULL AND `lockedAt` IS NULL AND `failedAttempts` < ? AND `expiresAt` > ?",
		challengeID, s.maxChallengeAttempts(), now)
	if err != nil {
		return dbWrap(err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return dbWrap(err)
	}
	if affected != 1 {
		return s.inactiveChallengeError(ctx, challengeID, message)
	}

	var failedAttempts int
	var lockedAt sql.NullTime
	err = s.db.QueryRowContext(ctx,
		"SELECT `failedAttempts`, `lockedAt` FROM `AuthChallenge` WHERE `id` = ? LIMIT 1", challengeID).
		Scan(&failedAttempts, &lockedAt)
	if err != nil && !isNoRows(err) {
		return dbWrap(err)
	}
	if failedAttempts >= s.maxChallengeAttempts() {
		s.lockChallenge(ctx, challengeID)
		return tooManyRequests(mfaChallengeLockedMessage)
	}
	return cause
}

// inactiveChallengeError resolves the precise answer for a claim that failed:
// an already locked or over-budget challenge answers the 429 (and is locked if it
// was not yet), anything else answers the caller's 401 message.
func (s *Service) inactiveChallengeError(ctx context.Context, challengeID, message string) error {
	if s.db == nil {
		return errNoDatabase
	}
	var failedAttempts int
	var lockedAt sql.NullTime
	err := s.db.QueryRowContext(ctx,
		"SELECT `failedAttempts`, `lockedAt` FROM `AuthChallenge` WHERE `id` = ? LIMIT 1", challengeID).
		Scan(&failedAttempts, &lockedAt)
	if err != nil && !isNoRows(err) {
		return dbWrap(err)
	}
	if lockedAt.Valid || failedAttempts >= s.maxChallengeAttempts() {
		s.lockChallenge(ctx, challengeID)
		return tooManyRequests(mfaChallengeLockedMessage)
	}
	return unauthorized(message)
}

// lockChallenge pins the challenge as permanently unusable.
func (s *Service) lockChallenge(ctx context.Context, challengeID string) {
	if s.db == nil {
		return
	}
	if _, err := s.db.ExecContext(ctx,
		"UPDATE `AuthChallenge` SET `lockedAt` = ? WHERE `id` = ? AND `lockedAt` IS NULL",
		nowMillis(), challengeID); err != nil {
		logBackgroundFailure("challenge lock", dbWrap(err))
	}
}

// parseChallengePayload tolerates a non-object or partial document exactly like
// the NestJS parser: only string members are kept and everything else is dropped.
func parseChallengePayload(raw []byte) loginChallengePayload {
	var payload loginChallengePayload
	if len(raw) == 0 {
		return payload
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return loginChallengePayload{}
	}
	return payload
}

// challengeOrgID mirrors `payload.orgId ?? challenge.orgId ?? ""`.
func challengeOrgID(payload loginChallengePayload, challenge authChallengeRow) string {
	if payload.OrgID != "" {
		return payload.OrgID
	}
	if challenge.OrgID != nil {
		return *challenge.OrgID
	}
	return ""
}

// challengeAction mirrors `payload.action ?? "login"`.
func challengeAction(payload loginChallengePayload) string {
	if payload.Action == "" {
		return "login"
	}
	return payload.Action
}

// normalizeRequesterIP mirrors the NestJS normalizeIp used by the enrollment
// requester binding: trim, drop the IPv4-mapped IPv6 prefix, lowercase.
func normalizeRequesterIP(ip string) string {
	return strings.ToLower(strings.TrimPrefix(strings.TrimSpace(ip), "::ffff:"))
}

// assertEnrollmentRequesterMatches binds the enrollment challenge to the party
// that started the flow. Only fields both sides provide are compared: a missing
// recorded value or a missing caller value is not a mismatch, so the check never
// becomes stricter than the source contract.
func assertEnrollmentRequesterMatches(challenge authChallengeRow, ipAddress, userAgent *string) error {
	payload := parseChallengePayload(challenge.Payload)
	if payload.IPAddress == nil && payload.UserAgent == nil {
		return nil
	}
	if payload.IPAddress != nil && ipAddress != nil {
		recordedIP := normalizeRequesterIP(*payload.IPAddress)
		callerIP := normalizeRequesterIP(*ipAddress)
		if callerIP != "" && recordedIP != "" && recordedIP != callerIP {
			return unauthorized(mfaEnrollmentChallengeInvalidMessage)
		}
	}
	if payload.UserAgent != nil && userAgent != nil && *payload.UserAgent != *userAgent {
		return unauthorized(mfaEnrollmentChallengeInvalidMessage)
	}
	return nil
}

// ---- POST /api/auth/mfa/verify-login ----

// completeMfaLogin verifies the second factor and then issues the session.
//
// The credential check runs in its own transaction so a recovery code is claimed
// exactly once together with the factor's lastUsedAt refresh. The challenge is
// claimed only AFTER the credential verified, so a wrong code cannot burn the
// challenge and a correct code cannot be replayed.
func (s *Service) completeMfaLogin(ctx context.Context, challengeID, code string, ipAddress, userAgent *string) (sessionResult, error) {
	if s.db == nil {
		return sessionResult{}, errNoDatabase
	}
	challenge, err := s.loadActiveChallenge(ctx, challengeID, challengeTypeMfaLogin, mfaLoginChallengeInvalidMessage)
	if err != nil {
		return sessionResult{}, err
	}
	if challenge.UserID == nil {
		return sessionResult{}, unauthorized(mfaLoginChallengeInvalidMessage)
	}
	userID := *challenge.UserID

	if err := s.verifyChallengeCredential(ctx, userID, code); err != nil {
		return sessionResult{}, s.recordChallengeFailure(ctx, challenge.ID, mfaLoginChallengeInvalidMessage, err)
	}
	if err := s.consumeChallenge(ctx, challenge.ID, mfaLoginChallengeInvalidMessage); err != nil {
		return sessionResult{}, err
	}

	payload := parseChallengePayload(challenge.Payload)
	action := "login_with_mfa"
	if challengeAction(payload) == "login_with_oidc" {
		// Compatibility with challenges created by the existing OIDC entry
		// point: the label survives into the audit record. The OIDC producer
		// itself is not migrated here.
		action = "login_with_oidc"
	}
	effectiveIP := ipAddress
	if effectiveIP == nil {
		effectiveIP = payload.IPAddress
	}
	effectiveUA := userAgent
	if effectiveUA == nil {
		effectiveUA = payload.UserAgent
	}
	outcome, err := s.completeTrustedLogin(ctx, userID, challengeOrgID(payload, challenge), effectiveIP, effectiveUA, action, true)
	if err != nil {
		return sessionResult{}, err
	}
	session, ok := outcome.(sessionResult)
	if !ok {
		return sessionResult{}, unauthorized(mfaLoginChallengeInvalidMessage)
	}
	return session, nil
}

// verifyChallengeCredential runs the shared TOTP-or-recovery-code check inside a
// transaction, so the single-use claim and the timestamp refresh commit together.
func (s *Service) verifyChallengeCredential(ctx context.Context, userID, code string) error {
	if s.factors == nil {
		return errNoDatabase
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return dbWrap(err)
	}
	if err := s.factors.LoginVerifyCredential(ctx, tx, userID, code); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return dbWrap(err)
	}
	return nil
}

// ---- POST /api/auth/mfa/enrollment/start ----

// beginEnrollmentChallenge exposes the pending factor secret to the party that
// started the forced enrollment, after the requester binding check. Success is a
// 201 (the NestJS handler has no @HttpCode(200) on this route).
func (s *Service) beginEnrollmentChallenge(ctx context.Context, challengeID string, ipAddress, userAgent *string) (mfaEnrollmentStartResult, error) {
	challenge, err := s.loadActiveChallenge(ctx, challengeID, challengeTypeMfaEnrollment, mfaEnrollmentChallengeInvalidMessage)
	if err != nil {
		return mfaEnrollmentStartResult{}, err
	}
	if challenge.UserID == nil {
		return mfaEnrollmentStartResult{}, unauthorized(mfaEnrollmentChallengeInvalidMessage)
	}
	if err := assertEnrollmentRequesterMatches(challenge, ipAddress, userAgent); err != nil {
		return mfaEnrollmentStartResult{}, err
	}
	if s.factors == nil {
		return mfaEnrollmentStartResult{}, errNoDatabase
	}
	enrollment, err := s.factors.LoginBeginEnrollment(ctx, *challenge.UserID)
	if err != nil {
		return mfaEnrollmentStartResult{}, err
	}
	return mfaEnrollmentStartResult{Secret: enrollment.Secret, OtpauthURI: enrollment.OtpauthURI}, nil
}

// ---- POST /api/auth/mfa/enrollment/complete ----

// completeMfaEnrollmentLogin completes a forced enrollment and issues the
// session.
//
// Order is the protocol: the challenge is claimed BEFORE the enrollment runs,
// because completing an enrollment rotates the TOTP secret and regenerates the
// recovery codes — two concurrent completions must not both rotate, or the
// loser's rotation would invalidate the codes returned to the winner. A wrong
// code gives the challenge back so the user can retry it.
func (s *Service) completeMfaEnrollmentLogin(ctx context.Context, challengeID, code string, ipAddress, userAgent *string) (enrollmentCompleteResult, error) {
	if s.db == nil {
		return enrollmentCompleteResult{}, errNoDatabase
	}
	challenge, err := s.loadActiveChallenge(ctx, challengeID, challengeTypeMfaEnrollment, mfaEnrollmentChallengeInvalidMessage)
	if err != nil {
		return enrollmentCompleteResult{}, err
	}
	if challenge.UserID == nil {
		return enrollmentCompleteResult{}, unauthorized(mfaEnrollmentChallengeInvalidMessage)
	}
	if err := assertEnrollmentRequesterMatches(challenge, ipAddress, userAgent); err != nil {
		return enrollmentCompleteResult{}, err
	}
	if err := s.consumeChallenge(ctx, challenge.ID, mfaEnrollmentChallengeInvalidMessage); err != nil {
		return enrollmentCompleteResult{}, err
	}
	if s.factors == nil {
		return enrollmentCompleteResult{}, errNoDatabase
	}
	enrollment, err := s.factors.LoginVerifyEnrollment(ctx, *challenge.UserID, code)
	if err != nil {
		if isInvalidMfaCode(err) {
			s.releaseChallenge(ctx, challenge.ID)
		}
		return enrollmentCompleteResult{}, s.recordChallengeFailure(ctx, challenge.ID, mfaEnrollmentChallengeInvalidMessage, err)
	}

	payload := parseChallengePayload(challenge.Payload)
	effectiveIP := ipAddress
	if effectiveIP == nil {
		effectiveIP = payload.IPAddress
	}
	effectiveUA := userAgent
	if effectiveUA == nil {
		effectiveUA = payload.UserAgent
	}
	outcome, err := s.completeTrustedLogin(ctx, *challenge.UserID, challengeOrgID(payload, challenge),
		effectiveIP, effectiveUA, challengeAction(payload), true)
	if err != nil {
		return enrollmentCompleteResult{}, err
	}
	session, ok := outcome.(sessionResult)
	if !ok {
		return enrollmentCompleteResult{}, unauthorized(mfaEnrollmentIncompleteMessage)
	}
	return enrollmentCompleteResult{
		User:          session.User,
		AccessToken:   session.AccessToken,
		RefreshToken:  session.RefreshToken,
		Organizations: session.Organizations,
		ExpiresIn:     session.ExpiresIn,
		RecoveryCodes: enrollment.RecoveryCodes,
	}, nil
}

// isInvalidMfaCode reports the shared wrong-credential failure produced by the
// reused factor service. The attempt budget and the challenge hand-back both key
// on it, and nothing else.
func isInvalidMfaCode(err error) bool {
	return err != nil && authfactors.IsInvalidMfaCode(err)
}
