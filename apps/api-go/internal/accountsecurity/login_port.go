package accountsecurity

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"
)

// This file is the narrow, exported account-security port the auth-login batch
// (internal/authlogin) reuses. Everything else in this package stays private:
// the login chain needs the same user/membership/role/permission projection, the
// same Node-compatible bcrypt behaviour, the same profile-cache invalidation and
// the same refresh-token revocation list NestJS shares with logout and
// change-password — nothing more.
//
// The port deliberately does NOT change any existing selection semantics. The
// login default-organization rule (an omitted orgId picks the earliest active
// membership) applies only to PickLoginMembership; PickSessionMembership keeps
// the original rule that a user with several active organizations must name one,
// so GET /me and refresh keep behaving exactly as before.

// LoginUser is the login-chain user projection. It carries the profile columns
// the shared loader reads plus passwordHash, which only the credential check
// needs and which must never leave the process.
type LoginUser struct {
	ID            string
	Email         string
	EmailVerified *time.Time
	LastLoginAt   *time.Time
	PendingEmail  *string
	FirstName     string
	LastName      string
	AvatarURL     *string
	IsActive      bool
	PasswordHash  string
}

// LoginMembership is the login-chain membership projection: the organization
// state, the primary role, the plan/subscription labels and the creation order
// the default-organization rule depends on.
type LoginMembership = membershipRow

// LoginProfile is the authenticated-user JSON body. It is an alias of the
// existing profile response, so GET /me, PATCH /profile, the email-change
// response and every login response stay one single shape with one single field
// order.
type LoginProfile = profileResponse

// LoginOrganization is one entry of the organization options a session result
// carries.
type LoginOrganization struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Slug     string `json:"slug"`
	IsActive bool   `json:"isActive"`
}

// LoginStore owns the shared MySQL pool and Redis client for the auth-login
// port. It opens no second connection pool and holds no request state.
type LoginStore struct {
	svc *Service
}

// NewLoginStore wires the login port onto the shared connections. The fields the
// port never reads (S3, settings encryption) stay at their zero values.
func NewLoginStore(db *sql.DB, redisClient *redis.Client) *LoginStore {
	return &LoginStore{svc: NewService(db, redisClient, Config{})}
}

// ---- users and memberships ----

// loginUserColumns is the shared select list for the two lookups below.
const loginUserColumns = "`id`, `email`, `emailVerified`, `lastLoginAt`, `pendingEmail`, " +
	"`firstName`, `lastName`, `avatarUrl`, `isActive`, `passwordHash`"

// UserByEmail loads one user by its already-normalized email address. found is
// false when no row matches; that is not an error, because the password and
// email-code flows answer with the same generic credential failure either way.
func (l *LoginStore) UserByEmail(ctx context.Context, email string) (LoginUser, bool, error) {
	if l == nil || l.svc == nil || l.svc.db == nil {
		return LoginUser{}, false, errNoDatabase
	}
	return l.scanLoginUser(l.svc.db.QueryRowContext(ctx,
		"SELECT "+loginUserColumns+" FROM `User` WHERE `email` = ? LIMIT 1", email))
}

// UserByID loads one user by primary key. The trusted-login step reloads the
// user this way so a status change between credential check and session issue
// is always observed.
func (l *LoginStore) UserByID(ctx context.Context, userID string) (LoginUser, bool, error) {
	if l == nil || l.svc == nil || l.svc.db == nil {
		return LoginUser{}, false, errNoDatabase
	}
	return l.scanLoginUser(l.svc.db.QueryRowContext(ctx,
		"SELECT "+loginUserColumns+" FROM `User` WHERE `id` = ? LIMIT 1", userID))
}

