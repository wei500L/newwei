package authlogin

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
)

// This file ports the email-code chain: the shared code settings, the login code
// (send + verify) and the authenticated email-change code (send + verify). All
// four routes share one key layout, one cooldown reservation, one attempt counter
// and one single-use deletion, so a code minted by Go is consumed exactly once by
// whichever implementation answers the request.

// emailCodeSettingsDoc is the raw settings document. Members stay as RawMessage
// so an absent member (environment fallback) is distinguishable from an explicit
// zero (which the clamp pushes to the minimum), exactly like the NestJS toInt
// helper.
type emailCodeSettingsDoc struct {
	TTLSeconds      json.RawMessage `json:"ttlSeconds"`
	CooldownSeconds json.RawMessage `json:"cooldownSeconds"`
	MaxAttempts     json.RawMessage `json:"maxAttempts"`
}

// emailCodeCooldownMarker is the cooldown value. Only its presence matters; it is
// a named struct rather than a bare boolean so the shape matches the NestJS
// `{createdAt}` document.
type emailCodeCooldownMarker struct {
	CreatedAt int64 `json:"createdAt"`
}

// emailCodeSettings resolves the code policy: the shared Redis cache first, then
// the SystemSetting row, then the environment defaults — with the documented
// clamps. The resolved document is cached for 60 seconds under the same key
// AuthEmailCodeSettingsService writes.
func (s *Service) emailCodeSettings(ctx context.Context) (emailCodeSettings, error) {
	if raw, found, err := s.cacheGetJSON(ctx, emailCodeSettingsCacheKey); err != nil {
		return emailCodeSettings{}, err
	} else if found {
		return s.normalizeEmailCodeSettings(raw), nil
	}
	settings := s.environmentEmailCodeSettings()
	if s.db != nil {
		var value []byte
		err := s.db.QueryRowContext(ctx,
			"SELECT `value` FROM SystemSetting WHERE `key` = ? LIMIT 1", emailCodeSettingsRowKey).Scan(&value)
		if err != nil && !isNoRows(err) {
			return emailCodeSettings{}, dbWrap(err)
		}
		if err == nil && len(value) > 0 && json.Valid(value) {
			settings = s.normalizeEmailCodeSettings(json.RawMessage(value))
		}
	}
	payload, err := marshalRaw(settings)
	if err != nil {
		return emailCodeSettings{}, err
	}
	if cacheErr := s.cacheSet(ctx, emailCodeSettingsCacheKey, payload, emailCodeSettingsCacheTTL); cacheErr != nil {
		logBackgroundFailure("email code settings cache write", cacheErr)
	}
	return settings, nil
}

// environmentEmailCodeSettings is the normalized environment fallback.
func (s *Service) environmentEmailCodeSettings() emailCodeSettings {
	return emailCodeSettings{
		TTLSeconds:      clampInt(s.cfg.AuthEmailCodeTTLSeconds, emailCodeMinTTLSeconds, emailCodeMaxTTLSeconds),
		CooldownSeconds: clampInt(s.cfg.AuthEmailCodeCooldownSeconds, emailCodeMinCooldownSeconds, emailCodeMaxCooldownSeconds),
		MaxAttempts:     clampInt(s.cfg.AuthEmailCodeMaxAttempts, emailCodeMinMaxAttempts, emailCodeMaxMaxAttempts),
	}
}

// normalizeEmailCodeSettings merges a stored document over the environment
// fallback and clamps every member.
func (s *Service) normalizeEmailCodeSettings(raw json.RawMessage) emailCodeSettings {
	fallback := s.environmentEmailCodeSettings()
	var doc emailCodeSettingsDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		return fallback
	}
	return emailCodeSettings{
		TTLSeconds: clampInt(
			settingsInt(doc.TTLSeconds, fallback.TTLSeconds), emailCodeMinTTLSeconds, emailCodeMaxTTLSeconds),
		CooldownSeconds: clampInt(
			settingsInt(doc.CooldownSeconds, fallback.CooldownSeconds), emailCodeMinCooldownSeconds, emailCodeMaxCooldownSeconds),
		MaxAttempts: clampInt(
			settingsInt(doc.MaxAttempts, fallback.MaxAttempts), emailCodeMinMaxAttempts, emailCodeMaxMaxAttempts),
	}
}

// settingsInt mirrors the NestJS toInt helper: a finite number is floored, and
// anything else (absent, null, string, object) falls back.
func settingsInt(raw json.RawMessage, fallback int) int {
	value, ok := jsonIntValue(raw)
	if !ok {
		return fallback
	}
	return value
}

