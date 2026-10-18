package accountsecurity

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// logout mirrors AuthService.logout:
//
//  1. logoutAll=true revokes every RefreshToken row of the user (across all of
//     the user's organizations, because RefreshToken is owned by userId and has
//     no orgId column);
//  2. otherwise a provided refreshToken contributes only its first dot-separated
//     segment as the row id, and only the row with that id AND the current user
//     is revoked. Another user's token is never touched;
//  3. the refresh row still carrying a future expiry is blacklisted with the
//     remaining TTL;
//  4. the current verified jti/exp pair is blacklisted with the remaining TTL;
//  5. a best-effort audit row is written for the current membership.
//
// A machine identity has no jti/exp and no real RefreshToken rows, so logout
// degrades to a no-op exactly like NestJS. logoutAll is explicitly NOT a scan of
// every historical access JWT: only the current access token is blacklisted.
//
// Redis failures propagate; a failed blacklist write never yields a fake
// successful logout.
func (s *Service) logout(ctx context.Context, identity *Identity, refreshToken *string, logoutAll bool) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	userID := identity.UserID
	now := nowMillis()

	if logoutAll {
		if _, err := s.db.ExecContext(ctx,
			"UPDATE `RefreshToken` SET `revokedAt` = ? WHERE `userId` = ?", now, userID); err != nil {
			return dbWrap(err)
		}
	} else if refreshToken != nil && *refreshToken != "" {
		// NestJS uses `refreshToken.split(".")[0]`; it deliberately does not use
		// the stricter refresh-token parser (that parser is only for refresh()).
		tokenID := strings.SplitN(*refreshToken, ".", 2)[0]
		if tokenID != "" {
			if _, err := s.db.ExecContext(ctx,
				"UPDATE `RefreshToken` SET `revokedAt` = ? WHERE `id` = ? AND `userId` = ?",
				now, tokenID, userID); err != nil {
				return dbWrap(err)
			}

			var ownerID string
			var expiresAt time.Time
			err := s.db.QueryRowContext(ctx,
				"SELECT `userId`, `expiresAt` FROM `RefreshToken` WHERE `id` = ?", tokenID).
				Scan(&ownerID, &expiresAt)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return dbWrap(err)
			}
			// A token that points at another user must neither revoke nor
			// blacklist anything.
			if err == nil && ownerID == userID {
				if ttl := ttlSecondsUntil(expiresAt, now); ttl > 0 {
					if err := s.blacklistSet(ctx, refreshTokenBlacklistKeyPrefix+tokenID, ttl); err != nil {
						return err
					}
				}
			}
		}
	}

	// The access-token expiry arrives in milliseconds (exp * 1000 in
	// JwtStrategy); it is never treated as seconds. A token without verified
	// exp (old token) writes no blacklist key.
	if identity.AccessTokenID != "" && !identity.AccessTokenExpiresAt.IsZero() {
		if ttl := ttlSecondsUntil(identity.AccessTokenExpiresAt, now); ttl > 0 {
			if err := s.blacklistSet(ctx, accessTokenBlacklistKeyPrefix+identity.AccessTokenID, ttl); err != nil {
				return err
			}
		}
	}

	orgID, err := s.auditOrgID(ctx, userID, identity.OrgID)
	if err != nil {
		return err
	}
	if orgID != nil {
		s.writeAuditLogBestEffort(ctx, *orgID, userID, "auth", "logout", nil)
	}
	return nil
}
