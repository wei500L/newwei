package accountsecurity

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

// This file reproduces AuthService.getUserProfile/updateProfile and the parts of
// membership-permissions.ts they depend on. The profile cache layer lives in
// profile_cache.go.

// getProfile returns the base profile (no request jti/exp) using the shared
// profile cache exactly like AuthService.getUserProfile.
func (s *Service) getProfile(ctx context.Context, userID, claimOrgID string) (profileResponse, error) {
	settings, err := s.getAuthCacheSettings(ctx)
	if err != nil {
		return profileResponse{}, err
	}
	key := profileCacheKey(userID, claimOrgID)
	options := profileCacheOptions{
		LockTTLMs:    settings.LockTTLMs,
		RetryDelayMs: settings.RetryDelayMs,
		MaxWaitMs:    settings.MaxWaitMs,
	}
	return s.profileCacheWrap(ctx, key, settings.ProfileTTLSeconds, func(loaderCtx context.Context) (profileResponse, error) {
		return s.buildBaseProfile(loaderCtx, userID, claimOrgID)
	}, options)
}

// buildBaseProfile is the cache loader: it re-derives the membership, user
// state, roles, permissions, global roles and MFA status from MySQL. It never
// trusts the access token's permissions claim.
func (s *Service) buildBaseProfile(ctx context.Context, userID, claimOrgID string) (profileResponse, error) {
	memberships, err := s.listMemberships(ctx, userID)
	if err != nil {
		return profileResponse{}, err
	}
	membership, err := pickMembership(memberships, claimOrgID)
	if err != nil {
		return profileResponse{}, err
	}
	if err := assertMembershipAccessible(membership); err != nil {
		return profileResponse{}, err
	}

	user, err := s.loadUser(ctx, userID)
	if err != nil {
		return profileResponse{}, err
	}
	if !user.IsActive {
		return profileResponse{}, unauthorized("User disabled")
	}

	claims, err := s.buildMembershipClaims(ctx, membership)
	if err != nil {
		return profileResponse{}, err
	}
	globalRoles, err := s.globalRoles(ctx, userID)
	if err != nil {
		return profileResponse{}, err
	}
	mfaEnabled, err := s.mfaEnabled(ctx, userID)
	if err != nil {
		return profileResponse{}, err
	}

	return profileResponse{
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

// membershipClaims is the derived role/permission projection.
type membershipClaims struct {
	PrimaryRoleID *string
	RoleIDs       []string
	Permissions   []string
}

// listMemberships loads every membership of the user, oldest first, with the
// organization state the picker and the response need.
func (s *Service) listMemberships(ctx context.Context, userID string) ([]membershipRow, error) {
	if s == nil || s.db == nil {
		return nil, errNoDatabase
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT `m`.`id`, `m`.`orgId`, `m`.`isActive`, `m`.`roleId`, `o`.`slug`, `o`.`isActive`, "+
			"`o`.`planTier`, `o`.`subscriptionStatus`, `m`.`createdAt` FROM `Membership` `m` "+
			"JOIN `Org` `o` ON `o`.`id` = `m`.`orgId` WHERE `m`.`userId` = ? "+
			"ORDER BY `m`.`createdAt` ASC", userID)
	if err != nil {
		return nil, dbWrap(err)
	}
	defer rows.Close()

	memberships := make([]membershipRow, 0, 4)
	for rows.Next() {
		var row membershipRow
		var planTier, subscriptionStatus sql.NullString
		if err := rows.Scan(&row.MembershipID, &row.OrgID, &row.Active, &row.RoleID,
			&row.OrgSlug, &row.OrgActive, &planTier, &subscriptionStatus, &row.CreatedAt); err != nil {
			return nil, dbWrap(err)
		}
		row.PlanTier = nullableString(planTier)
		row.SubscriptionStatus = nullableString(subscriptionStatus)
		memberships = append(memberships, row)
	}
	if err := rows.Err(); err != nil {
		return nil, dbWrap(err)
	}
	return memberships, nil
}

// membershipAccessible mirrors isMembershipAccessible.
func membershipAccessible(row membershipRow) bool {
	return row.OrgActive && row.Active
}

// assertMembershipAccessible mirrors assertMembershipAccessible: the
// organization check runs before the membership check.
func assertMembershipAccessible(row *membershipRow) error {
	if !row.OrgActive {
		return unauthorized("Organization disabled")
	}
	if !row.Active {
		return unauthorized("Organization access disabled")
	}
	return nil
}

// pickMembership mirrors pickMembership for the token's orgId claim (an exact or
// case-insensitive id match, or a case-insensitive slug match).
func pickMembership(memberships []membershipRow, orgIDOrSlug string) (*membershipRow, error) {
	if len(memberships) == 0 {
		return nil, unauthorized("User is not assigned to an organization")
	}
	if orgIDOrSlug == "" {
		active := make([]*membershipRow, 0, len(memberships))
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
		if len(active) == 1 {
			return active[0], nil
		}
		if len(active) == 0 {
			for index := range memberships {
				if !memberships[index].Active {
					return nil, unauthorized("Organization access disabled")
				}
			}
			return nil, unauthorized("Organization disabled")
		}
		return nil, badRequest("Organization is required when a user belongs to multiple organizations")
	}

	normalized := strings.TrimSpace(orgIDOrSlug)
	for index := range memberships {
		row := &memberships[index]
		if row.OrgID == normalized || strings.EqualFold(row.OrgID, normalized) {
			return row, nil
		}
		if row.OrgSlug != "" && strings.EqualFold(row.OrgSlug, normalized) {
			return row, nil
		}
	}
	return nil, unauthorized("User is not assigned to the specified organization")
}

// loadUser loads the profile-relevant user columns.
func (s *Service) loadUser(ctx context.Context, userID string) (userRow, error) {
	if s == nil || s.db == nil {
		return userRow{}, errNoDatabase
	}
	var row userRow
	var emailVerified, lastLoginAt sql.NullTime
	var pendingEmail, avatarURL sql.NullString
	err := s.db.QueryRowContext(ctx,
		"SELECT `id`, `email`, `emailVerified`, `lastLoginAt`, `pendingEmail`, `firstName`, "+
			"`lastName`, `avatarUrl`, `isActive` FROM `User` WHERE `id` = ?", userID).
		Scan(&row.ID, &row.Email, &emailVerified, &lastLoginAt, &pendingEmail,
			&row.FirstName, &row.LastName, &avatarURL, &row.IsActive)
	if errors.Is(err, sql.ErrNoRows) {
		return userRow{}, unauthorized("Invalid access token")
	}
	if err != nil {
		return userRow{}, dbWrap(err)
	}
	row.EmailVerified = nullableTime(emailVerified)
	row.LastLoginAt = nullableTime(lastLoginAt)
	row.PendingEmail = nullableString(pendingEmail)
	row.AvatarURL = nullableString(avatarURL)
	return row, nil
}

// userExists reports whether a real User row exists. Machine identities
// (machine:<tokenId>) are not User rows, so AS3 needs this explicit check before
// any Prisma-style update of a missing primary key.
func (s *Service) userExists(ctx context.Context, userID string) (bool, error) {
	if s == nil || s.db == nil {
		return false, errNoDatabase
	}
	var id string
	err := s.db.QueryRowContext(ctx, "SELECT `id` FROM `User` WHERE `id` = ?", userID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, dbWrap(err)
	}
	return true, nil
}

// buildMembershipClaims mirrors buildMembershipClaims + collectMembershipRoleIds
// + collectMembershipPermissionSet: MembershipRole links win; only when there is
// no link at all does the primary Membership.role fall back.
func (s *Service) buildMembershipClaims(ctx context.Context, membership *membershipRow) (membershipClaims, error) {
	if s == nil || s.db == nil {
		return membershipClaims{}, errNoDatabase
	}
	var hasMembershipRoles bool
	if err := s.db.QueryRowContext(ctx,
		"SELECT EXISTS(SELECT 1 FROM `MembershipRole` WHERE `membershipId` = ?)",
		membership.MembershipID).Scan(&hasMembershipRoles); err != nil {
		return membershipClaims{}, dbWrap(err)
	}

	primaryRoleID := membership.RoleID
	claims := membershipClaims{PrimaryRoleID: &primaryRoleID}

	roleIDs := make([]string, 0, 4)
	if hasMembershipRoles {
		rows, err := s.db.QueryContext(ctx,
			"SELECT `roleId` FROM `MembershipRole` WHERE `membershipId` = ? ORDER BY `roleId` ASC",
			membership.MembershipID)
		if err != nil {
			return membershipClaims{}, dbWrap(err)
		}
		defer rows.Close()
		for rows.Next() {
			var roleID string
			if err := rows.Scan(&roleID); err != nil {
				return membershipClaims{}, dbWrap(err)
			}
			roleIDs = append(roleIDs, roleID)
		}
		if err := rows.Err(); err != nil {
			return membershipClaims{}, dbWrap(err)
		}
	} else {
		roleIDs = append(roleIDs, primaryRoleID)
	}
	claims.RoleIDs = roleIDs

	permissions, err := s.membershipPermissionNames(ctx, membership, hasMembershipRoles)
	if err != nil {
		return membershipClaims{}, err
	}
	claims.Permissions = permissions
	return claims, nil
}

// membershipPermissionNames derives the deduplicated permission names from
// RolePermission -> Permission, trimming and dropping empty names exactly like
// collectMembershipPermissionSet.
func (s *Service) membershipPermissionNames(ctx context.Context, membership *membershipRow, hasMembershipRoles bool) ([]string, error) {
	query := "SELECT `p`.`name` FROM `Membership` `m` " +
		"JOIN `RolePermission` `rp` ON `rp`.`roleId` = `m`.`roleId` " +
		"JOIN `Permission` `p` ON `p`.`id` = `rp`.`permissionId` " +
		"WHERE `m`.`id` = ? ORDER BY `p`.`name` ASC"
	argument := membership.MembershipID
	if hasMembershipRoles {
		query = "SELECT `p`.`name` FROM `MembershipRole` `mr` " +
			"JOIN `RolePermission` `rp` ON `rp`.`roleId` = `mr`.`roleId` " +
			"JOIN `Permission` `p` ON `p`.`id` = `rp`.`permissionId` " +
			"WHERE `mr`.`membershipId` = ? ORDER BY `p`.`name` ASC"
	}
	rows, err := s.db.QueryContext(ctx, query, argument)
	if err != nil {
		return nil, dbWrap(err)
	}
	defer rows.Close()

	seen := map[string]bool{}
	permissions := make([]string, 0, 8)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, dbWrap(err)
		}
		if strings.TrimSpace(name) == "" || seen[name] {
			continue
		}
		seen[name] = true
		permissions = append(permissions, name)
	}
	if err := rows.Err(); err != nil {
		return nil, dbWrap(err)
	}
	return permissions, nil
}