// ---- shared key and state helpers ----

func emailCodeKey(scene emailCodeScene, identifier string) string {
	return emailCodeKeyPrefix + string(scene) + ":" + identifier
}

func emailCodeAttemptsKey(scene emailCodeScene, identifier string) string {
	return emailCodeAttemptsKeyPrefix + string(scene) + ":" + identifier
}

func emailCodeCooldownKey(scene emailCodeScene, identifier string) string {
	return emailCodeCooldownKeyPrefix + string(scene) + ":" + identifier
}

// clearEmailCodeState drops the code and its attempt counter. The cooldown is
// deliberately untouched: only a failed send reclaims it.
func (s *Service) clearEmailCodeState(ctx context.Context, scene emailCodeScene, identifier string) {
	if _, err := s.cacheDel(ctx, emailCodeKey(scene, identifier)); err != nil {
		logBackgroundFailure("email code delete", err)
	}
	if _, err := s.cacheDel(ctx, emailCodeAttemptsKey(scene, identifier)); err != nil {
		logBackgroundFailure("email code attempts delete", err)
	}
}

// markEmailCodeAttemptFailed increments the attempt counter with the code TTL as
// its window, and clears the code once the budget is exhausted. Returns the new
// count.
func (s *Service) markEmailCodeAttemptFailed(ctx context.Context, scene emailCodeScene, identifier string) (int64, error) {
	settings, err := s.emailCodeSettings(ctx)
	if err != nil {
		return 0, err
	}
	attempts, err := s.incr(ctx, emailCodeAttemptsKey(scene, identifier), settings.TTLSeconds)
	if err != nil {
		return 0, err
	}
	if attempts >= int64(settings.MaxAttempts) {
		s.clearEmailCodeState(ctx, scene, identifier)
	}
	return attempts, nil
}

// reserveEmailCodeCooldown takes the cooldown slot with SET NX. A second request
// inside the window is rejected without sending anything.
func (s *Service) reserveEmailCodeCooldown(ctx context.Context, scene emailCodeScene, identifier string) (bool, int, error) {
	settings, err := s.emailCodeSettings(ctx)
	if err != nil {
		return false, 0, err
	}
	payload, err := marshalRaw(emailCodeCooldownMarker{CreatedAt: time.Now().UnixMilli()})
	if err != nil {
		return false, 0, err
	}
	accepted, err := s.setIfAbsent(ctx, emailCodeCooldownKey(scene, identifier), payload, settings.CooldownSeconds)
	if err != nil {
		return false, 0, err
	}
	return accepted, settings.CooldownSeconds, nil
}

// expiresMinutes mirrors Math.max(1, Math.ceil(ttlSeconds / 60)).
func expiresMinutes(ttlSeconds int) int {
	minutes := (ttlSeconds + 59) / 60
	if minutes < 1 {
		return 1
	}
	return minutes
}

// ---- POST /api/auth/send-login-code ----

// sendLoginCode always answers the same shape. A cooldown hit, a missing /
// inactive / unverified account and a transport failure are indistinguishable to
// the caller — that is what keeps the endpoint from becoming an account
// enumeration oracle.
func (s *Service) sendLoginCode(ctx context.Context, email string) (emailCodeSendResult, error) {
	normalizedEmail := normalizeEmail(email)
	accepted, cooldownSeconds, err := s.reserveEmailCodeCooldown(ctx, sceneLogin, normalizedEmail)
	if err != nil {
		return emailCodeSendResult{}, err
	}
	if !accepted {
		return emailCodeSendResult{OK: true, CooldownSeconds: cooldownSeconds}, nil
	}

	user, found, err := s.store.UserByEmail(ctx, normalizedEmail)
	if err != nil {
		return emailCodeSendResult{}, err
	}
	if !found || !user.IsActive || user.EmailVerified == nil {
		return emailCodeSendResult{OK: true, CooldownSeconds: cooldownSeconds}, nil
	}

	settings, err := s.emailCodeSettings(ctx)
	if err != nil {
		return emailCodeSendResult{}, err
	}
	code, err := randomDigits(emailCodeLength)
	if err != nil {
		return emailCodeSendResult{}, err
	}
	userID := user.ID
	payload, err := marshalRaw(emailCodePayload{
		CodeHash: hashEmailCode(code),
		Email:    normalizedEmail,
		UserID:   &userID,
	})
	if err != nil {
		return emailCodeSendResult{}, err
	}

	cooldownKey := emailCodeCooldownKey(sceneLogin, normalizedEmail)
	if err := s.cacheSet(ctx, emailCodeKey(sceneLogin, normalizedEmail), payload, settings.TTLSeconds); err != nil {
		return emailCodeSendResult{}, err
	}
	if _, err := s.cacheDel(ctx, emailCodeAttemptsKey(sceneLogin, normalizedEmail)); err != nil {
		return emailCodeSendResult{}, err
	}
	if err := s.mailer.sendVerificationCode(ctx, normalizedEmail, verificationSceneLogin, code, expiresMinutes(settings.TTLSeconds)); err != nil {
		// A failed delivery must not leave a usable code or a spent cooldown
		// behind, but the response still claims success.
		log.Printf("authlogin: login code delivery failed: %v", err)
		s.clearEmailCodeState(ctx, sceneLogin, normalizedEmail)
		if _, delErr := s.cacheDel(ctx, cooldownKey); delErr != nil {
			logBackgroundFailure("email code cooldown delete", delErr)
		}
	}
	return emailCodeSendResult{OK: true, CooldownSeconds: cooldownSeconds}, nil
}

