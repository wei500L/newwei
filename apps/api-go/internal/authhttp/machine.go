package authhttp

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"time"
)

// ErrInvalidMachineToken marks an mtk_ token that is absent, revoked, expired or
// owned by an inactive organization. Callers map it to the contract 401
// "Invalid machine token"; any other error is a database failure.
var ErrInvalidMachineToken = errors.New("invalid machine token")

// machineActorPrefix reproduces MachineTokenService.validate's identity shape.
// Machine actors project to NULL in audit columns (see NullableActorID).
const machineActorPrefix = "machine:"

// machineTokenSQL is the minimal lookup shared by every machine-token caller. It
// selects only the columns every caller and test schema carries, joining the
// owning Org so state is read in one statement. Callers that need extra profile
// columns use LookupProfile / LookupCreatedBy instead.
const machineTokenSQL = "SELECT `t`.`id`, `t`.`orgId`, `t`.`permissions`, " +
	"`t`.`expiresAt`, `t`.`revokedAt`, `o`.`isActive` " +
	"FROM `MachineAccessToken` `t` JOIN `Org` `o` ON `o`.`id` = `t`.`orgId` " +
	"WHERE `t`.`tokenHash` = ?"

// machineTokenProfileSQL additionally reads the account-security profile columns
// (name / createdBy / planTier / subscriptionStatus).
const machineTokenProfileSQL = "SELECT `t`.`id`, `t`.`orgId`, `t`.`name`, `t`.`permissions`, " +
	"`t`.`createdById`, `t`.`expiresAt`, `t`.`revokedAt`, `o`.`isActive`, " +
	"`o`.`planTier`, `o`.`subscriptionStatus` " +
	"FROM `MachineAccessToken` `t` JOIN `Org` `o` ON `o`.`id` = `t`.`orgId` " +
	"WHERE `t`.`tokenHash` = ?"

// machineTokenCreatedBySQL reads only the columns the metrics platform-admin
// decision needs (creator id plus validity state).
const machineTokenCreatedBySQL = "SELECT `t`.`createdById`, `t`.`expiresAt`, `t`.`revokedAt`, `o`.`isActive` " +
	"FROM `MachineAccessToken` `t` JOIN `Org` `o` ON `o`.`id` = `t`.`orgId` " +
	"WHERE `t`.`tokenHash` = ?"

// MachineToken is the resolved MachineAccessToken row joined with its Org.
// PermissionsRaw is the stored JSON document; use ParseMachinePermissions to
// turn it into the string list. Profile/creator fields are zero unless the
// caller used LookupProfile / LookupCreatedBy.
type MachineToken struct {
	ID                 string
	OrgID              string
	Name               string
	PermissionsRaw     []byte
	CreatedByID        string
	ExpiresAt          *time.Time
	RevokedAt          *time.Time
	OrgActive          bool
	PlanTier           *string
	SubscriptionStatus *string
}

// MachineResolver is the single implementation of mtk_ machine-token
// authentication. It is constructed once (in cmd/api) and shared by every unit
// that accepts machine tokens. now is injectable for boundary tests.
type MachineResolver struct {
	db  *sql.DB
	now func() time.Time
}

// NewMachineResolver builds the resolver over the shared MySQL pool.
func NewMachineResolver(db *sql.DB, now func() time.Time) *MachineResolver {
	if now == nil {
		now = time.Now
	}
	return &MachineResolver{db: db, now: now}
}

// LookupHash reads the minimal token row by its SHA-256 hex hash without
// applying the validity predicate or touching lastUsedAt. found is false when no
// row matches. It backs the health probe and the generic Resolve path.
func (m *MachineResolver) LookupHash(ctx context.Context, tokenHash string) (MachineToken, bool, error) {
	if m == nil || m.db == nil {
		return MachineToken{}, false, errors.New("machine token resolver has no database")
	}
	var token MachineToken
	var expires, revoked sql.NullTime
	var active int
	err := m.db.QueryRowContext(ctx, machineTokenSQL, tokenHash).Scan(
		&token.ID, &token.OrgID, &token.PermissionsRaw, &expires, &revoked, &active)
	if errors.Is(err, sql.ErrNoRows) {
		return MachineToken{}, false, nil
	}
	if err != nil {
		return MachineToken{}, false, err
	}
	token.OrgActive = active != 0
	token.ExpiresAt = nullTimePtr(expires)
	token.RevokedAt = nullTimePtr(revoked)
	return token, true, nil
}

// Lookup hashes raw and returns the validated minimal row. ErrInvalidMachineToken
// means absent, revoked, expired (expiresAt <= now) or inactive-org. Any other
// error is a database failure. It does not touch lastUsedAt.
func (m *MachineResolver) Lookup(ctx context.Context, raw string) (MachineToken, error) {
	token, found, err := m.LookupHash(ctx, machineTokenHash(raw))
	if err != nil {
		return MachineToken{}, err
	}
	if !found || m.invalid(token) {
		return MachineToken{}, ErrInvalidMachineToken
	}
	return token, nil
}