func (l *LoginStore) scanLoginUser(row *sql.Row) (LoginUser, bool, error) {
	var user LoginUser
	var emailVerified, lastLoginAt sql.NullTime
	var pendingEmail, avatarURL sql.NullString
	err := row.Scan(&user.ID, &user.Email, &emailVerified, &lastLoginAt, &pendingEmail,
		&user.FirstName, &user.LastName, &avatarURL, &user.IsActive, &user.PasswordHash)
	if errors.Is(err, sql.ErrNoRows) {
		return LoginUser{}, false, nil
	}
	if err != nil {
		return LoginUser{}, false, dbWrap(err)
	}
	user.EmailVerified = nullableTime(emailVerified)
	user.LastLoginAt = nullableTime(lastLoginAt)
	user.PendingEmail = nullableString(pendingEmail)
	user.AvatarURL = nullableString(avatarURL)
	return user, true, nil
}

// Memberships loads every membership of the user, oldest first, with the state
// the picker and the session response need.
func (l *LoginStore) Memberships(ctx context.Context, userID string) ([]LoginMembership, error) {
	if l == nil || l.svc == nil {
		return nil, errNoDatabase
	}
	return l.svc.listMemberships(ctx, userID)
}

// PickLoginMembership mirrors AuthService.pickMembership with
// `requireExplicitOrg: false`, which is what validateUser, loginWithCode and
// completeTrustedLogin use: a user with several active organizations who did not
// name one is logged into the earliest active membership instead of being asked
// to choose.
//
// The explicit-org branch is delegated to the shared picker, so id/slug matching
// and trimming stay single-sourced.
func PickLoginMembership(memberships []LoginMembership, orgIDOrSlug string) (*LoginMembership, error) {
	if orgIDOrSlug != "" {
		return pickMembership(memberships, orgIDOrSlug)
	}
	if len(memberships) == 0 {
		return nil, unauthorized("User is not assigned to an organization")
	}
	active := make([]*LoginMembership, 0, len(memberships))
	for index := range memberships {
		if membershipAccessible(memberships[index]) {
			active = append(active, &memberships[index])
		}
	}
	if len(memberships) == 1 {
		if len(active) == 1 {
			return active[0], nil
		}
		if err := assertMembershipAccessible(&memberships[0]); err != nil {
			return nil, err
		}
	}
	if len(active) == 1 || len(active) > 1 {
		return active[0], nil
	}
	for index := range memberships {
		if !memberships[index].Active {
			return nil, unauthorized("Organization access disabled")
		}
	}
	return nil, unauthorized("Organization disabled")
}

// PickSessionMembership is the original pickMembership behaviour
// (`requireExplicitOrg: true`). Refresh keeps it: a refresh token whose
// organization cannot be resolved must fail with the multi-organization 400
// rather than silently moving the session to another tenant.
func PickSessionMembership(memberships []LoginMembership, orgIDOrSlug string) (*LoginMembership, error) {
	return pickMembership(memberships, orgIDOrSlug)
}

// AssertLoginMembershipAccessible reports the disabled organization before the
// disabled membership, exactly like the shared assertion.
func AssertLoginMembershipAccessible(membership *LoginMembership) error {
	return assertMembershipAccessible(membership)
}

// Organizations mirrors OrgService.listOrganizationOptionsForUser: memberships
// oldest first, de-duplicated by organization (first position wins, matching the
// insertion order of a JavaScript Map), with isActive combining the organization
// and the membership state so a suspended membership still shows its
// organization as inactive.
func (l *LoginStore) Organizations(ctx context.Context, userID string) ([]LoginOrganization, error) {
	if l == nil || l.svc == nil || l.svc.db == nil {
		return nil, errNoDatabase
	}
	rows, err := l.svc.db.QueryContext(ctx,
		"SELECT `m`.`orgId`, `o`.`id`, `o`.`name`, `o`.`slug`, `o`.`isActive`, `m`.`isActive` "+
			"FROM `Membership` `m` JOIN `Org` `o` ON `o`.`id` = `m`.`orgId` "+
			"WHERE `m`.`userId` = ? ORDER BY `m`.`createdAt` ASC", userID)
	if err != nil {
		return nil, dbWrap(err)
	}
	defer rows.Close()

	organizations := make([]LoginOrganization, 0, 4)
	index := make(map[string]int, 4)
	for rows.Next() {
		var orgID string
		var option LoginOrganization
		var orgActive, membershipActive bool
		if err := rows.Scan(&orgID, &option.ID, &option.Name, &option.Slug, &orgActive, &membershipActive); err != nil {
			return nil, dbWrap(err)
		}
		option.IsActive = orgActive && membershipActive
		if position, seen := index[orgID]; seen {
			organizations[position] = option
			continue
		}
		index[orgID] = len(organizations)
		organizations = append(organizations, option)
	}
	if err := rows.Err(); err != nil {
		return nil, dbWrap(err)
	}
	return organizations, nil
}