// globalRoles mirrors PlatformAccessService.getGlobalRoles (createdAt ASC).
func (s *Service) globalRoles(ctx context.Context, userID string) ([]string, error) {
	if s == nil || s.db == nil {
		return nil, errNoDatabase
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT `role` FROM `GlobalRoleAssignment` WHERE `userId` = ? ORDER BY `createdAt` ASC", userID)
	if err != nil {
		return nil, dbWrap(err)
	}
	defer rows.Close()
	roles := make([]string, 0, 2)
	for rows.Next() {
		var role string
		if err := rows.Scan(&role); err != nil {
			return nil, dbWrap(err)
		}
		roles = append(roles, role)
	}
	if err := rows.Err(); err != nil {
		return nil, dbWrap(err)
	}
	return roles, nil
}

// mfaEnabled mirrors MfaService.getStatus().enabled:
// Boolean(factor?.verifiedAt && !factor?.disabledAt).
func (s *Service) mfaEnabled(ctx context.Context, userID string) (bool, error) {
	if s == nil || s.db == nil {
		return false, errNoDatabase
	}
	var verifiedAt, disabledAt sql.NullTime
	err := s.db.QueryRowContext(ctx,
		"SELECT `verifiedAt`, `disabledAt` FROM `UserTotpFactor` WHERE `userId` = ?", userID).
		Scan(&verifiedAt, &disabledAt)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, dbWrap(err)
	}
	return verifiedAt.Valid && !disabledAt.Valid, nil
}