// ---- POST /api/auth/login-with-code ----

// loginWithCode verifies an emailed code and continues into the trusted flow.
//
// The code is consumed with an atomic DEL whose affected count must be exactly
// one, and that happens BEFORE the session is issued: two concurrent requests
// holding the same code can never both receive a token.
func (s *Service) loginWithCode(ctx context.Context, email, code string, orgID *string, ipAddress, userAgent *string) (loginOutcome, error) {
	normalizedEmail := normalizeEmail(email)
	if err := s.enforceLoginRateLimit(ctx, sceneLoginCode, normalizedEmail, ipAddress); err != nil {
		return nil, err
	}
	if s.store == nil {
		return nil, errNoDatabase
	}
	codeValue := normalizeCode(code)
	raw, found, err := s.cacheGetJSON(ctx, emailCodeKey(sceneLogin, normalizedEmail))
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, unauthorized(invalidEmailCodeMessage)
	}
	var payload emailCodePayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, redisWrap(err)
	}
	if payload.Email != normalizedEmail {
		return nil, unauthorized(invalidEmailCodeMessage)
	}
	if payload.CodeHash != hashEmailCode(codeValue) {
		if _, err := s.markEmailCodeAttemptFailed(ctx, sceneLogin, normalizedEmail); err != nil {
			return nil, err
		}
		return nil, unauthorized(invalidEmailCodeMessage)
	}

	user, found, err := s.store.UserByEmail(ctx, normalizedEmail)
	if err != nil {
		return nil, err
	}
	if !found || !user.IsActive || user.EmailVerified == nil {
		if _, err := s.markEmailCodeAttemptFailed(ctx, sceneLogin, normalizedEmail); err != nil {
			return nil, err
		}
		return nil, unauthorized(invalidEmailCodeMessage)
	}
	if payload.UserID != nil && *payload.UserID != user.ID {
		if _, err := s.markEmailCodeAttemptFailed(ctx, sceneLogin, normalizedEmail); err != nil {
			return nil, err
		}
		return nil, unauthorized(invalidEmailCodeMessage)
	}

	memberships, err := s.store.Memberships(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	selector := ""
	if orgID != nil {
		selector = *orgID
	}
	membership, err := accountsecurity.PickLoginMembership(memberships, selector)
	if err != nil {
		return nil, err
	}
	if err := accountsecurity.AssertLoginMembershipAccessible(membership); err != nil {
		return nil, err
	}

	consumed, err := s.cacheDel(ctx, emailCodeKey(sceneLogin, normalizedEmail))
	if err != nil {
		return nil, err
	}
	if consumed != 1 {
		return nil, unauthorized(invalidEmailCodeMessage)
	}
	s.clearEmailCodeState(ctx, sceneLogin, normalizedEmail)
	if _, err := s.cacheDel(ctx, emailCodeCooldownKey(sceneLogin, normalizedEmail)); err != nil {
		logBackgroundFailure("email code cooldown delete", err)
	}

	return s.completeTrustedLogin(ctx, user.ID, membership.OrgID, ipAddress, userAgent, "login_with_code", false)
}

// ---- POST /api/auth/send-verification ----

