package identityonboarding

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// ListInvites mirrors OrgInviteService.listInvites: the caller's organization
// membership and users.write are re-checked here, then every invitation of the
// organization is returned, newest first, with its primary role.
func (s *Service) ListInvites(ctx context.Context, orgID, actorID string) ([]inviteWithPrimaryRole, error) {
	if err := s.assertOrgAdmin(ctx, orgID, actorID); err != nil {
		return nil, err
	}
	return loadInvitesForOrg(ctx, s.db, orgID)
}

// CreateInvite is the ordinary invitation path. It refuses the system
// administrator role and any role outside the caller's own permission scope; the
// controlled new-organization approval is the only caller allowed to skip that
// check, and it does so through a separate method that is not reachable from a
// request.
func (s *Service) CreateInvite(ctx context.Context, orgID, actorID string, input createInviteInput) (inviteWithOrgAndPrimaryRole, error) {
	if err := s.assertOrgAdmin(ctx, orgID, actorID); err != nil {
		return inviteWithOrgAndPrimaryRole{}, err
	}
	roleIDs := normalizeRoleIDs(input.RoleIDs, input.PrimaryRoleID)
	if err := s.ensureRoleSet(ctx, orgID, input.PrimaryRoleID, roleIDs); err != nil {
		return inviteWithOrgAndPrimaryRole{}, err
	}
	if err := s.assertRolesAssignable(ctx, actorID, orgID, roleIDs); err != nil {
		return inviteWithOrgAndPrimaryRole{}, err
	}
	return s.insertAndDeliverInvite(ctx, orgID, actorID, input, roleIDs, nowMillis())
}

// insertAndDeliverInvite is the shared create tail: row, real email, audit. The
// row is committed before the message is sent, so a delivery failure keeps the
// invitation stored and returns the error instead of claiming a rollback.
func (s *Service) insertAndDeliverInvite(ctx context.Context, orgID, actorID string, input createInviteInput, roleIDs []string, now time.Time) (inviteWithOrgAndPrimaryRole, error) {
	input.Email = normalizeEmailAddress(input.Email)
	record, rawToken, err := s.issueInvite(orgID, actorID, input, roleIDs, now)
	if err != nil {
		return inviteWithOrgAndPrimaryRole{}, err
	}
	if err := insertInvite(ctx, s.db, record); err != nil {
		return inviteWithOrgAndPrimaryRole{}, err
	}
	relations, err := loadInviteRelations(ctx, s.db, record)
	if err != nil {
		return inviteWithOrgAndPrimaryRole{}, err
	}
	if err := s.sendInviteEmail(ctx, relations, rawToken); err != nil {
		return inviteWithOrgAndPrimaryRole{}, err
	}
	writeAuditBestEffort(ctx, s.db, orgID, actorID, "users", "invite_create", inviteCreateAudit{
		InviteID:      record.ID,
		Email:         record.Email,
		PrimaryRoleID: input.PrimaryRoleID,
		RoleIDs:       roleIDs,
	})
	return inviteWithOrgAndPrimaryRole{
		inviteScalar: record.scalar(),
		Org:          relations.org.view(),
		PrimaryRole:  relations.role.view(),
	}, nil
}

