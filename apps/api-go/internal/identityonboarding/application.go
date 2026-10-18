package identityonboarding

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authlogin"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/orgaccesswrite"
)

// SubmitNewOrgApplication mirrors submitNewOrgApplication: the three duplicate
// checks keep their order and messages, and nothing is created besides the
// application row. No organization, user, invitation or token is produced here.
func (s *Service) SubmitNewOrgApplication(ctx context.Context, input submitNewOrgRequest) (applicationScalar, error) {
	email := normalizeEmailAddress(input.Email)
	slug := strings.ToLower(jsTrim(input.OrgSlug))

	pending, err := rowExists(ctx, s.db,
		"SELECT `id` FROM `RegistrationApplication` WHERE `type` = 'new_org' AND `status` = 'pending' AND `email` = ? LIMIT 1",
		email)
	if err != nil {
		return applicationScalar{}, err
	}
	if pending {
		return applicationScalar{}, conflict("An application for this email is already pending review")
	}
	taken, err := rowExists(ctx, s.db, "SELECT `id` FROM `Org` WHERE `slug` = ? LIMIT 1", slug)
	if err != nil {
		return applicationScalar{}, err
	}
	if taken {
		return applicationScalar{}, conflict("Organization slug is already in use")
	}
	slugPending, err := rowExists(ctx, s.db,
		"SELECT `id` FROM `RegistrationApplication` WHERE `type` = 'new_org' AND `status` = 'pending' AND `requestedOrgSlug` = ? LIMIT 1",
		slug)
	if err != nil {
		return applicationScalar{}, err
	}
	if slugPending {
		return applicationScalar{}, conflict("Organization slug is already pending review")
	}

	applicationID, err := newRowID()
	if err != nil {
		return applicationScalar{}, err
	}
	now := nowMillis()
	record := applicationRecord{
		ID:                   applicationID,
		Type:                 applicationTypeNewOrg,
		Status:               applicationStatusPending,
		Email:                email,
		FirstName:            jsTrim(input.FirstName),
		LastName:             jsTrim(input.LastName),
		RequestedOrgName:     stringPtr(jsTrim(input.OrgName)),
		RequestedOrgSlug:     stringPtr(slug),
		RequestedDescription: trimmedName(input.Description),
		CreatedAt:            now,
		UpdatedAt:            now,
	}
	if err := insertApplication(ctx, s.db, record); err != nil {
		return applicationScalar{}, err
	}
	return record.scalar(), nil
}

