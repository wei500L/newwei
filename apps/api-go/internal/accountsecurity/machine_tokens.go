package accountsecurity

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// This file reproduces MachineTokenService.create/list/revoke/rotate with the
// AS1 (atomic rotation) and AS4 (creator foreign key / blank name) fixes.

// machineTokenPrefix is the mtk_ credential prefix.
const machineTokenPrefix = "mtk_"

// newMachineTokenPlaintext mirrors
// `mtk_${crypto.randomBytes(32).toString("base64url")}`: 32 bytes from a
// cryptographic source encoded without padding. The plaintext is shown once and
// never stored.
func newMachineTokenPlaintext() (string, error) {
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return machineTokenPrefix + base64.RawURLEncoding.EncodeToString(buf[:]), nil
}

// hashMachineToken mirrors hashToken: the lowercase SHA-256 hex of the complete
// token. Only this value is persisted or compared.
func hashMachineToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// createMachineToken mirrors MachineTokenService.create:
// permission normalization and the empty-permission check run first, the
// normalized name is then required to be non-empty (AS4), createdById is
// normalized to SQL NULL for machine/empty actors (AS4), and the row is inserted
// with a generated cuid-compatible id and millisecond timestamps.
func (s *Service) createMachineToken(ctx context.Context, identity *Identity, values createMachineTokenValues) (machineTokenCreateResult, error) {
	permissions := normalizePermissions(values.Permissions)
	if len(permissions) == 0 {
		return machineTokenCreateResult{}, badRequest("At least one supported permission is required")
	}
	name := strings.TrimSpace(values.Name)
	if name == "" {
		return machineTokenCreateResult{}, badRequest("Machine token name cannot be empty")
	}
	if s == nil || s.db == nil {
		return machineTokenCreateResult{}, errNoDatabase
	}

	token, err := newMachineTokenPlaintext()
	if err != nil {
		return machineTokenCreateResult{}, err
	}
	id, err := newRowID()
	if err != nil {
		return machineTokenCreateResult{}, err
	}
	permissionsJSON, err := json.Marshal(permissions)
	if err != nil {
		return machineTokenCreateResult{}, err
	}
	now := nowMillis()
	if _, err := s.db.ExecContext(ctx,
		"INSERT INTO `MachineAccessToken` (`id`, `orgId`, `name`, `tokenHash`, `permissions`, "+
			"`createdById`, `expiresAt`, `lastUsedAt`, `revokedAt`, `createdAt`, `updatedAt`) "+
			"VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)",
		id, identity.OrgID, name, hashMachineToken(token), permissionsJSON,
		nullableActorID(identity.UserID), values.ExpiresAt, now, now); err != nil {
		return machineTokenCreateResult{}, dbWrap(err)
	}

	return machineTokenCreateResult{
		ID:          id,
		Name:        name,
		Token:       token,
		Permissions: permissions,
		ExpiresAt:   formatJSDate(values.ExpiresAt),
	}, nil
}

// listMachineTokens mirrors MachineTokenService.list: the current organization's
// rows, newest first, with `permissions` emitted exactly as stored.
func (s *Service) listMachineTokens(ctx context.Context, orgID string) (machineTokenListResponse, error) {
	if s == nil || s.db == nil {
		return nil, errNoDatabase
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT `id`, `name`, `permissions`, `expiresAt`, `lastUsedAt`, `revokedAt`, `createdAt` "+
			"FROM `MachineAccessToken` WHERE `orgId` = ? ORDER BY `createdAt` DESC", orgID)
	if err != nil {
		return nil, dbWrap(err)
	}
	defer rows.Close()

	items := make(machineTokenListResponse, 0, 8)
	for rows.Next() {
		var item machineTokenListItem
		var permissions []byte
		var expiresAt, lastUsedAt, revokedAt sql.NullTime
		var createdAt time.Time
		if err := rows.Scan(&item.ID, &item.Name, &permissions, &expiresAt, &lastUsedAt, &revokedAt, &createdAt); err != nil {
			return nil, dbWrap(err)
		}
		item.Permissions = json.RawMessage(permissions)
		item.ExpiresAt = formatJSDate(nullableTime(expiresAt))
		item.LastUsedAt = formatJSDate(nullableTime(lastUsedAt))
		item.RevokedAt = formatJSDate(nullableTime(revokedAt))
		item.CreatedAt = formatJSMillis(createdAt)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, dbWrap(err)
	}
	return items, nil
}