// ResendInvite replaces the token and the expiry of a pending invitation. An
// expired invitation that is still pending can be resent; the previous link stops
// working because only the new hash is stored.
func (s *Service) ResendInvite(ctx context.Context, orgID, actorID, inviteID string) (inviteWithOrgAndPrimaryRole, error) {
	if err := s.assertOrgAdmin(ctx, orgID, actorID); err != nil {
		return inviteWithOrgAndPrimaryRole{}, err
	}
	invite, found, err := loadInviteByIDOrg(ctx, s.db, orgID, inviteID)
	if err != nil {
		return inviteWithOrgAndPrimaryRole{}, err
	}
	if !found {
		return inviteWithOrgAndPrimaryRole{}, notFound("Invite not found")
	}
	if invite.Status != inviteStatusPending {
		return inviteWithOrgAndPrimaryRole{}, badRequest("Only pending invites can be resent")
	}

	rawToken, tokenHash, err := newInviteToken()
	if err != nil {
		return inviteWithOrgAndPrimaryRole{}, err
	}
	now := nowMillis()
	expiresAt := now.Add(inviteTTLDays * 24 * time.Hour)
	if _, err := s.db.ExecContext(ctx,
		"UPDATE `OrgInvite` SET `tokenHash` = ?, `expiresAt` = ?, `updatedAt` = ? WHERE `id` = ?",
		tokenHash, expiresAt, now, invite.ID); err != nil {
		return inviteWithOrgAndPrimaryRole{}, err
	}
	invite.TokenHash = tokenHash
	invite.ExpiresAt = expiresAt
	invite.UpdatedAt = now

	relations, err := loadInviteRelations(ctx, s.db, invite)
	if err != nil {
		return inviteWithOrgAndPrimaryRole{}, err
	}
	if err := s.sendInviteEmail(ctx, relations, rawToken); err != nil {
		return inviteWithOrgAndPrimaryRole{}, err
	}
	writeAuditBestEffort(ctx, s.db, orgID, actorID, "users", "invite_resend", inviteResendAudit{
		InviteID: invite.ID,
		Email:    invite.Email,
	})
	return inviteWithOrgAndPrimaryRole{
		inviteScalar: invite.scalar(),
		Org:          relations.org.view(),
		PrimaryRole:  relations.role.view(),
	}, nil
}

// RevokeInvite marks an invitation revoked. The source does not require the
// pending status and does not delete an existing membership, so neither does
// this implementation.
func (s *Service) RevokeInvite(ctx context.Context, orgID, actorID, inviteID string) (inviteScalar, error) {
	if err := s.assertOrgAdmin(ctx, orgID, actorID); err != nil {
		return inviteScalar{}, err
	}
	invite, found, err := loadInviteByIDOrg(ctx, s.db, orgID, inviteID)
	if err != nil {
		return inviteScalar{}, err
	}
	if !found {
		return inviteScalar{}, notFound("Invite not found")
	}
	now := nowMillis()
	if _, err := s.db.ExecContext(ctx,
		"UPDATE `OrgInvite` SET `status` = 'revoked', `revokedAt` = ?, `updatedAt` = ? WHERE `id` = ?",
		now, now, invite.ID); err != nil {
		return inviteScalar{}, err
	}
	invite.Status = inviteStatusRevoked
	invite.RevokedAt = &now
	invite.UpdatedAt = now

	writeAuditBestEffort(ctx, s.db, orgID, actorID, "users", "invite_revoke", inviteRevokeAudit{
		InviteID: invite.ID,
		Email:    invite.Email,
	})
	return invite.scalar(), nil
}

// GetInviteByToken is the public preview. It validates the hash, the pending
// status, the expiry and the organization state, then returns the four
// non-sensitive relations.
func (s *Service) GetInviteByToken(ctx context.Context, token string) (invitePreview, error) {
	relations, err := s.findInviteByToken(ctx, token)
	if err != nil {
		return invitePreview{}, err
	}
	return invitePreview{
		ID:          relations.invite.ID,
		Email:       relations.invite.Email,
		FirstName:   relations.invite.FirstName,
		LastName:    relations.invite.LastName,
		Org:         previewOrg{ID: relations.org.ID, Name: relations.org.Name, Slug: relations.org.Slug},
		PrimaryRole: previewRole{ID: relations.role.ID, Name: relations.role.Name},
		ExpiresAt:   stamp(relations.invite.ExpiresAt),
		Status:      string(relations.invite.Status),
	}, nil
}

