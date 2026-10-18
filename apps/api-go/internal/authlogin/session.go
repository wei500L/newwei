package authlogin

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
)

// This file is the trusted-login core: credential verification, the MFA
// decision and session issue. Password login and email-code login both funnel
// into completeTrustedLogin, so the MFA policy is evaluated exactly once and
// always against freshly reloaded state.

// normalizeEmail mirrors AuthService.normalizeEmail: trim then lowercase. The
// result is the lookup key for the User row, the email-code cache key and the
// rate-limit bucket, so it must be identical on every path.
func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// normalizeCode mirrors AuthService.normalizeCode (trim only). Leading zeros are
// preserved because the code is a string, never a number.
func normalizeCode(code string) string { return strings.TrimSpace(code) }

// loginOutcome is the result of a trusted login: an issued session, or one of
// the two challenges that must be completed first. The marker method keeps the
// set closed and lets the handler switch on concrete types instead of inspecting
// untyped data.
type loginOutcome interface{ loginOutcomeMarker() }

func (sessionResult) loginOutcomeMarker()             {}
func (mfaChallengeResult) loginOutcomeMarker()        {}
func (enrollmentChallengeResult) loginOutcomeMarker() {}

// login verifies a password credential and continues into the trusted flow.
func (s *Service) login(ctx context.Context, email, password string, orgID *string, ipAddress, userAgent *string) (loginOutcome, error) {
	normalizedEmail := normalizeEmail(email)
	if err := s.enforceLoginRateLimit(ctx, sceneLoginPassword, normalizedEmail, ipAddress); err != nil {
		return nil, err
	}
	userID, membershipOrgID, err := s.validateUser(ctx, normalizedEmail, password, orgID)
	if err != nil {
		return nil, err
	}
	return s.completeTrustedLogin(ctx, userID, membershipOrgID, ipAddress, userAgent, "login", false)
}

// validateUser reproduces AuthService.validateUser: load by normalized email,
// require an active user, compare the password with Node-compatible bcrypt, pick
// the membership (an omitted orgId chooses the earliest active one for login) and
// assert its organization and membership are still active.
//
// It returns the user id and the resolved organization instead of a full
// profile: every field of that profile is re-derived from scratch by
// completeTrustedLogin, which is the only consumer. Skipping the redundant
// projection cannot change the response and avoids a second permission/role
// round trip.
func (s *Service) validateUser(ctx context.Context, normalizedEmail, password string, orgID *string) (string, string, error) {
	if s.store == nil {
		return "", "", errNoDatabase
	}
	user, found, err := s.store.UserByEmail(ctx, normalizedEmail)
	if err != nil {
		return "", "", err
	}
	if !found || !user.IsActive {
		return "", "", unauthorized(invalidCredentialsMessage)
	}
	if !accountsecurity.CompareLoginPassword(user.PasswordHash, password) {
		return "", "", unauthorized(invalidCredentialsMessage)
	}
	membership, err := s.pickLoginMembership(ctx, user.ID, orgID)
	if err != nil {
		return "", "", err
	}
	return user.ID, membership.OrgID, nil
}

// pickLoginMembership loads the memberships and applies the login selection
// rule. An explicitly supplied orgId is matched by id or slug; an omitted one
// resolves to the earliest active membership.
func (s *Service) pickLoginMembership(ctx context.Context, userID string, orgID *string) (*loginMembership, error) {
	if s.store == nil {
		return nil, errNoDatabase
	}
	memberships, err := s.store.Memberships(ctx, userID)
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
	return membership, nil
}

