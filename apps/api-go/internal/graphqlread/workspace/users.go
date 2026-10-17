package workspace

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// loginActionToMethod maps an AuditLog action to the GraphQL method value,
// matching LOGIN_ACTION_TO_METHOD in NestJS.
var loginActionToMethod = map[string]string{
	"login":           "password",
	"login_with_code": "email_code",
	"login_with_mfa":  "mfa_totp",
	"login_with_oidc": "oidc",
}

// loginActionOrder is the audit-action list in the same order as the NestJS
// object literal keys.
var loginActionOrder = []string{"login", "login_with_code", "login_with_mfa", "login_with_oidc"}

// userRow is one User row read for the identity roots.
type userRow struct {
	ID            string
	Email         string
	FirstName     sql.NullString
	LastName      sql.NullString
	AvatarURL     sql.NullString
	IsActive      sql.NullBool
	EmailVerified sql.NullTime
	LastLoginAt   sql.NullTime
	CreatedAt     sql.NullTime
}

// orgRow is one Org row with the subscription fields the me root exposes.
type orgRow struct {
	ID                 string
	Name               string
	Slug               string
	Description        sql.NullString
	PlanTier           sql.NullString
	SubscriptionStatus sql.NullString
	IsActive           bool
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

// me implements the me root. It derives the caller's profile from the active
// organization exactly like AuthService.getUserProfile: the membership is
// picked by id or slug, disabled organizations and memberships are rejected
// with the same 401 messages, and planTier/subscriptionStatus come from the
// organization.
func (s *service) me(ctx contract.Context) (*UserModel, error) {
	userID := ctx.Identity.UserID
	if userID == "" {
		return nil, &contract.Failure{Message: "Unauthenticated", Status: http.StatusForbidden}
	}
	callCtx := s.call(ctx)
	memberships, orgs, err := s.loadMembershipsWithOrgs(callCtx, userID)
	if err != nil {
		return nil, err
	}
	if len(memberships) == 0 {
		return nil, &contract.Failure{Message: "User is not assigned to an organization", Status: http.StatusUnauthorized}
	}
	chosen, ok := pickMembership(memberships, orgs, ctx.Identity.OrgID)
	if !ok {
		return nil, &contract.Failure{Message: "User is not assigned to the specified organization", Status: http.StatusUnauthorized}
	}
	org := orgs[chosen.OrgID]
	if !org.IsActive {
		return nil, &contract.Failure{Message: "Organization disabled", Status: http.StatusUnauthorized}
	}
	if !chosen.IsActive {
		return nil, &contract.Failure{Message: "Organization access disabled", Status: http.StatusUnauthorized}
	}
	user, err := s.loadUser(callCtx, userID)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, &contract.Failure{Message: "Invalid access token", Status: http.StatusUnauthorized}
	}

	bundle, err := s.enrichBundle(callCtx, chosen.OrgID, &chosen)
	if err != nil {
		return nil, err
	}
	if bundle == nil {
		return nil, internalFailure()
	}
	return userModelFromBundle(*user, bundle, org), nil
}

