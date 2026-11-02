package identityonboarding

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// inviteColumns is the OrgInvite scalar selection, in model order.
const inviteColumns = "`id`, `orgId`, `email`, `firstName`, `lastName`, `primaryRoleId`, `roleIds`, " +
	"`invitedById`, `acceptedById`, `tokenHash`, `status`, `expiresAt`, `acceptedAt`, `revokedAt`, " +
	"`metadata`, `createdAt`, `updatedAt`"

func scanInvite(scanner interface{ Scan(dest ...any) error }) (inviteRecord, error) {
	var invite inviteRecord
	var firstName, lastName, invitedByID, acceptedByID sql.NullString
	var acceptedAt, revokedAt sql.NullTime
	var roleIDs, metadata []byte
	var status string
	if err := scanner.Scan(&invite.ID, &invite.OrgID, &invite.Email, &firstName, &lastName,
		&invite.PrimaryRoleID, &roleIDs, &invitedByID, &acceptedByID, &invite.TokenHash, &status,
		&invite.ExpiresAt, &acceptedAt, &revokedAt, &metadata, &invite.CreatedAt, &invite.UpdatedAt); err != nil {
		return inviteRecord{}, err
	}
	invite.FirstName = stringOrNil(firstName)
	invite.LastName = stringOrNil(lastName)
	invite.InvitedByID = stringOrNil(invitedByID)
	invite.AcceptedByID = stringOrNil(acceptedByID)
	invite.Status = inviteStatus(status)
	invite.AcceptedAt = timeOrNil(acceptedAt)
	invite.RevokedAt = timeOrNil(revokedAt)
	if len(roleIDs) > 0 {
		invite.RoleIDs = append([]byte(nil), roleIDs...)
	}
	if len(metadata) > 0 {
		invite.Metadata = append([]byte(nil), metadata...)
	}
	return invite, nil
}

func loadInviteByIDOrg(ctx context.Context, q dbtx, orgID, inviteID string) (inviteRecord, bool, error) {
	invite, err := scanInvite(q.QueryRowContext(ctx,
		"SELECT "+inviteColumns+" FROM `OrgInvite` WHERE `id` = ? AND `orgId` = ? LIMIT 1", inviteID, orgID))
	if errors.Is(err, sql.ErrNoRows) {
		return inviteRecord{}, false, nil
	}
	if err != nil {
		return inviteRecord{}, false, err
	}
	return invite, true, nil
}

// loadInviteByIDAny reads an invitation by id without an organization
// predicate. The approval recovery path is platform scoped and derives the
// organization from the invitation row itself.
func loadInviteByIDAny(ctx context.Context, q dbtx, inviteID string) (inviteRecord, bool, error) {
	invite, err := scanInvite(q.QueryRowContext(ctx,
		"SELECT "+inviteColumns+" FROM `OrgInvite` WHERE `id` = ? LIMIT 1", inviteID))
	if errors.Is(err, sql.ErrNoRows) {
		return inviteRecord{}, false, nil
	}
	if err != nil {
		return inviteRecord{}, false, err
	}
	return invite, true, nil
}

// loadInvitesByIDs batches invitation lookups for the platform application list
// so the progress projection never issues one query per generated invite.
func loadInvitesByIDs(ctx context.Context, q dbtx, ids []string) (map[string]inviteRecord, error) {
	out := make(map[string]inviteRecord, len(ids))
	unique := sortedUniqueStrings(ids)
	if len(unique) == 0 {
		return out, nil
	}
	query := "SELECT " + inviteColumns + " FROM `OrgInvite` WHERE `id` IN (" + placeholders(len(unique)) + ")"
	rows, err := q.QueryContext(ctx, query, argsOf(unique)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		invite, err := scanInvite(rows)
		if err != nil {
			return nil, err
		}
		out[invite.ID] = invite
	}
	return out, rows.Err()
}

func loadInviteByTokenHash(ctx context.Context, q dbtx, tokenHash string) (inviteRecord, bool, error) {
	invite, err := scanInvite(q.QueryRowContext(ctx,
		"SELECT "+inviteColumns+" FROM `OrgInvite` WHERE `tokenHash` = ? LIMIT 1", tokenHash))
	if errors.Is(err, sql.ErrNoRows) {
		return inviteRecord{}, false, nil
	}
	if err != nil {
		return inviteRecord{}, false, err
	}
	return invite, true, nil
}

