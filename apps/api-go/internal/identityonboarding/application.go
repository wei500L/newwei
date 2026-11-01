package identityonboarding

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

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
// platform administrator, then either performs the first approval of a pending
// application or resumes an already approved row from its trusted progress
// without creating a second organization or invitation.
//
// The first approval runs the whole database stage — review decision, shared
// organization bootstrap, invitation row and the application → organization →
// invitation association — in one transaction. The external email is sent only
// after that commit, so a delivery failure never erases a committed approval and
// a database failure never leaves an unlocatable organization behind. Repeated
// calls are stable: a fully completed approval is returned unchanged.
func (s *Service) ApproveNewOrg(ctx context.Context, actorID, applicationID string) (applicationScalar, error) {
	if err := s.assertPlatformAdmin(ctx, actorID); err != nil {
		return applicationScalar{}, err
	}
	application, found, err := loadApplicationByIDTypeAnyStatus(ctx, s.db, applicationID, applicationTypeNewOrg)
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
	switch application.Status {
	case applicationStatusPending:
		return s.approvePendingNewOrg(ctx, actorID, application)
	case applicationStatusApproved:
		return s.resumeApprovedNewOrg(ctx, actorID, application)
	default:
		return applicationScalar{}, conflict("Registration application was already reviewed")
	}
}

// approvePendingNewOrg performs the first approval atomically.
func (s *Service) approvePendingNewOrg(ctx context.Context, actorID string, application applicationRecord) (applicationScalar, error) {
	now := nowMillis()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return applicationScalar{}, err
	}
	defer func() { _ = tx.Rollback() }()

	claimed, err := claimApplication(ctx, tx, application.ID, actorID, now)
	if err != nil {
		return applicationScalar{}, err
	}
	if !claimed {
		return applicationScalar{}, conflict("Registration application was already reviewed")
	}
	record, rawToken, err := s.createOrgInviteInTx(ctx, tx, actorID, application, now)
	if err != nil {
		// Rolling back also releases the optimistic claim.
		return applicationScalar{}, err
	}
	if err := tx.Commit(); err != nil {
		return applicationScalar{}, err
	}
	// The organization cache invalidation belongs to the committed bootstrap.
	_ = s.orgs.InvalidateActiveOrgs(ctx)
	s.deliverApprovalInvite(ctx, application.ID, record, rawToken)
	writeAuditBestEffort(ctx, s.db, record.OrgID, actorID, "org", "registration_application_approved", orgApplicationApprovedAudit{
		ApplicationID: application.ID,
		InviteID:      record.ID,
	})
	return s.loadApplicationScalar(ctx, application.ID)
}

// createOrgInviteInTx runs the shared organization bootstrap, saves the
// invitation row and records the application association on the caller's
// transaction. It returns the invitation row and the raw token; the email is
// never sent inside the transaction.
func (s *Service) createOrgInviteInTx(ctx context.Context, tx *sql.Tx, actorID string, application applicationRecord, now time.Time) (inviteRecord, string, error) {
	created, err := s.orgs.CreateOrgInTx(ctx, tx, orgaccesswrite.CreateOrgParams{
		ActorID:     actorID,
		Name:        *application.RequestedOrgName,
		Slug:        *application.RequestedOrgSlug,
		Description: application.RequestedDescription,
	})
	if err != nil {
		return inviteRecord{}, "", bootstrapError(err)
	}
	if err := injectApprovalFault("org_bootstrap"); err != nil {
		return inviteRecord{}, "", err
	}
	inviteInput := createInviteInput{
		Email:         normalizeEmailAddress(application.Email),
		FirstName:     stringPtr(application.FirstName),
		LastName:      stringPtr(application.LastName),
		PrimaryRoleID: created.AdminRoleID,
		RoleIDs:       []string{created.AdminRoleID},
	}
	record, rawToken, err := s.issueInvite(created.ID, actorID, inviteInput, inviteInput.RoleIDs, now)
	if err != nil {
		return inviteRecord{}, "", err
	}
	if err := injectApprovalFault("invite_insert"); err != nil {
		return inviteRecord{}, "", err
	}
	if err := insertInvite(ctx, tx, record); err != nil {
		return inviteRecord{}, "", err
	}
	progress := &applicationApprovalProgress{
		OrgCreated:     true,
		InviteSaved:    true,
		DeliveryStatus: deliveryStatusNone,
	}
	if err := attachApprovedOrg(ctx, tx, application.ID, created.ID, record.ID, encodeApprovalMetadata(progress), now); err != nil {
		return inviteRecord{}, "", err
	}
	if err := injectApprovalFault("association_write"); err != nil {
		return inviteRecord{}, "", err
	}
	return record, rawToken, nil
}