// users implements the users root. It requires the caller to be an
// organization administrator and applies the keyset cursor on (createdAt, id)
// descending. A cursor that does not resolve to a member of the organization
// returns an empty list instead of a Prisma P2025.
func (s *service) users(ctx contract.Context) ([]UserModel, error) {
	if err := s.assertActorIsOrgAdmin(s.call(ctx), ctx.Identity.OrgID, ctx.Identity.UserID); err != nil {
		return nil, err
	}
	first := 20
	if value, ok := contract.IntArg(ctx.Args, "first"); ok {
		first = value
	}
	take := first
	if take < 1 {
		take = 1
	}
	if take > 200 {
		take = 200
	}
	afterRaw, _ := contract.StringArg(ctx.Args, "after")
	cursorID, cursorValid := decodeUserCursor(afterRaw)
	if !cursorValid {
		return []UserModel{}, nil
	}
	search, _ := contract.StringArg(ctx.Args, "search")
	search = jsTrim(search)

	callCtx := s.call(ctx)
	var cursor *userCursor
	if cursorID != "" {
		located, err := s.locateCursorUser(callCtx, ctx.Identity.OrgID, cursorID)
		if err != nil {
			return nil, err
		}
		// A deleted, cross-organization, or unknown cursor means the page is
		// empty; NestJS would otherwise surface an uncaught Prisma P2025.
		if located == nil {
			return []UserModel{}, nil
		}
		cursor = located
	}

	rows, err := s.listUserRows(callCtx, ctx.Identity.OrgID, take, cursor, search)
	if err != nil {
		return nil, err
	}
	userIDs := make([]string, 0, len(rows))
	for _, row := range rows {
		userIDs = append(userIDs, row.ID)
	}
	memberships, err := s.loadMembershipsForUsers(callCtx, ctx.Identity.OrgID, userIDs)
	if err != nil {
		return nil, err
	}
	bundles, err := s.enrichBundles(callCtx, ctx.Identity.OrgID, memberships)
	if err != nil {
		return nil, err
	}
	byUser := make(map[string]*membershipBundle, len(memberships))
	for _, membership := range memberships {
		if bundle, ok := bundles[membership.ID]; ok {
			byUser[membership.UserID] = bundle
		}
	}
	out := make([]UserModel, 0, len(rows))
	for _, row := range rows {
		out = append(out, userModelFromListRow(row, byUser[row.ID], ctx.Identity.OrgID))
	}
	return out, nil
}

// userLoginRecords implements the userLoginRecords root. It requires the
// caller to be an organization administrator, rejects targets outside the
// organization with 404 and system administrators with 403, and maps stored
// audit actions onto the GraphQL method values.
func (s *service) userLoginRecords(ctx contract.Context) ([]UserLoginRecordModel, error) {
	if err := s.assertActorIsOrgAdmin(s.call(ctx), ctx.Identity.OrgID, ctx.Identity.UserID); err != nil {
		return nil, err
	}
	userID, ok := contract.StringArg(ctx.Args, "userId")
	if !ok {
		return nil, &contract.Failure{Message: "userId is required", Status: http.StatusBadRequest}
	}
	target, err := s.loadMembershipForUserInOrg(s.call(ctx), ctx.Identity.OrgID, userID)
	if err != nil {
		return nil, err
	}
	if target == nil {
		return nil, &contract.Failure{Message: "User is not a member of the organization", Status: http.StatusNotFound}
	}
	bundle, err := s.enrichBundle(s.call(ctx), ctx.Identity.OrgID, target)
	if err != nil {
		return nil, err
	}
	if bundle != nil && bundle.isSystemAdmin() {
		return nil, &contract.Failure{Message: "System administrators cannot be managed", Status: http.StatusForbidden}
	}
	limit := 20
	if value, ok := contract.IntArg(ctx.Args, "limit"); ok {
		limit = value
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}
	return s.listLoginRecords(s.call(ctx), ctx.Identity.OrgID, userID, limit)
}

// assertActorIsOrgAdmin mirrors UserAdminService.assertActorIsOrgAdmin: the
// actor must be a member of the organization and hold a role with
// isSystem = true and name "admin".
func (s *service) assertActorIsOrgAdmin(ctx context.Context, orgID, actorID string) error {
	membership, err := s.loadMembershipForUserInOrg(ctx, orgID, actorID)
	if err != nil {
		return err
	}
	if membership == nil {
		return &contract.Failure{Message: "Actor is not a member of the organization", Status: http.StatusForbidden}
	}
	bundle, err := s.enrichBundle(ctx, orgID, membership)
	if err != nil {
		return err
	}
	if bundle == nil || !bundle.isSystemAdmin() {
		return &contract.Failure{Message: "Admin access required", Status: http.StatusForbidden}
	}
	return nil
}

// userCursor is the decoded (createdAt, id) position of an after cursor.
type userCursor struct {
	CreatedAt time.Time
	ID        string
}