// insertInvite writes one pending invitation. The caller supplies the id, the
// hashed token and the expiry; the raw token never reaches this layer.
func insertInvite(ctx context.Context, exec dbtx, invite inviteRecord) error {
	_, err := exec.ExecContext(ctx,
		"INSERT INTO `OrgInvite` (`id`, `orgId`, `email`, `firstName`, `lastName`, `primaryRoleId`, "+
			"`roleIds`, `invitedById`, `tokenHash`, `status`, `expiresAt`, `createdAt`, `updatedAt`) "+
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
		invite.ID, invite.OrgID, invite.Email, nullableString(invite.FirstName), nullableString(invite.LastName),
		invite.PrimaryRoleID, string(invite.RoleIDs), nullableString(invite.InvitedByID), invite.TokenHash,
		invite.ExpiresAt, invite.CreatedAt, invite.UpdatedAt)
	return err
}

// inviteWithRelations reloads an invitation with the org and primaryRole the
// create/resend response and the invitation email need.
type inviteWithRelations struct {
	invite inviteRecord
	org    orgRecord
	role   roleRecord
}

func loadInviteRelations(ctx context.Context, q dbtx, invite inviteRecord) (inviteWithRelations, error) {
	org, found, err := loadOrgByID(ctx, q, invite.OrgID)
	if err != nil {
		return inviteWithRelations{}, err
	}
	if !found {
		return inviteWithRelations{}, errNoDatabase
	}
	role, found, err := loadRoleByIDOrg(ctx, q, invite.OrgID, invite.PrimaryRoleID)
	if err != nil {
		return inviteWithRelations{}, err
	}
	if !found {
		return inviteWithRelations{}, errNoDatabase
	}
	return inviteWithRelations{invite: invite, org: org, role: role}, nil
}

// loadInvitesForOrg reads the organization's invitations, newest first, with the
// primary role of each. The roles are fetched in one batch so a long list never
// issues one query per invitation.
func loadInvitesForOrg(ctx context.Context, q dbtx, orgID string) ([]inviteWithPrimaryRole, error) {
	rows, err := q.QueryContext(ctx,
		"SELECT "+inviteColumns+" FROM `OrgInvite` WHERE `orgId` = ? ORDER BY `createdAt` DESC", orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	invites := make([]inviteRecord, 0, 8)
	roleIDs := make([]string, 0, 8)
	for rows.Next() {
		invite, err := scanInvite(rows)
		if err != nil {
			return nil, err
		}
		invites = append(invites, invite)
		roleIDs = append(roleIDs, invite.PrimaryRoleID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	roles := make(map[string]roleRecord, len(roleIDs))
	if len(roleIDs) > 0 {
		records, err := loadRolesInOrg(ctx, q, orgID, roleIDs)
		if err != nil {
			return nil, err
		}
		for _, role := range records {
			roles[role.ID] = role
		}
	}
	out := make([]inviteWithPrimaryRole, 0, len(invites))
	for _, invite := range invites {
		role, ok := roles[invite.PrimaryRoleID]
		if !ok {
			// A dangling primaryRole cannot appear: the foreign key is
			// (id, orgId) with onDelete Restrict. Skip instead of inventing a
			// zero relation.
			continue
		}
		out = append(out, inviteWithPrimaryRole{inviteScalar: invite.scalar(), PrimaryRole: role.view()})
	}
	return out, nil
}

// claimInvite transitions one pending invitation to accepted and reports whether
// this request won the single-use claim.
func claimInvite(ctx context.Context, tx dbtx, inviteID, userID string, now time.Time) (bool, error) {
	result, err := tx.ExecContext(ctx,
		"UPDATE `OrgInvite` SET `status` = 'accepted', `acceptedAt` = ?, `acceptedById` = ?, `updatedAt` = ? "+
			"WHERE `id` = ? AND `status` = 'pending'",
		now, userID, now, inviteID)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return affected == 1, nil
}