// resumeApprovedNewOrg continues an approved row from its trusted progress. It
// never creates a second organization or invitation, and it never re-sends a
// link that may already have been delivered: only a never-attempted delivery (a
// crash between the commit and the send) is delivered here; failed or unknown
// delivery requires the explicit, token-rotating resend action.
func (s *Service) resumeApprovedNewOrg(ctx context.Context, actorID string, application applicationRecord) (applicationScalar, error) {
	switch {
	case application.OrgID != nil && application.GeneratedInviteID != nil:
		progress := parseApprovalProgress(application.Metadata)
		status := deliveryStatusUnknown
		if progress != nil {
			status = progress.DeliveryStatus
		}
		if status != deliveryStatusNone {
			// Already delivered, failed or unknown: return the stable state so the
			// UI can offer an explicit resend.
			return s.loadApplicationScalar(ctx, application.ID)
		}
		invite, found, err := loadInviteByIDAny(ctx, s.db, *application.GeneratedInviteID)
		if err != nil {
			return applicationScalar{}, err
		}
		if !found {
			return applicationScalar{}, conflict("Generated invitation is missing; recover the application first")
		}
		if invite.Status != inviteStatusPending {
			return s.loadApplicationScalar(ctx, application.ID)
		}
		if err := s.rotateAndDeliver(ctx, application.ID, invite); err != nil {
			return applicationScalar{}, err
		}
		return s.loadApplicationScalar(ctx, application.ID)
	case application.OrgID != nil && application.GeneratedInviteID == nil:
		return s.createMissingInviteForApproved(ctx, actorID, application)
	default:
		// The organization association is missing entirely. Binding by the
		// requested slug or the applicant email would be a guess, so recovery must
		// be explicit.
		return applicationScalar{}, conflict("Organization association is missing; use recover-org to bind it explicitly")
	}
}

// createMissingInviteForApproved handles a historical row whose organization is
// recorded but whose invitation never landed. It issues and links the missing
// invitation in one transaction, then delivers it outside.
func (s *Service) createMissingInviteForApproved(ctx context.Context, actorID string, application applicationRecord) (applicationScalar, error) {
	org, found, err := loadOrgByID(ctx, s.db, *application.OrgID)
	if err != nil {
		return applicationScalar{}, err
	}
	if !found {
		return applicationScalar{}, conflict("Associated organization is missing; use recover-org to bind it explicitly")
	}
	adminRole, found, err := loadAdminRole(ctx, s.db, org.ID)
	if err != nil {
		return applicationScalar{}, err
	}
	if !found {
		return applicationScalar{}, notFound("Admin role not found for approved organization")
	}
	now := nowMillis()
	inviteInput := createInviteInput{
		Email:         normalizeEmailAddress(application.Email),
		FirstName:     stringPtr(application.FirstName),
		LastName:      stringPtr(application.LastName),
		PrimaryRoleID: adminRole.ID,
		RoleIDs:       []string{adminRole.ID},
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return applicationScalar{}, err
	}
	defer func() { _ = tx.Rollback() }()
	record, rawToken, err := s.issueInvite(org.ID, actorID, inviteInput, inviteInput.RoleIDs, now)
	if err != nil {
		return applicationScalar{}, err
	}
	if err := insertInvite(ctx, tx, record); err != nil {
		return applicationScalar{}, err
	}
	progress := &applicationApprovalProgress{OrgCreated: true, InviteSaved: true, DeliveryStatus: deliveryStatusNone}
	if err := attachApprovedOrg(ctx, tx, application.ID, org.ID, record.ID, encodeApprovalMetadata(progress), now); err != nil {
		return applicationScalar{}, err
	}
	if err := tx.Commit(); err != nil {
		return applicationScalar{}, err
	}
	s.deliverApprovalInvite(ctx, application.ID, record, rawToken)
	return s.loadApplicationScalar(ctx, application.ID)
}