// sendVerificationCode starts an email change: it validates the new address,
// reserves the cooldown, stores the pending address, mints the bind code and
// sends it.
//
// Every failure after the pendingEmail write rolls that write back — but only
// while the column still holds this request's value, so a concurrent successful
// change is never clobbered.
func (s *Service) sendVerificationCode(ctx context.Context, userID, orgID, email string, ipAddress *string) (emailCodeSendResult, error) {
	normalizedEmail := normalizeEmail(email)
	if s.store == nil {
		return emailCodeSendResult{}, errNoDatabase
	}
	current, found, err := s.store.UserByID(ctx, userID)
	if err != nil {
		return emailCodeSendResult{}, err
	}
	if !found || !current.IsActive {
		return emailCodeSendResult{}, unauthorized(invalidAccessTokenMessage)
	}
	if normalizedEmail == normalizeEmail(current.Email) {
		return emailCodeSendResult{}, badRequest(newEmailSameMessage)
	}
	existing, found, err := s.store.UserByEmail(ctx, normalizedEmail)
	if err != nil {
		return emailCodeSendResult{}, err
	}
	if found && existing.ID != userID {
		return emailCodeSendResult{}, badRequest(emailInUseMessage)
	}
	pendingConflict, err := s.pendingEmailTaken(ctx, normalizedEmail, userID)
	if err != nil {
		return emailCodeSendResult{}, err
	}
	if pendingConflict {
		return emailCodeSendResult{}, badRequest(emailPendingMessage)
	}

	accepted, cooldownSeconds, err := s.reserveEmailCodeCooldown(ctx, sceneBind, userID)
	if err != nil {
		return emailCodeSendResult{}, err
	}
	if !accepted {
		return emailCodeSendResult{}, tooManyRequests(emailCodeCooldownMessage)
	}

	settings, err := s.emailCodeSettings(ctx)
	if err != nil {
		return emailCodeSendResult{}, err
	}
	code, err := randomDigits(emailCodeLength)
	if err != nil {
		return emailCodeSendResult{}, err
	}
	userIDCopy := userID
	payload, err := marshalRaw(emailCodePayload{
		CodeHash: hashEmailCode(code),
		Email:    normalizedEmail,
		UserID:   &userIDCopy,
	})
	if err != nil {
		return emailCodeSendResult{}, err
	}

	cooldownKey := emailCodeCooldownKey(sceneBind, userID)
	if err := s.sendBindCode(ctx, userID, normalizedEmail, payload, code, settings); err != nil {
		s.clearEmailCodeState(ctx, sceneBind, userID)
		s.rollbackPendingEmail(ctx, userID, normalizedEmail)
		if _, delErr := s.cacheDel(ctx, cooldownKey); delErr != nil {
			logBackgroundFailure("email code cooldown delete", delErr)
		}
		if accountsecurity.IsUniqueConstraint(err) {
			return emailCodeSendResult{}, badRequest(emailInUseMessage)
		}
		return emailCodeSendResult{}, err
	}

	metadata, err := marshalRaw(pendingEmailAuditMetadata{PendingEmail: normalizedEmail})
	if err != nil {
		return emailCodeSendResult{}, err
	}
	s.writeAuditLogBestEffort(ctx, orgID, userID, "auth", "send_verification_code", metadata, ipAddress)

	return emailCodeSendResult{OK: true, CooldownSeconds: cooldownSeconds}, nil
}

// sendBindCode performs the state write, the code cache write and the delivery.
// Any failure is returned so the caller can roll the pending address back.
func (s *Service) sendBindCode(ctx context.Context, userID, normalizedEmail string, payload json.RawMessage, code string, settings emailCodeSettings) error {
	now := nowMillis()
	if _, err := s.db.ExecContext(ctx,
		"UPDATE `User` SET `pendingEmail` = ?, `updatedAt` = ? WHERE `id` = ?",
		normalizedEmail, now, userID); err != nil {
		return dbWrap(err)
	}
	if err := s.cacheSet(ctx, emailCodeKey(sceneBind, userID), payload, settings.TTLSeconds); err != nil {
		s.clearEmailCodeState(ctx, sceneBind, userID)
		return err
	}
	if _, err := s.cacheDel(ctx, emailCodeAttemptsKey(sceneBind, userID)); err != nil {
		s.clearEmailCodeState(ctx, sceneBind, userID)
		return err
	}
	if err := s.mailer.sendVerificationCode(ctx, normalizedEmail, verificationSceneBind, code, expiresMinutes(settings.TTLSeconds)); err != nil {
		s.clearEmailCodeState(ctx, sceneBind, userID)
		return err
	}
	return nil
}