// findInviteByToken mirrors OrgInviteService.findInviteByToken: the token is
// trimmed before hashing, and the four checks keep their original order and
// messages.
func (s *Service) findInviteByToken(ctx context.Context, token string) (inviteWithRelations, error) {
	invite, found, err := loadInviteByTokenHash(ctx, s.db, hashOpaqueToken(jsTrim(token)))
	if err != nil {
		return inviteWithRelations{}, err
	}
	if !found {
		return inviteWithRelations{}, notFound("Invite not found")
	}
	if invite.Status != inviteStatusPending {
		return inviteWithRelations{}, unauthorized("Invite is no longer valid")
	}
	if invite.ExpiresAt.Before(time.Now()) {
		return inviteWithRelations{}, unauthorized("Invite is no longer valid")
	}
	org, found, err := loadOrgByID(ctx, s.db, invite.OrgID)
	if err != nil {
		return inviteWithRelations{}, err
	}
	if !found {
		return inviteWithRelations{}, notFound("Invite not found")
	}
	if !org.IsActive {
		return inviteWithRelations{}, unauthorized("Invite organization is disabled")
	}
	role, found, err := loadRoleByIDOrg(ctx, s.db, invite.OrgID, invite.PrimaryRoleID)
	if err != nil {
		return inviteWithRelations{}, err
	}
	if !found {
		return inviteWithRelations{}, badRequest("One or more roles are invalid")
	}
	return inviteWithRelations{invite: invite, org: org, role: role}, nil
}

// acceptInviteParams is the two accept entry points merged, exactly like the
// single service method the NestJS controller calls.
type acceptInviteParams struct {
	Token         string
	CurrentUserID string
	Password      *string
	FirstName     *string
	LastName      *string
}

// AcceptInvite consumes the invitation once. It never issues a session: the
// response is the membership plus its organization, and the web client signs in
// through the already migrated login chain.
func (s *Service) AcceptInvite(ctx context.Context, params acceptInviteParams) (membershipWithOrg, error) {
	relations, err := s.findInviteByToken(ctx, params.Token)
	if err != nil {
		return membershipWithOrg{}, err
	}
	invite := relations.invite
	roleIDs := readRoleIDs(invite.RoleIDs, invite.PrimaryRoleID)
	if err := s.ensureRoleSet(ctx, invite.OrgID, invite.PrimaryRoleID, roleIDs); err != nil {
		return membershipWithOrg{}, err
	}

	userID, err := s.resolveAcceptUser(ctx, invite, params)
	if err != nil {
		return membershipWithOrg{}, err
	}
	membership, err := s.acceptInTransaction(ctx, invite, relations.org, userID, roleIDs)
	if err != nil {
		return membershipWithOrg{}, err
	}
	s.invalidateProfileCache(ctx, userID, invite.OrgID)
	return membership, nil
}

// resolveAcceptUser mirrors the identity branch of OrgInviteService.acceptInvite.
// An authenticated caller must own the invited address; an anonymous caller may
// only continue when the address has no account yet, and the created account is
// never marked email-verified by the possession of the link alone.
func (s *Service) resolveAcceptUser(ctx context.Context, invite inviteRecord, params acceptInviteParams) (string, error) {
	if params.CurrentUserID != "" {
		user, found, err := loadUserByID(ctx, s.db, params.CurrentUserID)
		if err != nil {
			return "", err
		}
		if !found || normalizeEmailAddress(user.Email) != invite.Email {
			return "", forbidden("Signed-in user does not match invite email")
		}
		return user.ID, nil
	}

	if _, _, found, err := loadUserByEmail(ctx, s.db, invite.Email); err != nil {
		return "", err
	} else if found {
		return "", forbidden("Please sign in with the invited email to accept this invite")
	}

	password := ""
	if params.Password != nil {
		password = jsTrim(*params.Password)
	}
	firstName := ""
	if params.FirstName != nil {
		firstName = jsTrim(*params.FirstName)
	} else if invite.FirstName != nil {
		firstName = *invite.FirstName
	}
	lastName := ""
	if params.LastName != nil {
		lastName = jsTrim(*params.LastName)
	} else if invite.LastName != nil {
		lastName = *invite.LastName
	}
	if jsLength(password) < 8 {
		return "", badRequest("Password must be at least 8 characters")
	}
	if firstName == "" || lastName == "" {
		return "", badRequest("First and last name are required")
	}

	passwordHash, err := hashLoginPassword(password)
	if err != nil {
		return "", err
	}
	userID, err := newRowID()
	if err != nil {
		return "", err
	}
	now := nowMillis()
	// emailVerified stays NULL: the invite link may have been forwarded, so it
	// cannot prove ownership of the address.
	if _, err := s.db.ExecContext(ctx,
		"INSERT INTO `User` (`id`, `email`, `passwordHash`, `firstName`, `lastName`, `isActive`, `createdAt`, `updatedAt`) "+
			"VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
		userID, invite.Email, passwordHash, firstName, lastName, now, now); err != nil {
		return "", err
	}
	return userID, nil
}