// Profile renders the authenticated-user body for an already-selected
// membership. It re-derives roles and permissions from MySQL, adds the global
// roles, reads the MFA factor state and never trusts a request or a token claim.
// The membership is supplied by the caller so the same assembly also serves the
// `requireExplicitOrg: false` login rule.
func (l *LoginStore) Profile(ctx context.Context, user LoginUser, membership *LoginMembership) (LoginProfile, error) {
	if l == nil || l.svc == nil {
		return LoginProfile{}, errNoDatabase
	}
	claims, err := l.svc.buildMembershipClaims(ctx, membership)
	if err != nil {
		return LoginProfile{}, err
	}
	globalRoles, err := l.svc.globalRoles(ctx, user.ID)
	if err != nil {
		return LoginProfile{}, err
	}
	mfaEnabled, err := l.svc.mfaEnabled(ctx, user.ID)
	if err != nil {
		return LoginProfile{}, err
	}
	return LoginProfile{
		ID:                    user.ID,
		Email:                 user.Email,
		EmailVerified:         formatJSDate(user.EmailVerified),
		LastLoginAt:           formatJSDate(user.LastLoginAt),
		PendingEmail:          user.PendingEmail,
		FirstName:             user.FirstName,
		LastName:              user.LastName,
		AvatarURL:             user.AvatarURL,
		IsActive:              user.IsActive && membership.Active,
		OrgID:                 membership.OrgID,
		PrimaryRoleID:         claims.PrimaryRoleID,
		RoleIDs:               claims.RoleIDs,
		Permissions:           claims.Permissions,
		PlanTier:              membership.PlanTier,
		SubscriptionStatus:    membership.SubscriptionStatus,
		GlobalRoles:           globalRoles,
		MFAEnabled:            mfaEnabled,
		MFARequired:           false,
		MFAEnrollmentRequired: false,
	}, nil
}

// OrgAdmin mirrors MfaService.isOrgAdmin: the organization's admin check looks
// at the caller's role names inside that organization only (primary role plus
// every MembershipRole link), never at a platform-wide global role.
func (l *LoginStore) OrgAdmin(ctx context.Context, userID, orgID string) (bool, error) {
	if l == nil || l.svc == nil || l.svc.db == nil {
		return false, errNoDatabase
	}
	var membershipID string
	var primaryRole sql.NullString
	err := l.svc.db.QueryRowContext(ctx,
		"SELECT `m`.`id`, `r`.`name` FROM `Membership` `m` "+
			"LEFT JOIN `Role` `r` ON `r`.`id` = `m`.`roleId` "+
			"WHERE `m`.`userId` = ? AND `m`.`orgId` = ? LIMIT 1", userID, orgID).
		Scan(&membershipID, &primaryRole)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, dbWrap(err)
	}
	if primaryRole.Valid && strings.EqualFold(strings.TrimSpace(primaryRole.String), "admin") {
		return true, nil
	}

	rows, err := l.svc.db.QueryContext(ctx,
		"SELECT `r`.`name` FROM `MembershipRole` `mr` JOIN `Role` `r` ON `r`.`id` = `mr`.`roleId` "+
			"WHERE `mr`.`membershipId` = ?", membershipID)
	if err != nil {
		return false, dbWrap(err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return false, dbWrap(err)
		}
		if strings.EqualFold(strings.TrimSpace(name), "admin") {
			return true, nil
		}
	}
	if err := rows.Err(); err != nil {
		return false, dbWrap(err)
	}
	return false, nil
}