// LookupCreatedBy returns the metrics platform-admin decision inputs for raw.
// found is false when no row matches; no validity predicate is applied.
func (m *MachineResolver) LookupCreatedBy(ctx context.Context, raw string) (MachineToken, bool, error) {
	if m == nil || m.db == nil {
		return MachineToken{}, false, errors.New("machine token resolver has no database")
	}
	var token MachineToken
	var createdBy sql.NullString
	var expires, revoked sql.NullTime
	var active int
	err := m.db.QueryRowContext(ctx, machineTokenCreatedBySQL, machineTokenHash(raw)).Scan(
		&createdBy, &expires, &revoked, &active)
	if errors.Is(err, sql.ErrNoRows) {
		return MachineToken{}, false, nil
	}
	if err != nil {
		return MachineToken{}, false, err
	}
	token.CreatedByID = createdBy.String
	token.ExpiresAt = nullTimePtr(expires)
	token.RevokedAt = nullTimePtr(revoked)
	token.OrgActive = active != 0
	return token, true, nil
}

// LookupProfile returns the validated account-security profile row for raw: it
// reads the extra name/createdBy/planTier/subscriptionStatus columns on top of
// the shared validity predicate.
func (m *MachineResolver) LookupProfile(ctx context.Context, raw string) (MachineToken, error) {
	if m == nil || m.db == nil {
		return MachineToken{}, errors.New("machine token resolver has no database")
	}
	var token MachineToken
	var createdBy, planTier, subscriptionStatus sql.NullString
	var expires, revoked sql.NullTime
	var active int
	err := m.db.QueryRowContext(ctx, machineTokenProfileSQL, machineTokenHash(raw)).Scan(
		&token.ID, &token.OrgID, &token.Name, &token.PermissionsRaw, &createdBy,
		&expires, &revoked, &active, &planTier, &subscriptionStatus)
	if errors.Is(err, sql.ErrNoRows) {
		return MachineToken{}, ErrInvalidMachineToken
	}
	if err != nil {
		return MachineToken{}, err
	}
	token.OrgActive = active != 0
	token.CreatedByID = createdBy.String
	token.ExpiresAt = nullTimePtr(expires)
	token.RevokedAt = nullTimePtr(revoked)
	token.PlanTier = nullStringPtr(planTier)
	token.SubscriptionStatus = nullStringPtr(subscriptionStatus)
	if m.invalid(token) {
		return MachineToken{}, ErrInvalidMachineToken
	}
	return token, nil
}

// Resolve returns the machine Identity ("machine:<id>") with the token row's
// orgId and permissions, refreshing lastUsedAt best-effort.
func (m *MachineResolver) Resolve(ctx context.Context, raw string) (*Identity, error) {
	token, err := m.Lookup(ctx, raw)
	if err != nil {
		return nil, err
	}
	m.Touch(ctx, token.ID)
	return NewIdentity(machineActorPrefix+token.ID, token.OrgID, ParseMachinePermissions(token.PermissionsRaw)), nil
}

// Touch refreshes lastUsedAt best-effort: a failed bookkeeping update must never
// reject an otherwise valid token (NestJS `.catch(() => undefined)`).
func (m *MachineResolver) Touch(ctx context.Context, id string) {
	if m == nil || m.db == nil {
		return
	}
	if _, err := m.db.ExecContext(ctx,
		"UPDATE `MachineAccessToken` SET `lastUsedAt` = ? WHERE `id` = ?",
		m.now().UTC().Truncate(time.Millisecond), id); err != nil {
		log.Printf("authhttp: machine token lastUsedAt update failed: %v", err)
	}
}

// invalid applies the shared validity predicate: revoked, inactive organization,
// or expired (equal to now counts as expired).
func (m *MachineResolver) invalid(token MachineToken) bool {
	return token.RevokedAt != nil || !token.OrgActive ||
		(token.ExpiresAt != nil && !token.ExpiresAt.After(m.now()))
}

// ParseMachinePermissions keeps only the string entries of the stored
// permissions JSON array. A non-array document, or any non-string entry, grants
// nothing — it never becomes a wildcard.
func ParseMachinePermissions(raw []byte) []string {
	if len(raw) == 0 {
		return nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		var text string
		if err := json.Unmarshal(entry, &text); err == nil {
			out = append(out, text)
		}
	}
	return out
}

func machineTokenHash(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func nullTimePtr(value sql.NullTime) *time.Time {
	if !value.Valid {
		return nil
	}
	at := value.Time
	return &at
}

func nullStringPtr(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	text := value.String
	return &text
}