// RecoverNewOrg is the platform-administrator recovery action for an approved
// but half-complete application. It never guesses an organization from the
// requested slug or the applicant email: a stored generated invitation is used
// as the trusted link, and a fully missing association is either completed by
// creating the missing organization (only when its slug is still free) or bound
// to an explicitly supplied target organization after server-side verification.
func (s *Service) RecoverNewOrg(ctx context.Context, actorID, applicationID string, request recoverOrgRequest) (applicationScalar, error) {
	if err := s.assertPlatformAdmin(ctx, actorID); err != nil {
		return applicationScalar{}, err
	}
	application, found, err := loadApplicationByIDTypeAnyStatus(ctx, s.db, applicationID, applicationTypeNewOrg)
	if err != nil {
		return applicationScalar{}, err
	}
	if !found {
		return applicationScalar{}, notFound("Registration application not found")
	}
	if application.Status != applicationStatusApproved {
		return applicationScalar{}, conflict("Only approved applications can be recovered")
	}
	if application.OrgID != nil && application.GeneratedInviteID != nil {
		// Already complete; a repeated request is stable.
		return s.loadApplicationScalar(ctx, application.ID)
	}
	if application.GeneratedInviteID != nil && application.OrgID == nil {
		return s.healOrgFromInvite(ctx, actorID, application, request)
	}
	return s.recoverMissingAssociation(ctx, actorID, application, request)
}

// healOrgFromInvite heals an approved row that already has a generated
// invitation but never recorded the organization. The invitation is a trusted
// foreign-key link, so its organization is adopted after the email matches.
func (s *Service) healOrgFromInvite(ctx context.Context, actorID string, application applicationRecord, request recoverOrgRequest) (applicationScalar, error) {
	invite, found, err := loadInviteByIDAny(ctx, s.db, *application.GeneratedInviteID)
	if err != nil {
		return applicationScalar{}, err
	}
	if !found {
		return applicationScalar{}, conflict("Generated invitation is missing; cannot recover automatically")
	}
	if normalizeEmailAddress(invite.Email) != normalizeEmailAddress(application.Email) {
		return applicationScalar{}, conflict("Generated invitation email does not match the application")
	}
	org, found, err := loadOrgByID(ctx, s.db, invite.OrgID)
	if err != nil {
		return applicationScalar{}, err
	}
	if !found {
		return applicationScalar{}, conflict("Generated invitation organization is missing; cannot recover automatically")
	}
	progress := &applicationApprovalProgress{OrgCreated: true, InviteSaved: true, DeliveryStatus: deliveryStatusUnknown}
	now := nowMillis()
	if err := setApplicationOrgAssociation(ctx, s.db, application.ID, org.ID, encodeApprovalMetadata(progress), now); err != nil {
		return applicationScalar{}, err
	}
	writeAuditBestEffort(ctx, s.db, org.ID, actorID, "registration_application", "recover_org", orgApplicationRecoveredAudit{
		ApplicationID: application.ID,
		TargetOrgID:   org.ID,
		InviteID:      invite.ID,
		Action:        "heal_from_invite",
		Reason:        stringOrEmpty(request.Reason),
	})
	return s.loadApplicationScalar(ctx, application.ID)
}

// recoverMissingAssociation handles an approved row with neither organization
// nor invitation. An explicit target organization is adopted only after its slug
// matches the request and the original approver is a member (the fingerprint the
// organization bootstrap leaves behind); otherwise the organization is created
// fresh, and only when its slug is still free.
func (s *Service) recoverMissingAssociation(ctx context.Context, actorID string, application applicationRecord, request recoverOrgRequest) (applicationScalar, error) {
	requestedSlug := ""
	if application.RequestedOrgSlug != nil {
		requestedSlug = *application.RequestedOrgSlug
	}
	targetOrgID := ""
	if request.TargetOrgID != nil {
		targetOrgID = jsTrim(*request.TargetOrgID)
	}
	if targetOrgID != "" {
		return s.bindExistingOrphanOrg(ctx, actorID, application, targetOrgID, request)
	}
	if requestedSlug == "" || application.RequestedOrgName == nil || *application.RequestedOrgName == "" {
		return applicationScalar{}, badRequest("Organization details are incomplete")
	}
	existing, found, err := loadOrgBySlug(ctx, s.db, requestedSlug)
	if err != nil {
		return applicationScalar{}, err
	}
	if found {
		return applicationScalar{}, conflict("An organization with this slug already exists; provide targetOrgId to bind the orphaned organization explicitly")
	}
	return s.createOrgForRecoveredApplication(ctx, actorID, application, request)
}