// decodeUserCursor decodes the base64 cursor into a User.id. The second
// return value is false only when the base64 payload cannot be decoded at
// all, which must yield an empty page rather than the first page.
func decodeUserCursor(raw string) (string, bool) {
	if jsTrim(raw) == "" {
		return "", true
	}
	data, err := base64.StdEncoding.DecodeString(jsTrim(raw))
	if err != nil {
		return "", false
	}
	return jsTrim(string(data)), true
}

// locateCursorUser resolves the cursor id to a (createdAt, id) pair, but only
// when the user is a member of the organization.
func (s *service) locateCursorUser(ctx context.Context, orgID, userID string) (*userCursor, error) {
	if s == nil || s.db == nil {
		return nil, errDatabaseUnavailable
	}
	var cursor userCursor
	err := s.db.QueryRowContext(ctx,
		"SELECT u.createdAt, u.id FROM User u JOIN Membership m ON m.userId = u.id "+
			"WHERE m.orgId = ? AND u.id = ? LIMIT 1", orgID, userID).Scan(&cursor.CreatedAt, &cursor.ID)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &cursor, nil
}

// listUserRows runs the keyset page query. The WHERE clause order matches
// Prisma: organization membership, optional search, optional cursor, then
// createdAt DESC, id DESC. Each argument combination is passed explicitly so
// the query arguments stay strongly typed.
func (s *service) listUserRows(ctx context.Context, orgID string, take int, cursor *userCursor, search string) ([]userRow, error) {
	if s == nil || s.db == nil {
		return nil, errDatabaseUnavailable
	}
	query := "SELECT u.id, u.email, u.firstName, u.lastName, u.avatarUrl, u.isActive, u.emailVerified, u.lastLoginAt, u.createdAt " +
		"FROM User u JOIN Membership m ON m.userId = u.id WHERE m.orgId = ?"
	pattern := "%" + search + "%"
	switch {
	case search != "" && cursor != nil:
		query += " AND (u.firstName LIKE ? OR u.lastName LIKE ? OR u.email LIKE ?)" +
			" AND (u.createdAt < ? OR (u.createdAt = ? AND u.id < ?)) ORDER BY u.createdAt DESC, u.id DESC LIMIT ?"
		return s.scanUserRows(s.db.QueryContext(ctx, query, orgID, pattern, pattern, pattern, cursor.CreatedAt, cursor.CreatedAt, cursor.ID, take))
	case search != "":
		query += " AND (u.firstName LIKE ? OR u.lastName LIKE ? OR u.email LIKE ?)" +
			" ORDER BY u.createdAt DESC, u.id DESC LIMIT ?"
		return s.scanUserRows(s.db.QueryContext(ctx, query, orgID, pattern, pattern, pattern, take))
	case cursor != nil:
		query += " AND (u.createdAt < ? OR (u.createdAt = ? AND u.id < ?))" +
			" ORDER BY u.createdAt DESC, u.id DESC LIMIT ?"
		return s.scanUserRows(s.db.QueryContext(ctx, query, orgID, cursor.CreatedAt, cursor.CreatedAt, cursor.ID, take))
	default:
		query += " ORDER BY u.createdAt DESC, u.id DESC LIMIT ?"
		return s.scanUserRows(s.db.QueryContext(ctx, query, orgID, take))
	}
}