// acceptInTransaction claims the invitation and writes the membership in one
// transaction. The conditional claim is the first statement: without it two
// concurrent accepts could both pass the earlier pending check and each create a
// membership.
func (s *Service) acceptInTransaction(ctx context.Context, invite inviteRecord, org orgRecord, userID string, roleIDs []string) (membershipWithOrg, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return membershipWithOrg{}, err
	}
	defer func() { _ = tx.Rollback() }()

	now := nowMillis()
	claimed, err := claimInvite(ctx, tx, invite.ID, userID, now)
	if err != nil {
		return membershipWithOrg{}, err
	}
	if !claimed {
		return membershipWithOrg{}, conflict("Invitation has already been accepted or revoked")
	}

	var membershipID string
	var membershipCreatedAt time.Time
	err = tx.QueryRowContext(ctx,
		"SELECT `id`, `createdAt` FROM `Membership` WHERE `userId` = ? AND `orgId` = ? LIMIT 1", userID, invite.OrgID).
		Scan(&membershipID, &membershipCreatedAt)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		membershipID, err = newRowID()
		if err != nil {
			return membershipWithOrg{}, err
		}
		membershipCreatedAt = now
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO `Membership` (`id`, `userId`, `orgId`, `roleId`, `isActive`, `createdAt`) VALUES (?, ?, ?, ?, 1, ?)",
			membershipID, userID, invite.OrgID, invite.PrimaryRoleID, now); err != nil {
			return membershipWithOrg{}, err
		}
	case err != nil:
		return membershipWithOrg{}, err
	default:
		// An existing membership is reactivated and its primary role replaced;
		// "already a member" is not a reason to skip the grant.
		if _, err := tx.ExecContext(ctx,
			"UPDATE `Membership` SET `roleId` = ?, `isActive` = 1 WHERE `id` = ?",
			invite.PrimaryRoleID, membershipID); err != nil {
			return membershipWithOrg{}, err
		}
	}

	if _, err := tx.ExecContext(ctx, "DELETE FROM `MembershipRole` WHERE `membershipId` = ?", membershipID); err != nil {
		return membershipWithOrg{}, err
	}
	for _, roleID := range roleIDs {
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO `MembershipRole` (`membershipId`, `orgId`, `roleId`, `createdAt`) VALUES (?, ?, ?, ?)",
			membershipID, invite.OrgID, roleID, now); err != nil {
			return membershipWithOrg{}, err
		}
	}

	if err := tx.Commit(); err != nil {
		return membershipWithOrg{}, err
	}
	return membershipWithOrg{
		ID:        membershipID,
		UserID:    userID,
		OrgID:     invite.OrgID,
		RoleID:    invite.PrimaryRoleID,
		IsActive:  true,
		CreatedAt: stamp(membershipCreatedAt),
		Org:       org.view(),
	}, nil
}
