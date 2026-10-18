package accountsecurity

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"net/http"

	"golang.org/x/crypto/bcrypt"
)

// bcryptCost is the cost NestJS uses (bcrypt.hash(password, 10)).
const bcryptCost = 10

// bcryptMaxPasswordBytes is the byte budget the Blowfish key schedule uses.
// Node's bcrypt@5.1.1 (the repo dependency) truncates the UTF-8 bytes here, so
// Go must truncate identically: the byte slice, never a rune/character count.
const bcryptMaxPasswordBytes = 72

// nodeBcryptPassword reproduces what Node bcrypt actually feeds to the C
// implementation:
//
//   - the password is converted to its UTF-8 bytes (Go strings already are);
//   - the C code treats it as a NUL-terminated string, so everything after the
//     first 0x00 byte is invisible;
//   - bcrypt_hashpw caps the length at 72 bytes.
//
// It therefore truncates on the UTF-8 byte sequence, deliberately not on rune
// boundaries: a multi-byte character that crosses byte 72 is cut mid-sequence,
// exactly like Node. Go's bcrypt.GenerateFromPassword/CompareHashAndPassword
// return ErrPasswordTooLong above 72 bytes, so every call must go through this
// adapter instead of the raw input.
func nodeBcryptPassword(password string) []byte {
	raw := []byte(password)
	if index := bytes.IndexByte(raw, 0); index >= 0 {
		raw = raw[:index]
	}
	if len(raw) > bcryptMaxPasswordBytes {
		raw = raw[:bcryptMaxPasswordBytes]
	}
	return raw
}

// changePassword mirrors AuthService.changePassword with the AS2
// compare-and-swap fix:
//
//   - the raw-string equality check runs before any bcrypt work;
//   - the current password is verified against the stored hash with cost 10;
//   - the new hash replaces the old one only when the stored hash still equals
//     the value that was verified (single conditional UPDATE);
//   - a zero-row CAS aborts the interactive transaction with 409 and rolls the
//     refresh-token revoke back;
//   - every non-revoked RefreshToken of the user is revoked in the same
//     transaction, across all of the user's organizations (RefreshToken has no
//     orgId column).
func (s *Service) changePassword(ctx context.Context, userID, claimOrgID, currentPassword, newPassword string) error {
	if currentPassword == "" || newPassword == "" {
		return badRequest("Password fields are required")
	}
	if currentPassword == newPassword {
		return badRequest("New password must be different from current password")
	}
	if s == nil || s.db == nil {
		return errNoDatabase
	}

	var storedHash string
	err := s.db.QueryRowContext(ctx, "SELECT `passwordHash` FROM `User` WHERE `id` = ?", userID).Scan(&storedHash)
	if errors.Is(err, sql.ErrNoRows) {
		return unauthorized("Invalid credentials")
	}
	if err != nil {
		return dbWrap(err)
	}

	// Node bcrypt truncates both operands; comparing the untruncated Go string
	// would return ErrPasswordTooLong for the long passwords the DTO allows.
	if err := bcrypt.CompareHashAndPassword([]byte(storedHash), nodeBcryptPassword(currentPassword)); err != nil {
		return unauthorized("Invalid credentials")
	}

	newHash, err := bcrypt.GenerateFromPassword(nodeBcryptPassword(newPassword), bcryptCost)
	if err != nil {
		return err
	}

	now := nowMillis()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return dbWrap(err)
	}
	defer func() {
		// A successful Commit makes this a no-op (sql.ErrTxDone); every error
		// path rolls back instead of leaving a partial write.
		_ = tx.Rollback()
	}()

	result, err := tx.ExecContext(ctx,
		"UPDATE `User` SET `passwordHash` = ?, `updatedAt` = ? WHERE `id` = ? AND `passwordHash` = ?",
		string(newHash), now, userID, storedHash)
	if err != nil {
		return dbWrap(err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return dbWrap(err)
	}
	if affected != 1 {
		// AS2: another request already committed a different password. Abort
		// without touching the password again or revoking more refresh tokens.
		return &httpError{
			status:  http.StatusConflict,
			message: "Password changed by another request; retry with the current password",
		}
	}

	if _, err := tx.ExecContext(ctx,
		"UPDATE `RefreshToken` SET `revokedAt` = ? WHERE `userId` = ? AND `revokedAt` IS NULL",
		now, userID); err != nil {
		return dbWrap(err)
	}

	if err := tx.Commit(); err != nil {
		return dbWrap(err)
	}

	return s.invalidateProfileCache(ctx, userID, claimOrgID)
}
