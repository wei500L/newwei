package settingscrawl

import (
	"context"
	"database/sql"
	"errors"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// assertSystemAdmin re-derives the administrator gate from MySQL.
//
// It mirrors the fixed SettingsResolver.assertAdmin: the caller must hold a
// role that belongs to the caller's own organization, is the built-in system
// role and is named "admin" (case-insensitively). The pre-fix NestJS query
// matched on the role id and display name alone, so an organization-scoped
// custom role named "admin" or a role id borrowed from another organization
// passed the gate; the Go reader implements the corrected predicate directly:
//
//	SELECT id FROM Role WHERE orgId = ? AND isSystem = 1
//	  AND LOWER(name) = 'admin' AND id IN (<caller role ids>)
//
// The contract.Identity carries no role ids, so the caller's role ids are
// re-derived from the same Membership/MembershipRole join the authorization
// layer uses: the MembershipRole rows are authoritative and Membership.roleId
// (the primary role) is consulted only when no MembershipRole row exists.
//
// An empty role set reports 403 "Unauthenticated" and a missing admin role
// reports 403 "Admin access required"; both mirror the NestJS plain
// ForbiddenException, which carries no appCode.
func (s *store) assertSystemAdmin(ctx context.Context, identity contract.Identity) error {
	if s == nil || s.db == nil {
		return &contract.Failure{
			Message: "Internal server error",
			Status:  http.StatusInternalServerError,
		}
	}
	if identity.UserID == "" || identity.OrgID == "" {
		return forbiddenPlain("Unauthenticated")
	}
	var membershipID string
	err := s.db.QueryRowContext(ctx,
		"SELECT `id` FROM `Membership` WHERE `userId` = ? AND `orgId` = ? LIMIT 1",
		identity.UserID, identity.OrgID,
	).Scan(&membershipID)
	if errors.Is(err, sql.ErrNoRows) {
		return forbiddenPlain("Unauthenticated")
	}
	if err != nil {
		return err
	}

	// A caller with no MembershipRole row falls back to the membership's
	// primary role, exactly like the authorization layer's permission
	// re-derivation.
	var hasMembershipRoles bool
	if err := s.db.QueryRowContext(ctx,
		"SELECT EXISTS(SELECT 1 FROM `MembershipRole` WHERE `membershipId` = ?)", membershipID,
	).Scan(&hasMembershipRoles); err != nil {
		return err
	}

	query := "SELECT `r`.`id` FROM `MembershipRole` `mr` " +
		"JOIN `Role` `r` ON `r`.`id` = `mr`.`roleId` " +
		"WHERE `mr`.`membershipId` = ? AND `r`.`orgId` = ? AND `r`.`isSystem` = 1 " +
		"AND LOWER(`r`.`name`) = 'admin' LIMIT 1"
	if !hasMembershipRoles {
		query = "SELECT `r`.`id` FROM `Membership` `m` " +
			"JOIN `Role` `r` ON `r`.`id` = `m`.`roleId` " +
			"WHERE `m`.`id` = ? AND `r`.`orgId` = ? AND `r`.`isSystem` = 1 " +
			"AND LOWER(`r`.`name`) = 'admin' LIMIT 1"
	}
	var adminRoleID string
	err = s.db.QueryRowContext(ctx, query, membershipID, identity.OrgID).Scan(&adminRoleID)
	if errors.Is(err, sql.ErrNoRows) {
		return forbiddenPlain("Admin access required")
	}
	if err != nil {
		return err
	}
	return nil
}

// forbiddenPlain builds the plain ForbiddenException shape: HTTP 403, code
// FORBIDDEN derived by the executor, and no appCode.
func forbiddenPlain(message string) error {
	return &contract.Failure{Message: message, Status: http.StatusForbidden}
}

// badRequest builds the plain BadRequestException shape used by the source
// policy revision diff: HTTP 400, code BAD_REQUEST and no appCode.
func badRequest(message string) error {
	return &contract.Failure{Message: message, Status: http.StatusBadRequest}
}