// completeTrustedLogin is the single post-credential path. It reloads the user
// and the membership state from MySQL, decides whether a second factor is
// required, and only then issues a session.
//
// skipMfa is set only by the two challenge consumers: the factor was already
// verified by mfa/verify-login, or the enrollment was just completed by
// mfa/enrollment/complete. Re-evaluating the policy there would re-open a
// challenge and loop.
func (s *Service) completeTrustedLogin(ctx context.Context, userID, orgID string, ipAddress, userAgent *string, action string, skipMfa bool) (loginOutcome, error) {
	if s.store == nil {
		return nil, errNoDatabase
	}
	user, found, err := s.store.UserByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	if !found || !user.IsActive {
		return nil, unauthorized(invalidCredentialsMessage)
	}
	memberships, err := s.store.Memberships(ctx, userID)
	if err != nil {
		return nil, err
	}
	membership, err := accountsecurity.PickLoginMembership(memberships, orgID)
	if err != nil {
		return nil, err
	}
	if err := accountsecurity.AssertLoginMembershipAccessible(membership); err != nil {
		return nil, err
	}
	profile, err := s.store.Profile(ctx, user, membership)
	if err != nil {
		return nil, err
	}

	if !skipMfa {
		requirement, err := s.loginRequirement(ctx, user.ID, membership.OrgID)
		if err != nil {
			return nil, err
		}
		if requirement != loginRequirementNone {
			organizations, err := s.store.Organizations(ctx, user.ID)
			if err != nil {
				return nil, err
			}
			if requirement == loginRequirementVerify {
				challenge, err := s.createLoginChallenge(ctx, user.ID, membership.OrgID, ipAddress, userAgent)
				if err != nil {
					return nil, err
				}
				required := profile
				required.MFARequired = true
				return mfaChallengeResult{
					User:               required,
					Organizations:      organizations,
					MFARequired:        true,
					AuthChallengeID:    challenge.challengeID,
					ChallengeExpiresAt: challenge.expiresAt,
				}, nil
			}
			challenge, err := s.createEnrollmentChallenge(ctx, user.ID, membership.OrgID, ipAddress, userAgent, action)
			if err != nil {
				return nil, err
			}
			required := profile
			required.MFAEnrollmentRequired = true
			return enrollmentChallengeResult{
				User:                  required,
				Organizations:         organizations,
				MFAEnrollmentRequired: true,
				EnrollmentChallengeID: challenge.challengeID,
				ChallengeExpiresAt:    challenge.expiresAt,
			}, nil
		}
	}

	return s.finalizeLogin(ctx, user.ID, profile, ipAddress, userAgent, action)
}

// finalizeLogin issues the session. Order is part of the contract and matches
// NestJS exactly:
//
//  1. sign the access token, then persist the refresh token;
//  2. bump User.lastLoginAt — AFTER the profile was built, so the returned
//     profile still carries the previous login time while the next read sees the
//     new one;
//  3. write the best-effort audit record (never fatal);
//  4. read the organization options last.
func (s *Service) finalizeLogin(ctx context.Context, userID string, profile authenticatedUser, ipAddress, userAgent *string, action string) (sessionResult, error) {
	if s.db == nil {
		return sessionResult{}, errNoDatabase
	}
	access, err := s.signAccessToken(userID, profile.OrgID, profile.Permissions)
	if err != nil {
		return sessionResult{}, err
	}
	refresh, err := s.signRefreshToken(ctx, userID, profile.OrgID, ipAddress, userAgent)
	if err != nil {
		return sessionResult{}, err
	}

	now := nowMillis()
	if _, err := s.db.ExecContext(ctx,
		"UPDATE `User` SET `lastLoginAt` = ?, `updatedAt` = ? WHERE `id` = ?", now, now, userID); err != nil {
		return sessionResult{}, dbWrap(err)
	}

	metadata, err := marshalRaw(loginAuditMetadata{Email: profile.Email, UserAgent: userAgent})
	if err != nil {
		return sessionResult{}, err
	}
	s.writeAuditLogBestEffort(ctx, profile.OrgID, userID, "auth", action, metadata, ipAddress)

	organizations, err := s.store.Organizations(ctx, userID)
	if err != nil {
		return sessionResult{}, err
	}
	return sessionResult{
		User:          profile,
		AccessToken:   access.Token,
		RefreshToken:  refresh.Token,
		Organizations: organizations,
		ExpiresIn:     accessTokenExpiresInSeconds(access),
	}, nil
}