// InvalidateProfileCache drops the cached authenticated profile for this user in
// every organization they belong to. The email change and the forced enrollment
// both change fields the cached profile carries (`email`, `mfaEnabled`), so
// leaving the other organizations' entries in place would keep serving a stale
// body until the TTL expires.
func (l *LoginStore) InvalidateProfileCache(ctx context.Context, userID, orgID string) error {
	if l == nil || l.svc == nil {
		return errNoDatabase
	}
	return l.svc.invalidateProfileCache(ctx, userID, orgID)
}

// ---- shared revocation list ----

// AddRefreshBlacklist revokes a rotated refresh token for the remainder of its
// original lifetime, using the same key and value shape logout and
// change-password already write.
func (l *LoginStore) AddRefreshBlacklist(ctx context.Context, tokenID string, ttlSeconds int) error {
	if l == nil || l.svc == nil {
		return errNoRedis
	}
	if tokenID == "" || ttlSeconds <= 0 {
		return nil
	}
	key := "refresh-token:blacklist:" + tokenID
	return l.svc.blacklistSet(ctx, key, ttlSeconds)
}

// RefreshBlacklisted reports whether a refresh token id was revoked. A malformed
// cache value is an error rather than "not revoked": NestJS parses the value with
// JSON.parse, which throws and surfaces as a 500, so a corrupt entry must never
// open the revoked-token path.
func (l *LoginStore) RefreshBlacklisted(ctx context.Context, tokenID string) (bool, error) {
	if l == nil || l.svc == nil || l.svc.redis == nil {
		return false, errNoRedis
	}
	if tokenID == "" {
		return false, nil
	}
	value, err := l.svc.redis.Get(ctx, "refresh-token:blacklist:"+tokenID).Result()
	if errors.Is(err, redis.Nil) {
		return false, nil
	}
	if err != nil {
		return false, redisWrap(err)
	}
	return jsTruthyText(value)
}

// AddAccessBlacklist revokes the current access token by its jti for the
// remainder of its lifetime. The auth-login batch only needs this to keep a
// password reset consistent with the two revocation paths it already owns; the
// key is shared with authn and NestJS.
func (l *LoginStore) AddAccessBlacklist(ctx context.Context, jti string, ttlSeconds int) error {
	if l == nil || l.svc == nil {
		return errNoRedis
	}
	if jti == "" || ttlSeconds <= 0 {
		return nil
	}
	return l.svc.blacklistSet(ctx, "access-token:blacklist:"+jti, ttlSeconds)
}

// jsTruthyText reproduces Boolean(JSON.parse(value)): false/null/0/""/[] are
// false, every other JSON value is true. Invalid JSON is an error, matching the
// NestJS parse failure.
func jsTruthyText(value string) (bool, error) {
	var parsed any
	if err := json.Unmarshal([]byte(value), &parsed); err != nil {
		return false, err
	}
	switch typed := parsed.(type) {
	case bool:
		return typed, nil
	case nil:
		return false, nil
	case string:
		return typed != "", nil
	case float64:
		return typed != 0, nil
	case []any:
		return len(typed) > 0, nil
	case map[string]any:
		return len(typed) > 0, nil
	default:
		return true, nil
	}
}

// ---- shared credential primitives ----

// CompareLoginPassword verifies a password against a stored hash with the exact
// byte handling Node bcrypt@5.1.1 applies, so a password longer than 72 bytes
// (or one containing a NUL byte) authenticates exactly as it does in NestJS.
func CompareLoginPassword(storedHash, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(storedHash), nodeBcryptPassword(password)) == nil
}

// HashLoginPassword produces the cost-10 hash NestJS writes.
func HashLoginPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword(nodeBcryptPassword(password), bcryptCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

// IsUniqueConstraint reports a MySQL 1062 duplicate-entry error, which is what a
// concurrent insert into a unique column produces (Prisma reports it as P2002).
func IsUniqueConstraint(err error) bool {
	var mysqlErr *mysql.MySQLError
	return errors.As(err, &mysqlErr) && mysqlErr.Number == 1062
}
