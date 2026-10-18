package authlogin

import (
	"context"
	"database/sql"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
)

// This file ports AuthService.refresh. The order of the steps is the protocol:
// the revocation pre-check runs before the grace cache, the single-use claim runs
// before the secret comparison, and the old token is revoked only after the new
// pair was issued.

// refresh rotates a refresh credential into a fresh session.
func (s *Service) refresh(ctx context.Context, refreshToken string, orgID *string, ipAddress, userAgent *string) (sessionResult, error) {
	if s.store == nil {
		return sessionResult{}, errNoDatabase
	}
	credential, err := parseRefreshToken(refreshToken)
	if err != nil {
		return sessionResult{}, err
	}
	// body.orgId wins over the organization embedded in the token, but only when
	// the member is actually present: an explicit empty string must NOT collapse
	// into "absent", because the selection rule differs (an empty selector asks
	// the user to choose; an absent one uses the token's organization).
	effectiveOrgID := credential.OrgID
	if orgID != nil {
		effectiveOrgID = *orgID
	}

	graceSeconds := s.cfg.AuthRefreshGraceSeconds
	lockTTL := time.Duration(graceSeconds) * time.Second
	if lockTTL < refreshGraceLockFloor {
		lockTTL = refreshGraceLockFloor
	}
	cacheKey := refreshGraceCacheKey(credential.TokenID, credential.Secret)

	// The revocation check runs OUTSIDE the cache wrapper on purpose. A cache hit
	// returns the previous rotation result without executing the loader, so a
	// check that only lived inside the loader would be skipped for the whole
	// grace window — letting a stolen token keep working right after the victim
	// rotated it.
	revoked, err := s.store.RefreshBlacklisted(ctx, credential.TokenID)
	if err != nil {
		return sessionResult{}, err
	}
	if revoked {
		return sessionResult{}, unauthorized(refreshTokenExpiredMessage)
	}

	return s.wrapRefreshResult(ctx, cacheKey, graceSeconds,
		func(loaderCtx context.Context) (sessionResult, error) {
			return s.rotateRefreshToken(loaderCtx, credential, effectiveOrgID, ipAddress, userAgent)
		},
		lockTTL, retryDelayMs*time.Millisecond, lockTTL)
}

// refreshTokenRowSQL selects the columns the rotation compares against.
const refreshTokenRowSQL = "SELECT `userId`, `tokenHash`, `expiresAt` FROM `RefreshToken` WHERE `id` = ?"

// rotateRefreshToken performs the single-use rotation under the shared lock.
//
// The conditional UPDATE is the real single-use guarantee: it runs BEFORE the
// secret is compared, so only one caller can ever claim the token, even when the
// lock was unavailable and several loaders run at once. Changing that order would
// break the protocol NestJS relies on.
func (s *Service) rotateRefreshToken(ctx context.Context, credential refreshCredential, effectiveOrgID string, ipAddress, userAgent *string) (sessionResult, error) {
	now := nowMillis()

	// Re-check inside the loader: between the outer pre-check and this claim the
	// token may have been revoked (logout, password change, password reset).
	revoked, err := s.store.RefreshBlacklisted(ctx, credential.TokenID)
	if err != nil {
		return sessionResult{}, err
	}
	if revoked {
		return sessionResult{}, unauthorized(refreshTokenExpiredMessage)
	}

	claim, err := s.db.ExecContext(ctx,
		"UPDATE `RefreshToken` SET `revokedAt` = ?, "+
			"`ipAddress` = COALESCE(?, `ipAddress`), `userAgent` = COALESCE(?, `userAgent`) "+
			"WHERE `id` = ? AND `revokedAt` IS NULL AND `expiresAt` > ?",
		now, osNullString(ipAddress), osNullString(userAgent), credential.TokenID, now)
	if err != nil {
		return sessionResult{}, dbWrap(err)
	}
	claimed, err := claim.RowsAffected()
	if err != nil {
		return sessionResult{}, dbWrap(err)
	}
	if claimed != 1 {
		return sessionResult{}, unauthorized(refreshTokenExpiredMessage)
	}

	var record refreshTokenRow
	err = s.db.QueryRowContext(ctx, refreshTokenRowSQL, credential.TokenID).
		Scan(&record.UserID, &record.TokenHash, &record.ExpiresAt)
	if isNoRows(err) {
		return sessionResult{}, unauthorized(refreshTokenExpiredMessage)
	}
	if err != nil {
		return sessionResult{}, dbWrap(err)
	}
	if !accountsecurity.CompareLoginPassword(record.TokenHash, credential.Secret) {
		return sessionResult{}, unauthorized(invalidRefreshTokenMessage)
	}

	user, found, err := s.store.UserByID(ctx, record.UserID)
	if err != nil {
		return sessionResult{}, err
	}
	if !found || !user.IsActive {
		return sessionResult{}, unauthorized(userNotFoundMessage)
	}
	memberships, err := s.store.Memberships(ctx, user.ID)
	if err != nil {
		return sessionResult{}, err
	}
	// Refresh keeps the stricter selection rule: a user with several active
	// organizations must name one, otherwise the session could silently move
	// between tenants.
	membership, err := accountsecurity.PickSessionMembership(memberships, effectiveOrgID)
	if err != nil {
		return sessionResult{}, err
	}
	if err := accountsecurity.AssertLoginMembershipAccessible(membership); err != nil {
		return sessionResult{}, err
	}
	profile, err := s.store.Profile(ctx, user, membership)
	if err != nil {
		return sessionResult{}, err
	}

	access, err := s.signAccessToken(user.ID, profile.OrgID, profile.Permissions)
	if err != nil {
		return sessionResult{}, err
	}
	newRefresh, err := s.signRefreshToken(ctx, user.ID, profile.OrgID, ipAddress, userAgent)
	if err != nil {
		return sessionResult{}, err
	}

	// Revoke the rotated credential for the remainder of its original lifetime.
	// The TTL is derived from the stored expiry, so the blacklist entry never
	// outlives the token it protects.
	blacklistTTL := ttlSecondsUntil(record.ExpiresAt, now)
	if blacklistTTL > 0 {
		if err := s.store.AddRefreshBlacklist(ctx, credential.TokenID, blacklistTTL); err != nil {
			return sessionResult{}, err
		}
	}

	organizations, err := s.store.Organizations(ctx, user.ID)
	if err != nil {
		return sessionResult{}, err
	}
	return sessionResult{
		User:          profile,
		AccessToken:   access.Token,
		RefreshToken:  newRefresh.Token,
		Organizations: organizations,
		ExpiresIn:     accessTokenExpiresInSeconds(access),
	}, nil
}

// revokeAllRefreshTokens marks every live refresh token of a user revoked. Used
// by the password-reset transaction.
func revokeAllRefreshTokens(ctx context.Context, tx *sql.Tx, userID string, now time.Time) error {
	if _, err := tx.ExecContext(ctx,
		"UPDATE `RefreshToken` SET `revokedAt` = ? WHERE `userId` = ? AND `revokedAt` IS NULL",
		now, userID); err != nil {
		return dbWrap(err)
	}
	return nil
}