// revokeMachineToken mirrors MachineTokenService.revoke: only a row with the same
// id AND organization AND revokedAt IS NULL is revoked, and anything else
// (missing, cross-tenant, already revoked) shares one 400 so other tenants'
// tokens are never disclosed. The row is never deleted and an already-expired
// token can still be revoked.
func (s *Service) revokeMachineToken(ctx context.Context, orgID, tokenID string) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	now := nowMillis()
	result, err := s.db.ExecContext(ctx,
		"UPDATE `MachineAccessToken` SET `revokedAt` = ?, `updatedAt` = ? "+
			"WHERE `id` = ? AND `orgId` = ? AND `revokedAt` IS NULL",
		now, now, tokenID, orgID)
	if err != nil {
		return dbWrap(err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return dbWrap(err)
	}
	if affected != 1 {
		return badRequest("Machine token not found or already revoked")
	}
	return nil
}

// rotateMachineToken mirrors MachineTokenService.rotate with the AS1 fix: the
// conditional revoke and the successor INSERT run in one MySQL transaction. The
// successor keeps the original name, expiry, permissions (re-normalized through
// the create-time whitelist) and createdById — never the current operator, as
// resolvePlatformMetricsAccess authorizes against the original creator.
//
// The SELECT ... FOR UPDATE plus the conditional UPDATE serialize concurrent
// rotates and revokes: at most one successor can be created.
func (s *Service) rotateMachineToken(ctx context.Context, identity *Identity, tokenID string) (machineTokenCreateResult, error) {
	if s == nil || s.db == nil {
		return machineTokenCreateResult{}, errNoDatabase
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return machineTokenCreateResult{}, dbWrap(err)
	}
	defer func() {
		// No-op after a successful commit; every failure path rolls the revoke
		// (and any partial insert) back.
		_ = tx.Rollback()
	}()

	var recordID, recordName string
	var rawPermissions []byte
	var recordCreatedByID *string
	var expiresAt sql.NullTime
	err = tx.QueryRowContext(ctx,
		"SELECT `id`, `name`, `permissions`, `createdById`, `expiresAt` FROM `MachineAccessToken` "+
			"WHERE `id` = ? AND `orgId` = ? AND `revokedAt` IS NULL FOR UPDATE",
		tokenID, identity.OrgID).
		Scan(&recordID, &recordName, &rawPermissions, &recordCreatedByID, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return machineTokenCreateResult{}, badRequest("Machine token not found or already revoked")
	}
	if err != nil {
		return machineTokenCreateResult{}, dbWrap(err)
	}

	// Normalize before revoking: a token whose stored permissions no longer
	// contain any create-time-supported entry must fail with the old row
	// untouched.
	permissions := normalizePermissions(machinePermissionStrings(rawPermissions))
	if len(permissions) == 0 {
		return machineTokenCreateResult{}, badRequest("At least one supported permission is required")
	}
	name := strings.TrimSpace(recordName)
	if name == "" {
		return machineTokenCreateResult{}, badRequest("Machine token name cannot be empty")
	}

	now := nowMillis()
	result, err := tx.ExecContext(ctx,
		"UPDATE `MachineAccessToken` SET `revokedAt` = ?, `updatedAt` = ? "+
			"WHERE `id` = ? AND `orgId` = ? AND `revokedAt` IS NULL",
		now, now, tokenID, identity.OrgID)
	if err != nil {
		return machineTokenCreateResult{}, dbWrap(err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return machineTokenCreateResult{}, dbWrap(err)
	}
	if affected != 1 {
		return machineTokenCreateResult{}, badRequest("Machine token not found or already revoked")
	}

	token, err := newMachineTokenPlaintext()
	if err != nil {
		return machineTokenCreateResult{}, err
	}
	newID, err := newRowID()
	if err != nil {
		return machineTokenCreateResult{}, err
	}
	permissionsJSON, err := json.Marshal(permissions)
	if err != nil {
		return machineTokenCreateResult{}, err
	}
	inheritedCreator := (*string)(nil)
	if recordCreatedByID != nil {
		inheritedCreator = nullableActorID(*recordCreatedByID)
	}
	var expiresValue *time.Time
	if expiresAt.Valid {
		value := expiresAt.Time.UTC().Truncate(time.Millisecond)
		expiresValue = &value
	}
	if _, err := tx.ExecContext(ctx,
		"INSERT INTO `MachineAccessToken` (`id`, `orgId`, `name`, `tokenHash`, `permissions`, "+
			"`createdById`, `expiresAt`, `lastUsedAt`, `revokedAt`, `createdAt`, `updatedAt`) "+
			"VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)",
		newID, identity.OrgID, name, hashMachineToken(token), permissionsJSON,
		inheritedCreator, expiresValue, now, now); err != nil {
		return machineTokenCreateResult{}, dbWrap(err)
	}

	if err := tx.Commit(); err != nil {
		return machineTokenCreateResult{}, dbWrap(err)
	}
	return machineTokenCreateResult{
		ID:          newID,
		Name:        name,
		Token:       token,
		Permissions: permissions,
		ExpiresAt:   formatJSDate(expiresValue),
	}, nil
}