// loginRequirement mirrors MfaService.getLoginRequirement. The policy comes from
// system_security; `admins_only` is decided by the caller's role names inside
// that organization, never by a platform-wide global role.
func (s *Service) loginRequirement(ctx context.Context, userID, orgID string) (loginRequirement, error) {
	enabled, err := s.factorEnabled(ctx, userID)
	if err != nil {
		return loginRequirementNone, err
	}
	policy, err := s.mfaPolicy(ctx)
	if err != nil {
		return loginRequirementNone, err
	}
	if policy == mfaPolicyOff {
		if enabled {
			return loginRequirementVerify, nil
		}
		return loginRequirementNone, nil
	}
	isAdmin, err := s.store.OrgAdmin(ctx, userID, orgID)
	if err != nil {
		return loginRequirementNone, err
	}
	applies := policy == mfaPolicyAllUsers || (policy == mfaPolicyAdminsOnly && isAdmin)
	if !applies {
		if enabled {
			return loginRequirementVerify, nil
		}
		return loginRequirementNone, nil
	}
	if enabled {
		return loginRequirementVerify, nil
	}
	return loginRequirementEnroll, nil
}

// factorEnabled reads the shared factor state through the reused MFA service.
func (s *Service) factorEnabled(ctx context.Context, userID string) (bool, error) {
	if s.factors == nil {
		return false, errNoDatabase
	}
	status, err := s.factors.LoginMfaStatus(ctx, userID)
	if err != nil {
		return false, err
	}
	return status.Enabled, nil
}

// mfaPolicy reads the system-wide MFA policy from system_security, cached for 60
// seconds under the same key AuthSecurityService uses. The cache stores the raw
// settings value, so both implementations read and write the same document.
//
// A cached JSON null is the "row absent" answer NestJS produces; it means `off`
// and must not trigger another database read.
func (s *Service) mfaPolicy(ctx context.Context) (mfaPolicy, error) {
	raw, found, err := s.cacheGetJSON(ctx, systemSecurityCacheKey)
	if err != nil {
		return mfaPolicyOff, err
	}
	if found {
		return policyFromSettings(raw), nil
	}
	if s.db == nil {
		return mfaPolicyOff, errNoDatabase
	}
	var value []byte
	err = s.db.QueryRowContext(ctx,
		"SELECT `value` FROM SystemSetting WHERE `key` = ? LIMIT 1", systemSecurityRowKey).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		if cacheErr := s.cacheSet(ctx, systemSecurityCacheKey, json.RawMessage("null"), systemSecurityCacheTTL); cacheErr != nil {
			logBackgroundFailure("system security cache write", cacheErr)
		}
		return mfaPolicyOff, nil
	}
	if err != nil {
		return mfaPolicyOff, dbWrap(err)
	}
	cached := json.RawMessage(value)
	if !json.Valid(cached) {
		cached = json.RawMessage("null")
	}
	if cacheErr := s.cacheSet(ctx, systemSecurityCacheKey, cached, systemSecurityCacheTTL); cacheErr != nil {
		logBackgroundFailure("system security cache write", cacheErr)
	}
	return policyFromSettings(cached), nil
}

// policyFromSettings accepts only the three documented policy strings; anything
// else (a non-object document, a non-string member, an unknown word) means off.
func policyFromSettings(raw json.RawMessage) mfaPolicy {
	var settings systemSecuritySettings
	if err := json.Unmarshal(raw, &settings); err != nil {
		return mfaPolicyOff
	}
	value, ok := jsonStringValue(settings.MfaPolicy)
	if !ok {
		return mfaPolicyOff
	}
	switch mfaPolicy(value) {
	case mfaPolicyAdminsOnly:
		return mfaPolicyAdminsOnly
	case mfaPolicyAllUsers:
		return mfaPolicyAllUsers
	default:
		return mfaPolicyOff
	}
}