// bindExistingOrphanOrg adopts an explicit target organization for a historical
// half-complete application. It verifies the slug, that the original approver is
// a member of the organization (the bootstrap always creates that membership)
// and that no other new-organization application is already bound to it. It does
// not modify the organization's members or roles; it only issues the applicant's
// invitation and records the association.
func (s *Service) bindExistingOrphanOrg(ctx context.Context, actorID string, application applicationRecord, targetOrgID string, request recoverOrgRequest) (applicationScalar, error) {
	target, found, err := loadOrgByID(ctx, s.db, targetOrgID)
	if err != nil {
		return applicationScalar{}, err
	}
	if !found {
		return applicationScalar{}, badRequest("Target organization not found")
	}
	if application.RequestedOrgSlug == nil || target.Slug != *application.RequestedOrgSlug {
		return applicationScalar{}, conflict("Target organization does not match the requested organization slug")
	}
	if application.ReviewedByID == nil {
		return applicationScalar{}, conflict("Application has no reviewer; cannot verify the target organization")
	}
	memberOfTarget, err := rowExists(ctx, s.db,
		"SELECT `id` FROM `Membership` WHERE `userId` = ? AND `orgId` = ? LIMIT 1",
		*application.ReviewedByID, target.ID)
	if err != nil {
		return applicationScalar{}, err
	}
	if !memberOfTarget {
		return applicationScalar{}, conflict("Target organization was not created by this approval; refusing to bind it")
	}
	alreadyBound, err := rowExists(ctx, s.db,
		"SELECT `id` FROM `RegistrationApplication` WHERE `orgId` = ? AND `type` = 'new_org' AND `id` <> ? LIMIT 1",
		target.ID, application.ID)
	if err != nil {
		return applicationScalar{}, err
	}
	if alreadyBound {
		return applicationScalar{}, conflict("Target organization is already linked to another application")
	}
	adminRole, found, err := loadAdminRole(ctx, s.db, target.ID)
	if err != nil {
		return applicationScalar{}, err
	}
	if !found {
		return applicationScalar{}, notFound("Admin role not found for target organization")
	}
	record, rawToken, err := s.saveInviteAndAssociate(ctx, actorID, application, target.ID, adminRole.ID)
	if err != nil {
		return applicationScalar{}, err
	}
	s.deliverApprovalInvite(ctx, application.ID, record, rawToken)
	writeAuditBestEffort(ctx, s.db, target.ID, actorID, "registration_application", "recover_org", orgApplicationRecoveredAudit{
		ApplicationID: application.ID,
		TargetOrgID:   target.ID,
		InviteID:      record.ID,
		Action:        "bind_existing_org",
		Reason:        stringOrEmpty(request.Reason),
	})
	return s.loadApplicationScalar(ctx, application.ID)
}

// createOrgForRecoveredApplication completes an approved row whose organization
// was never created (or was rolled back) by creating it now, in one transaction
// with the invitation and the association.
func (s *Service) createOrgForRecoveredApplication(ctx context.Context, actorID string, application applicationRecord, request recoverOrgRequest) (applicationScalar, error) {
	now := nowMillis()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return applicationScalar{}, err
	}
	defer func() { _ = tx.Rollback() }()
	record, rawToken, err := s.createOrgInviteInTx(ctx, tx, actorID, application, now)
	if err != nil {
		return applicationScalar{}, err
	}
	if err := tx.Commit(); err != nil {
		return applicationScalar{}, err
	}
	_ = s.orgs.InvalidateActiveOrgs(ctx)
	s.deliverApprovalInvite(ctx, application.ID, record, rawToken)
	writeAuditBestEffort(ctx, s.db, record.OrgID, actorID, "registration_application", "recover_org", orgApplicationRecoveredAudit{
		ApplicationID: application.ID,
		TargetOrgID:   record.OrgID,
		InviteID:      record.ID,
		Action:        "create_missing_org",
		Reason:        stringOrEmpty(request.Reason),
	})
	return s.loadApplicationScalar(ctx, application.ID)
}

