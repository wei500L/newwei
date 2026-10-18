package authfactors

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"
)

// dbtx is the subset of database/sql shared by *sql.DB and *sql.Tx, so the
// same statement helpers can run either on the pool or inside the caller's
// transaction. Every statement is parameterized; no user input is ever
// concatenated into SQL.
type dbtx interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// newRowID produces a collision-resistant primary key for the rows this package
// inserts. Prisma generates cuids client-side, so the column is a plain
// VARCHAR(191) with no database default and any unique string works.
func newRowID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}

// loadUserEmail reads the real account email used as the TOTP account name.
// found is false when the id is not a User row, which is exactly the machine
// identity case (AF5).
func (s *Service) loadUserEmail(ctx context.Context, q dbtx, userID string) (string, bool, error) {
	if s == nil || s.db == nil {
		return "", false, errNoDatabase
	}
	var email string
	err := q.QueryRowContext(ctx, "SELECT `email` FROM `User` WHERE `id` = ? LIMIT 1", userID).Scan(&email)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return email, true, nil
}

// membershipOrgIDs lists every organization the user belongs to. The profile
// cache invalidation walks this list so a factor change is visible in all of
// the user's organizations, not only the active one.
func (s *Service) membershipOrgIDs(ctx context.Context, userID string) ([]string, error) {
	if s == nil || s.db == nil {
		return nil, errNoDatabase
	}
	rows, err := s.db.QueryContext(ctx, "SELECT `orgId` FROM `Membership` WHERE `userId` = ?", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	orgIDs := make([]string, 0, 4)
	for rows.Next() {
		var orgID string
		if err := rows.Scan(&orgID); err != nil {
			return nil, err
		}
		orgIDs = append(orgIDs, orgID)
	}
	return orgIDs, rows.Err()
}

// loadSystemSecuritySetting reads the global `system_security` row value.
func (s *Service) loadSystemSecuritySetting(ctx context.Context) (json.RawMessage, bool, error) {
	if s == nil || s.db == nil {
		return nil, false, errNoDatabase
	}
	var raw []byte
	err := s.db.QueryRowContext(ctx,
		"SELECT `value` FROM `SystemSetting` WHERE `key` = ? LIMIT 1", systemSecuritySettingKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return json.RawMessage(raw), true, nil
}

// ---- UserTotpFactor ----

// factorColumns is the shared select list. pendingSecret is scanned as raw JSON
// bytes so SQL NULL stays distinguishable from an empty value.
const factorColumns = "`secret`, `pendingSecret`, `label`, `pendingLabel`, `enrolledAt`, `verifiedAt`, `disabledAt`, `lastUsedAt`"

// loadFactor reads the user's single factor row.
func (s *Service) loadFactor(ctx context.Context, q dbtx, userID string) (mfaFactorRow, bool, error) {
	if s == nil || s.db == nil {
		return mfaFactorRow{}, false, errNoDatabase
	}
	var row mfaFactorRow
	err := q.QueryRowContext(ctx,
		"SELECT "+factorColumns+" FROM `UserTotpFactor` WHERE `userId` = ? LIMIT 1", userID).
		Scan(&row.Secret, &row.PendingSecret, &row.Label, &row.PendingLabel,
			&row.EnrolledAt, &row.VerifiedAt, &row.DisabledAt, &row.LastUsedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return mfaFactorRow{}, false, nil
	}
	if err != nil {
		return mfaFactorRow{}, false, err
	}
	return row, true, nil
}

// upsertFactorSecret mirrors the Prisma upsert used when there is no active
// factor: the update branch replaces the secret and clears every pending and
// verification field, while the insert branch lets enrolledAt/createdAt fall to
// their database defaults. One statement keeps the branch choice atomic.
const upsertFactorSecretSQL = "INSERT INTO `UserTotpFactor` " +
	"(`id`, `userId`, `secret`, `pendingSecret`, `label`, `pendingLabel`, `pendingStartedAt`, " +
	"`verifiedAt`, `disabledAt`, `lastUsedAt`, `createdAt`, `updatedAt`) " +
	"VALUES (?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, ?) AS new_row " +
	"ON DUPLICATE KEY UPDATE `secret` = new_row.`secret`, `pendingSecret` = NULL, " +
	"`label` = new_row.`label`, `pendingLabel` = NULL, `pendingStartedAt` = NULL, " +
	"`verifiedAt` = NULL, `disabledAt` = NULL, `lastUsedAt` = NULL, `updatedAt` = new_row.`updatedAt`"

// upsertFactorSecret writes the initial (or restart) secret.
func (s *Service) upsertFactorSecret(ctx context.Context, q dbtx, userID string, secret json.RawMessage, label string) error {
	id, err := newRowID()
	if err != nil {
		return err
	}
	now := nowMillis()
	_, err = q.ExecContext(ctx, upsertFactorSecretSQL, id, userID, []byte(secret), label, now, now)
	return err
}

// startPendingReplacement stores a new secret as pendingSecret while the active
// factor keeps its verified secret and recovery codes.
const startPendingReplacementSQL = "UPDATE `UserTotpFactor` " +
	"SET `pendingSecret` = ?, `pendingLabel` = ?, `pendingStartedAt` = ?, `updatedAt` = ? " +
	"WHERE `userId` = ?"

// startPendingReplacement writes a pending replacement for an active factor.
func (s *Service) startPendingReplacement(ctx context.Context, q dbtx, userID string, secret json.RawMessage, label string) error {
	now := nowMillis()
	_, err := q.ExecContext(ctx, startPendingReplacementSQL, []byte(secret), label, now, now, userID)
	return err
}

// promotePendingFactorSQL commits a completed enrollment: the selected secret
// becomes the verified one, every pending field is cleared to SQL NULL, and
// disabledAt is reset. enrolledAt is supplied by the caller because NestJS only
// rewrites it when an active factor's pending replacement is promoted.
const promotePendingFactorSQL = "UPDATE `UserTotpFactor` " +
	"SET `secret` = ?, `label` = ?, `pendingSecret` = NULL, `pendingLabel` = NULL, " +
	"`pendingStartedAt` = NULL, `enrolledAt` = ?, `verifiedAt` = ?, `disabledAt` = NULL, " +
	"`lastUsedAt` = ?, `updatedAt` = ? WHERE `userId` = ?"

// promotePendingFactor commits a completed enrollment inside the caller's
// transaction.
func (s *Service) promotePendingFactor(ctx context.Context, q dbtx, userID string, secret json.RawMessage, label string, enrolledAt, verifiedAt time.Time) error {
	_, err := q.ExecContext(ctx, promotePendingFactorSQL,
		[]byte(secret), label, enrolledAt, verifiedAt, verifiedAt, verifiedAt, userID)
	return err
}

// touchFactorLastUsed refreshes lastUsedAt with updateMany semantics: a user
// whose factor row is missing is not an error.
func (s *Service) touchFactorLastUsed(ctx context.Context, q dbtx, userID string) error {
	_, err := q.ExecContext(ctx,
		"UPDATE `UserTotpFactor` SET `lastUsedAt` = ?, `updatedAt` = ? WHERE `userId` = ?",
		nowMillis(), nowMillis(), userID)
	return err
}

// disableFactor sets disabledAt with updateMany semantics: the factor row is
// kept (never deleted) and no other column is cleared.
func (s *Service) disableFactor(ctx context.Context, q dbtx, userID string) error {
	now := nowMillis()
	_, err := q.ExecContext(ctx,
		"UPDATE `UserTotpFactor` SET `disabledAt` = ?, `updatedAt` = ? WHERE `userId` = ?",
		now, now, userID)
	return err
}

// ---- UserRecoveryCode ----

// countUnusedRecoveryCodes counts the codes the user has not consumed yet.
func (s *Service) countUnusedRecoveryCodes(ctx context.Context, q dbtx, userID string) (int, error) {
	if s == nil || s.db == nil {
		return 0, errNoDatabase
	}
	var count int
	err := q.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM `UserRecoveryCode` WHERE `userId` = ? AND `usedAt` IS NULL", userID).Scan(&count)
	if err != nil {
		return 0, err
	}
	return count, nil
}

// findUnusedRecoveryCodeID looks up the row id for one unused code hash.
func (s *Service) findUnusedRecoveryCodeID(ctx context.Context, q dbtx, userID, codeHash string) (string, bool, error) {
	if s == nil || s.db == nil {
		return "", false, errNoDatabase
	}
	var id string
	err := q.QueryRowContext(ctx,
		"SELECT `id` FROM `UserRecoveryCode` WHERE `userId` = ? AND `codeHash` = ? AND `usedAt` IS NULL LIMIT 1",
		userID, codeHash).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return id, true, nil
}

// claimRecoveryCode is the atomic single-use claim. It is a conditional update
// (usedAt IS NULL) and the caller must require exactly one affected row: a
// read-then-unconditional-update would let two concurrent callers both succeed.
func (s *Service) claimRecoveryCode(ctx context.Context, q dbtx, id string) (int64, error) {
	result, err := q.ExecContext(ctx,
		"UPDATE `UserRecoveryCode` SET `usedAt` = ? WHERE `id` = ? AND `usedAt` IS NULL",
		nowMillis(), id)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// deleteRecoveryCodes removes every recovery code the user owns.
func (s *Service) deleteRecoveryCodes(ctx context.Context, q dbtx, userID string) error {
	_, err := q.ExecContext(ctx, "DELETE FROM `UserRecoveryCode` WHERE `userId` = ?", userID)
	return err
}

// insertRecoveryCodes stores the hashes of one freshly generated set.
func (s *Service) insertRecoveryCodes(ctx context.Context, q dbtx, userID string, codeHashes []string) error {
	now := nowMillis()
	for _, codeHash := range codeHashes {
		id, err := newRowID()
		if err != nil {
			return err
		}
		if _, err := q.ExecContext(ctx,
			"INSERT INTO `UserRecoveryCode` (`id`, `userId`, `codeHash`, `createdAt`) VALUES (?, ?, ?, ?)",
			id, userID, codeHash, now); err != nil {
			return err
		}
	}
	return nil
}

// ---- OrgOidcConfig ----

// oidcColumns is the shared select list for the organization OIDC row.
const oidcColumns = "`enabled`, `issuerUrl`, `discoveryUrl`, `clientId`, `clientSecret`, `scopes`, `buttonLabel`, `requireEmailVerified`"

// loadOidcConfig reads the organization's OIDC configuration.
func (s *Service) loadOidcConfig(ctx context.Context, q dbtx, orgID string) (oidcConfigRow, bool, error) {
	if s == nil || s.db == nil {
		return oidcConfigRow{}, false, errNoDatabase
	}
	var row oidcConfigRow
	err := q.QueryRowContext(ctx,
		"SELECT "+oidcColumns+" FROM `OrgOidcConfig` WHERE `orgId` = ? LIMIT 1", orgID).
		Scan(&row.Enabled, &row.IssuerURL, &row.DiscoveryURL, &row.ClientID,
			&row.ClientSecret, &row.Scopes, &row.ButtonLabel, &row.RequireEmailVerified)
	if errors.Is(err, sql.ErrNoRows) {
		return oidcConfigRow{}, false, nil
	}
	if err != nil {
		return oidcConfigRow{}, false, err
	}
	return row, true, nil
}

// oidcUpsertParams is the named parameter set for one configuration write. The
// nullable columns are []byte/nil so SQL NULL is written rather than a JSON
// literal null.
type oidcUpsertParams struct {
	OrgID                string
	Enabled              bool
	IssuerURL            string
	DiscoveryURL         []byte
	ClientID             string
	ClientSecret         []byte
	Scopes               []byte
	ButtonLabel          []byte
	RequireEmailVerified bool
}

// upsertOidcConfigSQL replaces every column of the row (AF4 keeps the secret
// atomic by using a statement that omits the clientSecret assignment instead of
// re-writing a previously read value).
const upsertOidcConfigSQL = "INSERT INTO `OrgOidcConfig` " +
	"(`id`, `orgId`, `enabled`, `issuerUrl`, `discoveryUrl`, `clientId`, `clientSecret`, `scopes`, " +
	"`buttonLabel`, `requireEmailVerified`, `createdAt`, `updatedAt`) " +
	"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) AS new_row " +
	"ON DUPLICATE KEY UPDATE `enabled` = new_row.`enabled`, `issuerUrl` = new_row.`issuerUrl`, " +
	"`discoveryUrl` = new_row.`discoveryUrl`, `clientId` = new_row.`clientId`, " +
	"`clientSecret` = new_row.`clientSecret`, `scopes` = new_row.`scopes`, " +
	"`buttonLabel` = new_row.`buttonLabel`, `requireEmailVerified` = new_row.`requireEmailVerified`, " +
	"`updatedAt` = new_row.`updatedAt`"

// upsertOidcConfigKeepSecretSQL is the variant used when the request carried no
// non-empty client secret: the column is absent from both the column list and
// the update assignment, so an existing row keeps the database's current bytes
// and a new row gets SQL NULL. This is what makes "keep the secret" atomic at
// write time instead of a read-modify-write that could revert a concurrent
// rotation.
const upsertOidcConfigKeepSecretSQL = "INSERT INTO `OrgOidcConfig` " +
	"(`id`, `orgId`, `enabled`, `issuerUrl`, `discoveryUrl`, `clientId`, `scopes`, " +
	"`buttonLabel`, `requireEmailVerified`, `createdAt`, `updatedAt`) " +
	"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) AS new_row " +
	"ON DUPLICATE KEY UPDATE `enabled` = new_row.`enabled`, `issuerUrl` = new_row.`issuerUrl`, " +
	"`discoveryUrl` = new_row.`discoveryUrl`, `clientId` = new_row.`clientId`, " +
	"`scopes` = new_row.`scopes`, `buttonLabel` = new_row.`buttonLabel`, " +
	"`requireEmailVerified` = new_row.`requireEmailVerified`, `updatedAt` = new_row.`updatedAt`"

// upsertOidcConfig writes one configuration row. When params.ClientSecret is
// nil the clientSecret column is left untouched.
func (s *Service) upsertOidcConfig(ctx context.Context, q dbtx, params oidcUpsertParams) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	id, err := newRowID()
	if err != nil {
		return err
	}
	now := nowMillis()
	if params.ClientSecret == nil {
		_, err = q.ExecContext(ctx, upsertOidcConfigKeepSecretSQL,
			id, params.OrgID, params.Enabled, params.IssuerURL, params.DiscoveryURL, params.ClientID,
			params.Scopes, params.ButtonLabel, params.RequireEmailVerified, now, now)
		return err
	}
	_, err = q.ExecContext(ctx, upsertOidcConfigSQL,
		id, params.OrgID, params.Enabled, params.IssuerURL, params.DiscoveryURL, params.ClientID,
		params.ClientSecret, params.Scopes, params.ButtonLabel, params.RequireEmailVerified, now, now)
	return err
}
