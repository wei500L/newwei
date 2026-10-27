package authlogin

import (
	"context"
	"database/sql"
	"net/url"
	"strings"
)

// This file ports PasswordResetService. The forgot route answers the same
// {ok:true} for a missing or disabled account (no token is created), while a
// delivery failure propagates: unlike the login code, a silently dropped reset
// link would leave the user with no way forward and no signal.

// requestPasswordReset implements POST /api/auth/password/forgot.
func (s *Service) requestPasswordReset(ctx context.Context, email string, ipAddress, userAgent *string) (okResult, error) {
	normalizedEmail := normalizeEmail(email)
	if err := s.enforcePasswordResetRateLimit(ctx, normalizedEmail, ipAddress); err != nil {
		return okResult{}, err
	}
	if s.store == nil {
		return okResult{}, errNoDatabase
	}
	user, found, err := s.store.UserByEmail(ctx, normalizedEmail)
	if err != nil {
		return okResult{}, err
	}
	if !found || !user.IsActive {
		return okResult{}, nil
	}

	rawToken, err := randomHex(passwordResetSecret)
	if err != nil {
		return okResult{}, err
	}
	resetURL, err := buildPasswordResetURL(s.cfg.NextAuthURL, rawToken)
	if err != nil {
		return okResult{}, err
	}

	if err := s.storePasswordResetToken(ctx, user.ID, rawToken, ipAddress, userAgent); err != nil {
		return okResult{}, err
	}
	if err := s.mailer.sendPasswordReset(ctx, normalizedEmail, resetURL); err != nil {
		// Propagated on purpose: the caller gets a real failure instead of a
		// success for a link that was never delivered.
		return okResult{}, err
	}

	orgID, err := s.primaryMembershipOrgID(ctx, user.ID)
	if err != nil {
		return okResult{}, err
	}
	if orgID != "" {
		metadata, err := marshalRaw(emailAuditMetadata{Email: normalizedEmail})
		if err != nil {
			return okResult{}, err
		}
		s.writeAuditLogBestEffort(ctx, orgID, user.ID, "auth", "password_reset_requested", metadata, ipAddress)
	}
	return okResult{OK: true}, nil
}

// storePasswordResetToken persists only the SHA-256 of the reset token, so a
// database read cannot reconstruct a usable link.
func (s *Service) storePasswordResetToken(ctx context.Context, userID, rawToken string, ipAddress, userAgent *string) error {
	if s.db == nil {
		return errNoDatabase
	}
	tokenID, err := newRowID()
	if err != nil {
		return err
	}
	now := nowMillis()
	if _, err := s.db.ExecContext(ctx,
		"INSERT INTO `PasswordResetToken` (`id`, `userId`, `tokenHash`, `ipAddress`, `userAgent`, "+
			"`expiresAt`, `usedAt`, `createdAt`) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
		tokenID, userID, hashSHA256Hex(rawToken), osNullString(ipAddress), osNullString(userAgent),
		now.Add(passwordResetTTL), now); err != nil {
		return dbWrap(err)
	}
	return nil
}

// buildPasswordResetURL mirrors `new URL("/reset-password", baseUrl)` followed by
// `searchParams.set("token", rawToken)`: an absolute path replaces any path on
// the base while the origin and scheme are preserved.
func buildPasswordResetURL(baseURL, rawToken string) (string, error) {
	base := strings.TrimSpace(baseURL)
	if base == "" {
		base = "http://localhost:3000"
	}
	parsed, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	target := parsed.ResolveReference(&url.URL{Path: "/reset-password"})
	query := target.Query()
	query.Set("token", rawToken)
	target.RawQuery = query.Encode()
	return target.String(), nil
}

// primaryMembershipOrgID mirrors `user.memberships[0]?.orgId` with
// orderBy createdAt ASC.
func (s *Service) primaryMembershipOrgID(ctx context.Context, userID string) (string, error) {
	if s.db == nil {
		return "", errNoDatabase
	}
	var orgID string
	err := s.db.QueryRowContext(ctx,
		"SELECT `orgId` FROM `Membership` WHERE `userId` = ? ORDER BY `createdAt` ASC LIMIT 1", userID).
		Scan(&orgID)
	if isNoRows(err) {
		return "", nil
	}
	if err != nil {
		return "", dbWrap(err)
	}
	return orgID, nil
}