// saveInviteAndAssociate creates the invitation row and records the association
// with an already existing organization in one transaction.
func (s *Service) saveInviteAndAssociate(ctx context.Context, actorID string, application applicationRecord, orgID, adminRoleID string) (inviteRecord, string, error) {
	now := nowMillis()
	inviteInput := createInviteInput{
		Email:         normalizeEmailAddress(application.Email),
		FirstName:     stringPtr(application.FirstName),
		LastName:      stringPtr(application.LastName),
		PrimaryRoleID: adminRoleID,
		RoleIDs:       []string{adminRoleID},
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return inviteRecord{}, "", err
	}
	defer func() { _ = tx.Rollback() }()
	record, rawToken, err := s.issueInvite(orgID, actorID, inviteInput, inviteInput.RoleIDs, now)
	if err != nil {
		return inviteRecord{}, "", err
	}
	if err := insertInvite(ctx, tx, record); err != nil {
		return inviteRecord{}, "", err
	}
	progress := &applicationApprovalProgress{OrgCreated: true, InviteSaved: true, DeliveryStatus: deliveryStatusNone}
	if err := attachApprovedOrg(ctx, tx, application.ID, orgID, record.ID, encodeApprovalMetadata(progress), now); err != nil {
		return inviteRecord{}, "", err
	}
	if err := tx.Commit(); err != nil {
		return inviteRecord{}, "", err
	}
	return record, rawToken, nil
}

// ResendOrgInvite is the explicit platform-administrator resend for the
// invitation generated by an approved new-organization application. It rotates
// the token and the expiry (only the new hash is stored, so the previous link
// stops working) and delivers the new link. It never runs automatically and it
// refuses an accepted or revoked invitation.
func (s *Service) ResendOrgInvite(ctx context.Context, actorID, applicationID string) (applicationScalar, error) {
	if err := s.assertPlatformAdmin(ctx, actorID); err != nil {
		return applicationScalar{}, err
	}
	application, found, err := loadApplicationByIDTypeAnyStatus(ctx, s.db, applicationID, applicationTypeNewOrg)
	if err != nil {
		return applicationScalar{}, err
	}
	if !found {
		return applicationScalar{}, notFound("Registration application not found")
	}
	if application.Status != applicationStatusApproved {
		return applicationScalar{}, conflict("Only approved applications can resend the invitation")
	}
	if application.GeneratedInviteID == nil {
		return applicationScalar{}, conflict("No invitation has been generated for this application; recover it first")
	}
	invite, found, err := loadInviteByIDAny(ctx, s.db, *application.GeneratedInviteID)
	if err != nil {
		return applicationScalar{}, err
	}
	if !found {
		return applicationScalar{}, conflict("Generated invitation is missing; recover the application first")
	}
	switch invite.Status {
	case inviteStatusAccepted:
		return applicationScalar{}, conflict("Invitation has already been accepted")
	case inviteStatusRevoked:
		return applicationScalar{}, conflict("Invitation has been revoked")
	}
	if err := s.rotateAndDeliver(ctx, application.ID, invite); err != nil {
		return applicationScalar{}, err
	}
	writeAuditBestEffort(ctx, s.db, invite.OrgID, actorID, "registration_application", "resend_org_invite", resendOrgInviteAudit{
		ApplicationID: application.ID,
		InviteID:      invite.ID,
	})
	return s.loadApplicationScalar(ctx, application.ID)
}

// rotateAndDeliver rotates a pending invitation token and sends the new link.
// The conditional UPDATE keeps a concurrent accept or revoke from being
// overwritten.
func (s *Service) rotateAndDeliver(ctx context.Context, applicationID string, invite inviteRecord) error {
	rawToken, tokenHash, err := newInviteToken()
	if err != nil {
		return err
	}
	now := nowMillis()
	expiresAt := now.Add(inviteTTLDays * 24 * time.Hour)
	result, err := s.db.ExecContext(ctx,
		"UPDATE `OrgInvite` SET `tokenHash` = ?, `expiresAt` = ?, `updatedAt` = ? WHERE `id` = ? AND `status` = 'pending'",
		tokenHash, expiresAt, now, invite.ID)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return conflict("Invitation has already been accepted or revoked")
	}
	invite.TokenHash = tokenHash
	invite.ExpiresAt = expiresAt
	invite.UpdatedAt = now
	s.deliverApprovalInvite(ctx, applicationID, invite, rawToken)
	return nil
}