// SubmitJoinOrgApplication mirrors submitJoinOrgApplication: the organization is
// resolved by the normalized slug, the duplicate check is scoped to that
// organization, and the response carries the organization relation.
func (s *Service) SubmitJoinOrgApplication(ctx context.Context, input submitJoinOrgRequest) (applicationWithOrg, error) {
	org, found, err := loadOrgBySlug(ctx, s.db, strings.ToLower(jsTrim(input.OrgSlug)))
	if err != nil {
		return applicationWithOrg{}, err
	}
	if !found {
		return applicationWithOrg{}, notFound("Organization not found")
	}
	email := normalizeEmailAddress(input.Email)
	pending, err := rowExists(ctx, s.db,
		"SELECT `id` FROM `RegistrationApplication` WHERE `type` = 'join_org' AND `status` = 'pending' AND `email` = ? AND `orgId` = ? LIMIT 1",
		email, org.ID)
	if err != nil {
		return applicationWithOrg{}, err
	}
	if pending {
		return applicationWithOrg{}, conflict("An application for this email is already pending review")
	}

	applicationID, err := newRowID()
	if err != nil {
		return applicationWithOrg{}, err
	}
	now := nowMillis()
	record := applicationRecord{
		ID:        applicationID,
		Type:      applicationTypeJoinOrg,
		Status:    applicationStatusPending,
		Email:     email,
		FirstName: jsTrim(input.FirstName),
		LastName:  jsTrim(input.LastName),
		OrgID:     stringPtr(org.ID),
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := insertApplication(ctx, s.db, record); err != nil {
		return applicationWithOrg{}, err
	}
	view := org.view()
	return applicationWithOrg{applicationScalar: record.scalar(), Org: &view}, nil
}

// ListApplications mirrors the controller handler: users.write decides the
// organization list, the global platform_admin assignment decides the platform
// list, both may be present, and neither yields 403.
func (s *Service) ListApplications(ctx context.Context, userID, orgID string, hasUsersWrite bool) (applicationList, error) {
	platformAdmin, err := s.isPlatformAdmin(ctx, userID)
	if err != nil {
		return applicationList{}, err
	}
	if !hasUsersWrite && !platformAdmin {
		return applicationList{}, forbidden("Insufficient permissions")
	}
	out := applicationList{
		OrgApplications:      []applicationWithOrgAndReviewer{},
		PlatformApplications: []applicationWithReviewer{},
	}
	if hasUsersWrite {
		// The organization list re-checks the membership and users.write for the
		// current organization; the token permission alone is not enough.
		if err := s.assertOrgAdmin(ctx, orgID, userID); err != nil {
			return applicationList{}, err
		}
		out.OrgApplications, err = loadOrgApplications(ctx, s.db, orgID)
		if err != nil {
			return applicationList{}, err
		}
	}
	if platformAdmin {
		out.PlatformApplications, err = loadPlatformApplications(ctx, s.db)
		if err != nil {
			return applicationList{}, err
		}
	}
	return out, nil
}

// ApproveJoin mirrors approveJoinApplication: organization scope and grant scope
// first, then the pending read, then the single-use claim, then the ordinary
// invitation chain. Only a failed invite releases the claim, and only while the
// application is still approved with no generated invite.
func (s *Service) ApproveJoin(ctx context.Context, actorID, orgID, applicationID, primaryRoleID string, roleIDs []string) (applicationWithOrgAndReviewer, error) {
	if err := s.assertOrgAdmin(ctx, orgID, actorID); err != nil {
		return applicationWithOrgAndReviewer{}, err
	}
	checkedRoleIDs := make([]string, 0, len(roleIDs)+1)
	checkedRoleIDs = append(checkedRoleIDs, roleIDs...)
	checkedRoleIDs = append(checkedRoleIDs, primaryRoleID)
	if err := s.assertRolesAssignable(ctx, actorID, orgID, checkedRoleIDs); err != nil {
		return applicationWithOrgAndReviewer{}, err
	}
	application, found, err := loadApplicationByIDOrgType(ctx, s.db, applicationID, orgID, applicationTypeJoinOrg)
	if err != nil {
		return applicationWithOrgAndReviewer{}, err
	}
	if !found || application.OrgID == nil {
		return applicationWithOrgAndReviewer{}, notFound("Registration application not found")
	}

	now := nowMillis()
	claimed, err := claimApplication(ctx, s.db, application.ID, actorID, now)
	if err != nil {
		return applicationWithOrgAndReviewer{}, err
	}
	if !claimed {
		return applicationWithOrgAndReviewer{}, conflict("Registration application was already reviewed")
	}

	invite, err := s.CreateInvite(ctx, orgID, actorID, createInviteInput{
		Email:         application.Email,
		FirstName:     stringPtr(application.FirstName),
		LastName:      stringPtr(application.LastName),
		PrimaryRoleID: primaryRoleID,
		RoleIDs:       roleIDs,
	})
	if err != nil {
		// Compensation: release the claim so the administrator can retry. This is
		// not a generic retry platform; it is the single conditional update the
		// source performs.
		releaseApplicationClaim(ctx, s.db, application.ID, nowMillis())
		return applicationWithOrgAndReviewer{}, err
	}

	if err := linkGeneratedInvite(ctx, s.db, application.ID, invite.ID, nowMillis()); err != nil {
		return applicationWithOrgAndReviewer{}, err
	}
	writeAuditBestEffort(ctx, s.db, orgID, actorID, "registration_application", "approve_join", approveJoinAudit{
		ApplicationID: application.ID,
		InviteID:      invite.ID,
		PrimaryRoleID: primaryRoleID,
		RoleIDs:       roleIDs,
		Email:         application.Email,
	})
	return s.loadApprovedJoin(ctx, application.ID)
}

// loadApprovedJoin reloads the application with org and reviewedBy.
func (s *Service) loadApprovedJoin(ctx context.Context, applicationID string) (applicationWithOrgAndReviewer, error) {
	application, found, err := loadApplicationByID(ctx, s.db, applicationID)
	if err != nil {
		return applicationWithOrgAndReviewer{}, err
	}
	if !found {
		return applicationWithOrgAndReviewer{}, notFound("Registration application not found")
	}
	out := applicationWithOrgAndReviewer{applicationScalar: application.scalar()}
	if application.OrgID != nil {
		org, found, err := loadOrgByID(ctx, s.db, *application.OrgID)
		if err != nil {
			return applicationWithOrgAndReviewer{}, err
		}
		if found {
			view := org.view()
			out.Org = &view
		}
	}
	if application.ReviewedByID != nil {
		reviewer, found, err := loadUserByID(ctx, s.db, *application.ReviewedByID)
		if err != nil {
			return applicationWithOrgAndReviewer{}, err
		}
		if found {
			out.ReviewedBy = reviewer.view()
		}
	}
	return out, nil
}

// RejectJoin mirrors rejectJoinApplication. The reason is stored, but the email
// keeps its original template and does not embed the reason.
func (s *Service) RejectJoin(ctx context.Context, actorID, orgID, applicationID string, reason *string) (applicationWithOrg, error) {
	if err := s.assertOrgAdmin(ctx, orgID, actorID); err != nil {
		return applicationWithOrg{}, err
	}
	application, found, err := loadApplicationByIDOrgType(ctx, s.db, applicationID, orgID, applicationTypeJoinOrg)
	if err != nil {
		return applicationWithOrg{}, err
	}
	if !found {
		return applicationWithOrg{}, notFound("Registration application not found")
	}
	decisionReason := trimmedName(reason)
	now := nowMillis()
	if err := rejectApplication(ctx, s.db, application.ID, actorID, decisionReason, now); err != nil {
		return applicationWithOrg{}, err
	}
	application.Status = applicationStatusRejected
	application.DecisionReason = decisionReason
	application.ReviewedByID = stringPtr(actorID)
	application.ReviewedAt = &now
	application.UpdatedAt = now

	orgName := "the organization"
	out := applicationWithOrg{applicationScalar: application.scalar()}
	if application.OrgID != nil {
		org, found, err := loadOrgByID(ctx, s.db, *application.OrgID)
		if err != nil {
			return applicationWithOrg{}, err
		}
		if found {
			orgName = org.Name
			view := org.view()
			out.Org = &view
		}
	}
	if err := s.sendApplicationUpdate(ctx, application.Email, "Registration application update",
		"Your request to join "+orgName+" was not approved.",
		"<p>Your request to join <strong>"+orgName+"</strong> was not approved.</p>"); err != nil {
		return applicationWithOrg{}, err
	}
	writeAuditBestEffort(ctx, s.db, orgID, actorID, "registration_application", "reject_join", rejectJoinAudit{
		ApplicationID:  application.ID,
		DecisionReason: decisionReason,
		Email:          application.Email,
	})
	return out, nil
}

// ApproveNewOrg is the controlled new-organization path. It verifies the global
// platform administrator, claims the pending application, reuses the shared
// organization bootstrap, and creates the administrator invitation internally.
//
// The source then calls the ordinary invite service with the system admin role,
// which the ordinary grant guard rejects, leaving the organization created and
// the applicant unable to join. Here the role is derived from the organization
// and the application by the server; no client input, header or query parameter
// can reach this path, and the ordinary invite and approve-join flows keep
// rejecting the system administrator role.
func (s *Service) ApproveNewOrg(ctx context.Context, actorID, applicationID string) (applicationScalar, error) {
	if err := s.assertPlatformAdmin(ctx, actorID); err != nil {
		return applicationScalar{}, err
	}
	application, found, err := loadApplicationByIDType(ctx, s.db, applicationID, applicationTypeNewOrg)
	if err != nil {
		return applicationScalar{}, err
	}
	if !found {
		return applicationScalar{}, notFound("Registration application not found")
	}
	if application.RequestedOrgName == nil || *application.RequestedOrgName == "" ||
		application.RequestedOrgSlug == nil || *application.RequestedOrgSlug == "" {
		return applicationScalar{}, badRequest("Organization details are incomplete")
	}

	now := nowMillis()
	claimed, err := claimApplication(ctx, s.db, application.ID, actorID, now)
	if err != nil {
		return applicationScalar{}, err
	}
	if !claimed {
		return applicationScalar{}, conflict("Registration application was already reviewed")
	}

	created, err := s.orgs.CreateOrg(ctx, orgaccesswrite.CreateOrgParams{
		ActorID:     actorID,
		Name:        *application.RequestedOrgName,
		Slug:        *application.RequestedOrgSlug,
		Description: application.RequestedDescription,
	})
	if err != nil {
		// Only the organization bootstrap is compensated: the source releases the
		// claim in exactly this branch.
		releaseApplicationClaim(ctx, s.db, application.ID, nowMillis())
		return applicationScalar{}, bootstrapError(err)
	}

	adminRole, found, err := loadAdminRole(ctx, s.db, created.ID)
	if err != nil {
		return applicationScalar{}, err
	}
	if !found {
		return applicationScalar{}, notFound("Admin role not found for approved organization")
	}

	// Controlled invitation: role existence and organization membership are still
	// checked, but the assignability guard is intentionally not applied because
	// the platform administrator approving an organization is not a member of it
	// and the system admin role is the whole point of this invitation.
	inviteInput := createInviteInput{
		Email:         application.Email,
		FirstName:     stringPtr(application.FirstName),
		LastName:      stringPtr(application.LastName),
		PrimaryRoleID: adminRole.ID,
		RoleIDs:       []string{adminRole.ID},
	}
	if err := s.ensureRoleSet(ctx, created.ID, adminRole.ID, inviteInput.RoleIDs); err != nil {
		return applicationScalar{}, err
	}
	invite, err := s.insertAndDeliverInvite(ctx, created.ID, actorID, inviteInput, inviteInput.RoleIDs, nowMillis())
	if err != nil {
		return applicationScalar{}, err
	}

	writeAuditBestEffort(ctx, s.db, created.ID, actorID, "org", "registration_application_approved", orgApplicationApprovedAudit{
		ApplicationID: application.ID,
		InviteID:      invite.ID,
	})
	if err := linkGeneratedInvite(ctx, s.db, application.ID, invite.ID, nowMillis()); err != nil {
		return applicationScalar{}, err
	}
	updated, found, err := loadApplicationByID(ctx, s.db, application.ID)
	if err != nil {
		return applicationScalar{}, err
	}
	if !found {
		return applicationScalar{}, notFound("Registration application not found")
	}
	return updated.scalar(), nil
}

// RejectNewOrg mirrors rejectNewOrgApplication: platform role, pending read,
// decision, real mail. The source writes no audit row for this action, so none is
// invented here.
func (s *Service) RejectNewOrg(ctx context.Context, actorID, applicationID string, reason *string) (applicationScalar, error) {
	if err := s.assertPlatformAdmin(ctx, actorID); err != nil {
		return applicationScalar{}, err
	}
	application, found, err := loadApplicationByIDType(ctx, s.db, applicationID, applicationTypeNewOrg)
	if err != nil {
		return applicationScalar{}, err
	}
	if !found {
		return applicationScalar{}, notFound("Registration application not found")
	}
	decisionReason := trimmedName(reason)
	now := nowMillis()
	if err := rejectApplication(ctx, s.db, application.ID, actorID, decisionReason, now); err != nil {
		return applicationScalar{}, err
	}
	application.Status = applicationStatusRejected
	application.DecisionReason = decisionReason
	application.ReviewedByID = stringPtr(actorID)
	application.ReviewedAt = &now
	application.UpdatedAt = now

	if err := s.sendApplicationUpdate(ctx, application.Email, "Organization application update",
		"Your organization registration request was not approved.",
		"<p>Your organization registration request was not approved.</p>"); err != nil {
		return applicationScalar{}, err
	}
	return application.scalar(), nil
}

// sendApplicationUpdate delivers one plain notification through the same SMTP
// port as the invitation mail.
func (s *Service) sendApplicationUpdate(ctx context.Context, to, subject, text, html string) error {
	if s.mail == nil {
		return fmt.Errorf("identityonboarding: mail sender is not configured")
	}
	return s.mail.Send(ctx, authlogin.MailMessage{To: to, Subject: subject, Text: text, HTML: html})
}

// loadAdminRole reads the default administrator role of a freshly created
// organization. The source filters by name only, not by isSystem.
func loadAdminRole(ctx context.Context, q dbtx, orgID string) (roleRecord, bool, error) {
	role, err := scanRole(q.QueryRowContext(ctx,
		"SELECT "+roleColumns+" FROM `Role` WHERE `orgId` = ? AND `name` = 'admin' LIMIT 1", orgID))
	if errors.Is(err, sql.ErrNoRows) {
		return roleRecord{}, false, nil
	}
	if err != nil {
		return roleRecord{}, false, err
	}
	return role, true, nil
}

// rowExists runs a LIMIT 1 existence probe.
func rowExists(ctx context.Context, q dbtx, query string, args ...any) (bool, error) {
	var id string
	err := q.QueryRowContext(ctx, query, args...).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// bootstrapError maps an organization-bootstrap failure onto the HTTP contract;
// an unknown failure stays a 500.
func bootstrapError(err error) error {
	status, message := orgaccesswrite.StatusOf(err)
	if status >= 400 && status < 500 && message != "" {
		return &httpError{status: status, message: message}
	}
	return err
}
