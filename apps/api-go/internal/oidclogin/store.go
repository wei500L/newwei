package oidclogin

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// mysqlDirectory reads the existing account and organization state. It never
// creates a user, a membership or an organization: an SSO identity is only
// accepted when an operator already provisioned the account.
type mysqlDirectory struct {
	db *sql.DB
}

func newMySQLDirectory(db *sql.DB) *mysqlDirectory {
	return &mysqlDirectory{db: db}
}

// orgSelectColumns is shared by the id and identifier lookups. The LEFT JOIN
// keeps an organization without an OIDC configuration visible so the caller can
// answer the same "not configured" branch as NestJS.
const orgSelectColumns = "o.`id`, c.`enabled`, c.`issuerUrl`, c.`discoveryUrl`, c.`clientId`, " +
	"c.`clientSecret`, c.`scopes`, c.`requireEmailVerified` FROM `Org` o " +
	"LEFT JOIN `OrgOidcConfig` c ON c.`orgId` = o.`id`"

func (d *mysqlDirectory) FindOrgByIdentifier(ctx context.Context, id, slug string) (*orgRecord, error) {
	if d == nil || d.db == nil {
		return nil, errNoDatabase
	}
	return scanOrg(d.db.QueryRowContext(ctx,
		"SELECT "+orgSelectColumns+" WHERE o.`id` = ? OR o.`slug` = ? LIMIT 1",
		id, slug))
}

func (d *mysqlDirectory) FindOrgByID(ctx context.Context, id string) (*orgRecord, error) {
	if d == nil || d.db == nil {
		return nil, errNoDatabase
	}
	return scanOrg(d.db.QueryRowContext(ctx,
		"SELECT "+orgSelectColumns+" WHERE o.`id` = ? LIMIT 1", id))
}

func scanOrg(row *sql.Row) (*orgRecord, error) {
	var (
		orgID           string
		enabled         sql.NullBool
		issuerURL       sql.NullString
		discoveryURL    sql.NullString
		clientID        sql.NullString
		clientSecret    []byte
		scopes          []byte
		requireVerified sql.NullBool
	)
	err := row.Scan(&orgID, &enabled, &issuerURL, &discoveryURL, &clientID, &clientSecret, &scopes, &requireVerified)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, dbWrap(err)
	}
	record := &orgRecord{ID: orgID}
	if !enabled.Valid {
		return record, nil
	}
	// requireEmailVerified defaults to true. A NULL column (or any unreadable
	// value) must not silently disable the check.
	requireEmail := true
	if requireVerified.Valid {
		requireEmail = requireVerified.Bool
	}
	record.OIDC = &orgOIDCConfig{
		OrgID:                orgID,
		Enabled:              enabled.Bool,
		IssuerURL:            issuerURL.String,
		DiscoveryURL:         discoveryURL.String,
		ClientID:             clientID.String,
		ClientSecret:         clientSecret,
		Scopes:               scopes,
		RequireEmailVerified: requireEmail,
	}
	return record, nil
}

func (d *mysqlDirectory) FindUserIDByEmail(ctx context.Context, email string) (string, bool, error) {
	if d == nil || d.db == nil {
		return "", false, errNoDatabase
	}
	var userID string
	err := d.db.QueryRowContext(ctx,
		"SELECT `id` FROM `User` WHERE `email` = ? LIMIT 1", email).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, dbWrap(err)
	}
	return userID, true, nil
}

// mysqlChallengeStore owns the sso_handoff AuthChallenge rows.
type mysqlChallengeStore struct {
	db *sql.DB
}

func newMySQLChallengeStore(db *sql.DB) *mysqlChallengeStore {
	return &mysqlChallengeStore{db: db}
}

func (s *mysqlChallengeStore) CreateHandoff(ctx context.Context, challenge handoffChallenge) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := s.db.ExecContext(ctx,
		"INSERT INTO `AuthChallenge` (`id`, `type`, `userId`, `orgId`, `payload`, `expiresAt`, "+
			"`consumedAt`, `failedAttempts`, `lockedAt`, `createdAt`) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?)",
		challenge.ID, challengeTypeSSOHandoff, challenge.UserID, challenge.OrgID,
		challenge.Payload, challenge.ExpiresAt.UTC(), now); err != nil {
		return dbWrap(err)
	}
	return nil
}

func (s *mysqlChallengeStore) LoadHandoff(ctx context.Context, id string) (handoffChallenge, bool, error) {
	if s == nil || s.db == nil {
		return handoffChallenge{}, false, errNoDatabase
	}
	var (
		challenge  handoffChallenge
		userID     sql.NullString
		orgID      sql.NullString
		consumedAt sql.NullTime
	)
	err := s.db.QueryRowContext(ctx,
		"SELECT `id`, `type`, `userId`, `orgId`, `payload`, `expiresAt`, `consumedAt` "+
			"FROM `AuthChallenge` WHERE `id` = ? LIMIT 1", id).
		Scan(&challenge.ID, &challenge.Type, &userID, &orgID, &challenge.Payload,
			&challenge.ExpiresAt, &consumedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return handoffChallenge{}, false, nil
	}
	if err != nil {
		return handoffChallenge{}, false, dbWrap(err)
	}
	challenge.UserID = nullStringPointer(userID)
	challenge.OrgID = nullStringPointer(orgID)
	challenge.ConsumedAt = nullTimePointer(consumedAt)
	return challenge, true, nil
}

// ClaimHandoff is the concrete fix for the source read-then-unconditional-update
// gap: only one concurrent exchange can turn consumedAt from NULL to a value
// while the row is still unexpired. The expiry boundary keeps the source
// `expiresAt < now` rule: a row expiring exactly now is still claimable.
func (s *mysqlChallengeStore) ClaimHandoff(ctx context.Context, id string, now time.Time) (bool, error) {
	if s == nil || s.db == nil {
		return false, errNoDatabase
	}
	moment := now.UTC().Truncate(time.Millisecond)
	result, err := s.db.ExecContext(ctx,
		"UPDATE `AuthChallenge` SET `consumedAt` = ? WHERE `id` = ? AND `type` = ? "+
			"AND `consumedAt` IS NULL AND `expiresAt` >= ?",
		moment, id, challengeTypeSSOHandoff, moment)
	if err != nil {
		return false, dbWrap(err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, dbWrap(err)
	}
	return affected == 1, nil
}

func nullStringPointer(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func nullTimePointer(value sql.NullTime) *time.Time {
	if !value.Valid {
		return nil
	}
	return &value.Time
}