// updateProfile mirrors AuthService.updateProfile with the AS3 fixes: a machine
// identity (no real User row) is 401 before any write, an explicit JSON null is
// the same empty-field 400 as a blank string, and every field is validated
// before the single UPDATE runs.
func (s *Service) updateProfile(ctx context.Context, userID, claimOrgID string, request updateProfileRequest) (profileResponse, error) {
	exists, err := s.userExists(ctx, userID)
	if err != nil {
		return profileResponse{}, err
	}
	if !exists {
		return profileResponse{}, unauthorized("Invalid access token")
	}

	var firstName, lastName, avatarURL *string

	if present(request.FirstName) {
		value, err := profileFieldValue(request.FirstName, "First name cannot be empty")
		if err != nil {
			return profileResponse{}, err
		}
		firstName = value
	}
	if present(request.LastName) {
		value, err := profileFieldValue(request.LastName, "Last name cannot be empty")
		if err != nil {
			return profileResponse{}, err
		}
		lastName = value
	}
	if present(request.AvatarURL) {
		value, err := profileFieldValue(request.AvatarURL, "Avatar URL cannot be empty")
		if err != nil {
			return profileResponse{}, err
		}
		allowed, err := s.isPublicURL(ctx, *value)
		if err != nil {
			return profileResponse{}, err
		}
		if !allowed {
			return profileResponse{}, badRequest("Avatar URL must use the approved storage base URL")
		}
		avatarURL = value
	}

	if firstName == nil && lastName == nil && avatarURL == nil {
		// Empty body / all fields absent: a no-op read that must not touch
		// User.updatedAt.
		return s.getProfile(ctx, userID, claimOrgID)
	}

	if s == nil || s.db == nil {
		return profileResponse{}, errNoDatabase
	}
	// A single parameterized UPDATE with COALESCE keeps absent fields untouched
	// without interpolating column names; a nil argument maps to SQL NULL and
	// COALESCE keeps the existing value.
	_, err = s.db.ExecContext(ctx,
		"UPDATE `User` SET `firstName` = COALESCE(?, `firstName`), "+
			"`lastName` = COALESCE(?, `lastName`), `avatarUrl` = COALESCE(?, `avatarUrl`), "+
			"`updatedAt` = ? WHERE `id` = ?",
		firstName, lastName, avatarURL, nowMillis(), userID)
	if err != nil {
		return profileResponse{}, dbWrap(err)
	}

	// The profile is global to the user: invalidate every organization's cached
	// profile before rebuilding the response.
	if err := s.invalidateProfileCache(ctx, userID, claimOrgID); err != nil {
		return profileResponse{}, err
	}
	return s.getProfile(ctx, userID, claimOrgID)
}

// profileFieldValue applies the shared service rule for one optional profile
// field: an explicit null or a blank/whitespace-only value is the same 400.
func profileFieldValue(raw json.RawMessage, emptyMessage string) (*string, error) {
	if isNull(raw) {
		return nil, badRequest(emptyMessage)
	}
	text, ok := jsonString(raw)
	if !ok {
		return nil, badRequest(emptyMessage)
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil, badRequest(emptyMessage)
	}
	return &trimmed, nil
}