// rollbackPendingEmail clears the pending address only when it still equals the
// value this request wrote.
func (s *Service) rollbackPendingEmail(ctx context.Context, userID, normalizedEmail string) {
	if _, err := s.db.ExecContext(ctx,
		"UPDATE `User` SET `pendingEmail` = NULL WHERE `id` = ? AND `pendingEmail` = ?",
		userID, normalizedEmail); err != nil {
		logBackgroundFailure("pending email rollback", dbWrap(err))
	}
}

// pendingEmailTaken reports whether another user already has this address pending.
func (s *Service) pendingEmailTaken(ctx context.Context, normalizedEmail, userID string) (bool, error) {
	if s.db == nil {
		return false, errNoDatabase
	}
	var id string
	err := s.db.QueryRowContext(ctx,
		"SELECT `id` FROM `User` WHERE `pendingEmail` = ? AND `id` <> ? LIMIT 1",
		normalizedEmail, userID).Scan(&id)
	if isNoRows(err) {
		return false, nil
	}
	if err != nil {
		return false, dbWrap(err)
	}
	return true, nil
}

// ---- POST /api/auth/verify-email ----

// verifyEmail completes an email change: it verifies the bind code, swaps the
// address, clears the pending state and every code artifact, drops the cached
// profiles and returns the fresh authenticated profile.
func (s *Service) verifyEmail(ctx context.Context, userID, orgID, code string, ipAddress *string) (authenticatedUser, error) {
	if s.store == nil {
		return authenticatedUser{}, errNoDatabase
	}
	codeValue := normalizeCode(code)
	raw, found, err := s.cacheGetJSON(ctx, emailCodeKey(sceneBind, userID))
	if err != nil {
		return authenticatedUser{}, err
	}
	if !found {
		return authenticatedUser{}, badRequest(invalidEmailCodeMessage)
	}
	var payload emailCodePayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return authenticatedUser{}, redisWrap(err)
	}
	if payload.CodeHash != hashEmailCode(codeValue) {
		if _, err := s.markEmailCodeAttemptFailed(ctx, sceneBind, userID); err != nil {
			return authenticatedUser{}, err
		}
		return authenticatedUser{}, badRequest(invalidEmailCodeMessage)
	}

	now := nowMillis()
	if _, err := s.db.ExecContext(ctx,
		"UPDATE `User` SET `email` = ?, `emailVerified` = ?, `pendingEmail` = NULL, `updatedAt` = ? WHERE `id` = ?",
		payload.Email, now, now, userID); err != nil {
		if accountsecurity.IsUniqueConstraint(err) {
			return authenticatedUser{}, badRequest(emailInUseMessage)
		}
		return authenticatedUser{}, dbWrap(err)
	}

	s.clearEmailCodeState(ctx, sceneBind, userID)
	if _, err := s.cacheDel(ctx, emailCodeCooldownKey(sceneBind, userID)); err != nil {
		logBackgroundFailure("email code cooldown delete", err)
	}
	if err := s.store.InvalidateProfileCache(ctx, userID, orgID); err != nil {
		return authenticatedUser{}, err
	}

	profile, err := s.loadProfile(ctx, userID, orgID)
	if err != nil {
		return authenticatedUser{}, err
	}
	metadata, err := marshalRaw(emailAuditMetadata{Email: payload.Email})
	if err != nil {
		return authenticatedUser{}, err
	}
	s.writeAuditLogBestEffort(ctx, orgID, userID, "auth", "verify_email", metadata, ipAddress)
	return profile, nil
}

// loadProfile re-derives the authenticated profile with the strict membership
// selection rule (the GET /me semantics), which is what an email change returns.
func (s *Service) loadProfile(ctx context.Context, userID, orgID string) (authenticatedUser, error) {
	user, found, err := s.store.UserByID(ctx, userID)
	if err != nil {
		return authenticatedUser{}, err
	}
	if !found {
		return authenticatedUser{}, unauthorized(invalidAccessTokenMessage)
	}
	if !user.IsActive {
		return authenticatedUser{}, unauthorized("User disabled")
	}
	memberships, err := s.store.Memberships(ctx, userID)
	if err != nil {
		return authenticatedUser{}, err
	}
	membership, err := accountsecurity.PickSessionMembership(memberships, orgID)
	if err != nil {
		return authenticatedUser{}, err
	}
	if err := accountsecurity.AssertLoginMembershipAccessible(membership); err != nil {
		return authenticatedUser{}, err
	}
	return s.store.Profile(ctx, user, membership)
}