// scanUserRows consumes a user page query, including its error.
func (s *service) scanUserRows(rows *sql.Rows, err error) ([]userRow, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]userRow, 0)
	for rows.Next() {
		var row userRow
		if scanErr := rows.Scan(&row.ID, &row.Email, &row.FirstName, &row.LastName, &row.AvatarURL,
			&row.IsActive, &row.EmailVerified, &row.LastLoginAt, &row.CreatedAt); scanErr != nil {
			return nil, scanErr
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// loadUser loads one user row by id.
func (s *service) loadUser(ctx context.Context, userID string) (*userRow, error) {
	if s == nil || s.db == nil {
		return nil, errDatabaseUnavailable
	}
	var row userRow
	err := s.db.QueryRowContext(ctx,
		"SELECT id, email, firstName, lastName, avatarUrl, isActive, emailVerified, lastLoginAt, createdAt "+
			"FROM User WHERE id = ? LIMIT 1", userID).
		Scan(&row.ID, &row.Email, &row.FirstName, &row.LastName, &row.AvatarURL,
			&row.IsActive, &row.EmailVerified, &row.LastLoginAt, &row.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// loadMembershipsWithOrgs loads every membership of a user together with its
// organization row, keyed by organization id.
func (s *service) loadMembershipsWithOrgs(ctx context.Context, userID string) ([]membershipRow, map[string]orgRow, error) {
	if s == nil || s.db == nil {
		return nil, nil, errDatabaseUnavailable
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT m.id, m.userId, m.orgId, m.roleId, m.isActive, o.id, o.name, o.slug, o.description, "+
			"o.planTier, o.subscriptionStatus, o.isActive, o.createdAt, o.updatedAt "+
			"FROM Membership m JOIN Org o ON o.id = m.orgId WHERE m.userId = ? ORDER BY m.createdAt ASC", userID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	memberships := make([]membershipRow, 0)
	orgs := make(map[string]orgRow)
	for rows.Next() {
		var membership membershipRow
		var org orgRow
		if scanErr := rows.Scan(&membership.ID, &membership.UserID, &membership.OrgID, &membership.RoleID, &membership.IsActive,
			&org.ID, &org.Name, &org.Slug, &org.Description, &org.PlanTier, &org.SubscriptionStatus,
			&org.IsActive, &org.CreatedAt, &org.UpdatedAt); scanErr != nil {
			return nil, nil, scanErr
		}
		memberships = append(memberships, membership)
		orgs[org.ID] = org
	}
	return memberships, orgs, rows.Err()
}

// pickMembership mirrors AuthService.pickMembership when an explicit
// organization is supplied: id match first, then case-insensitive id or slug.
func pickMembership(memberships []membershipRow, orgs map[string]orgRow, orgIDOrSlug string) (membershipRow, bool) {
	normalized := jsTrim(orgIDOrSlug)
	lower := strings.ToLower(normalized)
	for _, membership := range memberships {
		if membership.OrgID == normalized {
			return membership, true
		}
		if strings.ToLower(membership.OrgID) == lower {
			return membership, true
		}
	}
	for _, membership := range memberships {
		org := orgs[membership.OrgID]
		if strings.ToLower(org.Slug) == lower && lower != "" {
			return membership, true
		}
	}
	return membershipRow{}, false
}

// userModelFromBundle builds the me projection, including the organization
// plan fields and the effective active flag.
func userModelFromBundle(user userRow, bundle *membershipBundle, org orgRow) *UserModel {
	model := UserModel{
		AvatarURL:          nullStringPtr(user.AvatarURL),
		Email:              user.Email,
		EmailVerified:      nullTimePtr(user.EmailVerified),
		FirstName:          user.FirstName.String,
		ID:                 user.ID,
		IsActive:           boolDefault(user.IsActive, true) && bundle.membership.IsActive,
		LastLoginAt:        nullTimePtr(user.LastLoginAt),
		LastName:           user.LastName.String,
		OrgID:              bundle.membership.OrgID,
		Permissions:        []string{},
		PlanTier:           nullStringPtr(org.PlanTier),
		RoleIDs:            []string{},
		SubscriptionStatus: nullStringPtr(org.SubscriptionStatus),
	}
	if bundle.membership.RoleID != "" {
		model.PrimaryRoleID = stringPtr(bundle.membership.RoleID)
	}
	if roleIDs := bundle.effectiveRoleIDs(); len(roleIDs) > 0 {
		model.RoleIDs = roleIDs
	}
	if permissions := bundle.permissionNames(); len(permissions) > 0 {
		model.Permissions = permissions
	}
	return &model
}

// userModelFromListRow builds the users projection. Plan fields stay null and
// isActive follows resolveEffectiveUserActive.
func userModelFromListRow(user userRow, bundle *membershipBundle, orgID string) UserModel {
	model := UserModel{
		AvatarURL:     nullStringPtr(user.AvatarURL),
		Email:         user.Email,
		EmailVerified: nullTimePtr(user.EmailVerified),
		FirstName:     user.FirstName.String,
		ID:            user.ID,
		LastLoginAt:   nullTimePtr(user.LastLoginAt),
		LastName:      user.LastName.String,
		OrgID:         orgID,
		Permissions:   []string{},
		RoleIDs:       []string{},
	}
	membershipActive := true
	if bundle != nil {
		model.OrgID = bundle.membership.OrgID
		if bundle.membership.RoleID != "" {
			model.PrimaryRoleID = stringPtr(bundle.membership.RoleID)
		}
		if roleIDs := bundle.effectiveRoleIDs(); len(roleIDs) > 0 {
			model.RoleIDs = roleIDs
		}
		if permissions := bundle.permissionNames(); len(permissions) > 0 {
			model.Permissions = permissions
		}
		membershipActive = bundle.membership.IsActive
	}
	model.IsActive = boolDefault(user.IsActive, true) && membershipActive
	return model
}

// listLoginRecords loads the recent login audit rows and maps them onto the
// GraphQL record object.
func (s *service) listLoginRecords(ctx context.Context, orgID, userID string, limit int) ([]UserLoginRecordModel, error) {
	if s == nil || s.db == nil {
		return nil, errDatabaseUnavailable
	}
	query := "SELECT id, createdAt, ipAddress, metadata, action FROM AuditLog " +
		"WHERE orgId = ? AND actorId = ? AND resource = 'auth' AND action IN (" + sqlStringList(loginActionOrder) + ") " +
		"ORDER BY createdAt DESC LIMIT ?"
	rows, err := s.db.QueryContext(ctx, query, orgID, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]UserLoginRecordModel, 0, limit)
	for rows.Next() {
		var id, action string
		var createdAt time.Time
		var ipAddress sql.NullString
		var metadata []byte
		if err := rows.Scan(&id, &createdAt, &ipAddress, &metadata, &action); err != nil {
			return nil, err
		}
		method := loginActionToMethod[action]
		if method == "" {
			method = action
		}
		out = append(out, UserLoginRecordModel{
			CreatedAt: utcTime(createdAt),
			ID:        id,
			IPAddress: nullStringPtr(ipAddress),
			Method:    method,
			UserAgent: auditMetadataUserAgent(metadata),
		})
	}
	return out, rows.Err()
}

// auditMetadata is the subset of AuditLog.metadata the login records expose.
type auditMetadata struct {
	UserAgent *string `json:"userAgent"`
}

// auditMetadataUserAgent extracts a non-empty metadata.userAgent string, the
// same rule as UserAdminService.extractUserAgent.
func auditMetadataUserAgent(raw []byte) *string {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil
	}
	var metadata auditMetadata
	if err := json.Unmarshal(raw, &metadata); err != nil {
		return nil
	}
	if metadata.UserAgent == nil || strings.TrimSpace(*metadata.UserAgent) == "" {
		return nil
	}
	return metadata.UserAgent
}

// boolDefault returns the value when present and the fallback otherwise,
// matching the `value ?? default` idiom.
func boolDefault(value sql.NullBool, fallback bool) bool {
	if !value.Valid {
		return fallback
	}
	return value.Bool
}

// sqlStringList renders a fixed list of trusted column values as an SQL
// literal list. The values are code constants, never request input.
func sqlStringList(values []string) string {
	quoted := make([]string, 0, len(values))
	for _, value := range values {
		quoted = append(quoted, "'"+strings.ReplaceAll(value, "'", "''")+"'")
	}
	return strings.Join(quoted, ",")
}