// deliverApprovalInvite sends the invitation email after the database commit and
// records the result. A delivery failure is never turned into a 500 that would
// imply the approval was rolled back; the UI reads the recorded status instead.
func (s *Service) deliverApprovalInvite(ctx context.Context, applicationID string, record inviteRecord, rawToken string) {
	var sendErr error
	relations, err := loadInviteRelations(ctx, s.db, record)
	if err != nil {
		sendErr = err
	} else {
		sendErr = s.sendInviteEmail(ctx, relations, rawToken)
	}
	s.recordDeliveryResult(ctx, applicationID, sendErr)
}

// recordDeliveryResult appends one delivery attempt to the durable progress. A
// failure to persist the attempt is logged and never rewinds the committed
// approval or invitation.
func (s *Service) recordDeliveryResult(ctx context.Context, applicationID string, sendErr error) {
	metadata, found, err := loadApplicationMetadata(ctx, s.db, applicationID)
	if err != nil {
		log.Printf("identityonboarding: read approval progress for application %s: %v", applicationID, err)
		return
	}
	if !found {
		return
	}
	progress := parseApprovalProgress(metadata)
	if progress == nil {
		progress = &applicationApprovalProgress{OrgCreated: true, InviteSaved: true}
	}
	progress.DeliveryAttempts++
	now := nowMillis()
	stamp := now.UTC().Format("2006-01-02T15:04:05.000Z")
	progress.LastDeliveryAt = &stamp
	if sendErr != nil {
		progress.DeliveryStatus = deliveryStatusFailed
		message := sanitizeDeliveryError(sendErr)
		progress.LastDeliveryErr = &message
	} else {
		progress.DeliveryStatus = deliveryStatusSent
		progress.LastDeliveryErr = nil
	}
	if err := updateApplicationMetadata(ctx, s.db, applicationID, encodeApprovalMetadata(progress), now); err != nil {
		log.Printf("identityonboarding: record invitation delivery result for application %s: %v", applicationID, err)
	}
}

// loadApplicationScalar reloads one application and enriches its progress with
// the generated invitation status.
func (s *Service) loadApplicationScalar(ctx context.Context, applicationID string) (applicationScalar, error) {
	application, found, err := loadApplicationByID(ctx, s.db, applicationID)
	if err != nil {
		return applicationScalar{}, err
	}
	if !found {
		return applicationScalar{}, notFound("Registration application not found")
	}
	scalar := application.scalar()
	if scalar.ApprovalProgress != nil && application.GeneratedInviteID != nil {
		invite, found, err := loadInviteByIDAny(ctx, s.db, *application.GeneratedInviteID)
		if err != nil {
			return applicationScalar{}, err
		}
		if found {
			status := string(invite.Status)
			scalar.ApprovalProgress.InviteStatus = &status
		}
	}
	return scalar, nil
}

// orgApplicationRecoveredAudit is written for every recovery binding. It records
// the target organization and the reason the administrator supplied.
type orgApplicationRecoveredAudit struct {
	ApplicationID string `json:"applicationId"`
	TargetOrgID   string `json:"targetOrgId"`
	InviteID      string `json:"inviteId,omitempty"`
	Action        string `json:"action"`
	Reason        string `json:"reason,omitempty"`
}

// resendOrgInviteAudit is written for an explicit platform-administrator resend.
type resendOrgInviteAudit struct {
	ApplicationID string `json:"applicationId"`
	InviteID      string `json:"inviteId"`
}

// stringOrEmpty dereferences an optional request field.
func stringOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return jsTrim(*value)
}

// injectApprovalFault is a test-only seam. It is always nil in production; the
// integration test sets it to prove the multi-step approval transaction rolls
// back at each database stage without leaving an organization or invitation.
var injectApprovalFault = func(stage string) error { return nil }

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