// resetPassword implements POST /api/auth/password/reset.
//
// The token is validated and the password length checked BEFORE the transaction,
// then one transaction replaces the password hash, consumes every unused reset
// token of the user and revokes every live refresh token. A partial commit would
// leave the old password usable or an old session alive.
//
// The single-use guarantee is the CONDITIONAL claim on the token row, not the
// pre-check: two concurrent requests carrying the same token both read the row
// as unused, so only the caller whose `UPDATE ... WHERE tokenHash = ? AND
// usedAt IS NULL` affects exactly one row may rotate the password. The loser
// rolls back and answers the same 401 an expired token gets. Nest performs the
// same read-then-write without the claim, so both callers there rotate the
// password and both answer {ok:true} (last writer wins) — this is a Nest defect
// that Go deliberately fixes.
func (s *Service) resetPassword(ctx context.Context, token, password string, ipAddress *string) (okResult, error) {
	if s.db == nil {
		return okResult{}, errNoDatabase
	}
	tokenHash := hashSHA256Hex(strings.TrimSpace(token))
	var record passwordResetTokenRow
	var usedAt sql.NullTime
	err := s.db.QueryRowContext(ctx,
		"SELECT `userId`, `expiresAt`, `usedAt` FROM `PasswordResetToken` WHERE `tokenHash` = ? LIMIT 1", tokenHash).
		Scan(&record.UserID, &record.ExpiresAt, &usedAt)
	if isNoRows(err) {
		return okResult{}, unauthorized(passwordResetTokenMessage)
	}
	if err != nil {
		return okResult{}, dbWrap(err)
	}
	record.UsedAt = nullableTime(usedAt)
	if record.UsedAt != nil || record.ExpiresAt.Before(nowMillis()) {
		return okResult{}, unauthorized(passwordResetTokenMessage)
	}

	trimmedPassword := strings.TrimSpace(password)
	// PasswordResetService compares `params.password.trim().length` — the
	// JavaScript string length (UTF-16 code units), not the rune count.
	if jsStringLength(trimmedPassword) < minPasswordLength {
		return okResult{}, badRequest(passwordTooShortMessage)
	}
	passwordHash, err := hashPassword(trimmedPassword)
	if err != nil {
		return okResult{}, err
	}

	now := nowMillis()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return okResult{}, dbWrap(err)
	}
	defer func() { _ = tx.Rollback() }()

	// Claim the token first: exactly one caller can consume it, even when the
	// pre-check above ran in several requests at once. The expiry predicate is
	// repeated so a token that expired between the read and this claim cannot be
	// claimed either.
	claim, err := tx.ExecContext(ctx,
		"UPDATE `PasswordResetToken` SET `usedAt` = ? WHERE `tokenHash` = ? AND `usedAt` IS NULL "+
			"AND `expiresAt` > ?",
		now, tokenHash, now)
	if err != nil {
		return okResult{}, dbWrap(err)
	}
	claimed, err := claim.RowsAffected()
	if err != nil {
		return okResult{}, dbWrap(err)
	}
	if claimed != 1 {
		// Another request consumed the token (or it expired) after the pre-check:
		// this caller must not rotate the password.
		return okResult{}, unauthorized(passwordResetTokenMessage)
	}

	if _, err := tx.ExecContext(ctx,
		"UPDATE `User` SET `passwordHash` = ?, `updatedAt` = ? WHERE `id` = ?",
		passwordHash, now, record.UserID); err != nil {
		return okResult{}, dbWrap(err)
	}
	if _, err := tx.ExecContext(ctx,
		"UPDATE `PasswordResetToken` SET `usedAt` = ? WHERE `userId` = ? AND `usedAt` IS NULL",
		now, record.UserID); err != nil {
		return okResult{}, dbWrap(err)
	}
	if err := revokeAllRefreshTokens(ctx, tx, record.UserID, now); err != nil {
		return okResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return okResult{}, dbWrap(err)
	}

	orgID, err := s.primaryMembershipOrgID(ctx, record.UserID)
	if err != nil {
		return okResult{}, err
	}
	if orgID != "" {
		s.writeAuditLogBestEffort(ctx, orgID, record.UserID, "auth", "password_reset_completed", nil, ipAddress)
	}
	return okResult{OK: true}, nil
}
