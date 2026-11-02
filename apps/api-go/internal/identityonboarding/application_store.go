package identityonboarding

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// applicationColumns is the RegistrationApplication scalar selection.
const applicationColumns = "`id`, `type`, `status`, `email`, `firstName`, `lastName`, `orgId`, " +
	"`requestedOrgName`, `requestedOrgSlug`, `requestedDescription`, `decisionReason`, " +
	"`generatedInviteId`, `reviewedById`, `reviewedAt`, `metadata`, `createdAt`, `updatedAt`"

func scanApplication(scanner interface{ Scan(dest ...any) error }) (applicationRecord, error) {
	var application applicationRecord
	var applicationTypeValue, status string
	var orgID, requestedOrgName, requestedOrgSlug, requestedDescription sql.NullString
	var decisionReason, generatedInviteID, reviewedByID sql.NullString
	var reviewedAt sql.NullTime
	var metadata []byte
	if err := scanner.Scan(&application.ID, &applicationTypeValue, &status, &application.Email,
		&application.FirstName, &application.LastName, &orgID, &requestedOrgName, &requestedOrgSlug,
		&requestedDescription, &decisionReason, &generatedInviteID, &reviewedByID, &reviewedAt,
		&metadata, &application.CreatedAt, &application.UpdatedAt); err != nil {
		return applicationRecord{}, err
	}
	application.Type = applicationType(applicationTypeValue)
	application.Status = applicationStatus(status)
	application.OrgID = stringOrNil(orgID)
	application.RequestedOrgName = stringOrNil(requestedOrgName)
	application.RequestedOrgSlug = stringOrNil(requestedOrgSlug)
	application.RequestedDescription = stringOrNil(requestedDescription)
	application.DecisionReason = stringOrNil(decisionReason)
	application.GeneratedInviteID = stringOrNil(generatedInviteID)
	application.ReviewedByID = stringOrNil(reviewedByID)
	application.ReviewedAt = timeOrNil(reviewedAt)
	if len(metadata) > 0 {
		application.Metadata = append([]byte(nil), metadata...)
	}
	return application, nil
}

// loadApplicationByIDOrgType reads a pending application inside one
// organization and type, matching findFirst(id, orgId, type, status:"pending").
func loadApplicationByIDOrgType(ctx context.Context, q dbtx, applicationID, orgID string, applicationType applicationType) (applicationRecord, bool, error) {
	application, err := scanApplication(q.QueryRowContext(ctx,
		"SELECT "+applicationColumns+" FROM `RegistrationApplication` "+
			"WHERE `id` = ? AND `orgId` = ? AND `type` = ? AND `status` = 'pending' LIMIT 1",
		applicationID, orgID, string(applicationType)))
	if errors.Is(err, sql.ErrNoRows) {
		return applicationRecord{}, false, nil
	}
	if err != nil {
		return applicationRecord{}, false, err
	}
	return application, true, nil
}

// loadApplicationByIDType reads a pending application of one type regardless of
// organization (the new-organization path is platform scoped).
func loadApplicationByIDType(ctx context.Context, q dbtx, applicationID string, applicationType applicationType) (applicationRecord, bool, error) {
	application, err := scanApplication(q.QueryRowContext(ctx,
		"SELECT "+applicationColumns+" FROM `RegistrationApplication` "+
			"WHERE `id` = ? AND `type` = ? AND `status` = 'pending' LIMIT 1",
		applicationID, string(applicationType)))
	if errors.Is(err, sql.ErrNoRows) {
		return applicationRecord{}, false, nil
	}
	if err != nil {
		return applicationRecord{}, false, err
	}
	return application, true, nil
}

// loadApplicationByID reads the application after a write, without a status
// filter, matching the final findUnique.
func loadApplicationByID(ctx context.Context, q dbtx, applicationID string) (applicationRecord, bool, error) {
	application, err := scanApplication(q.QueryRowContext(ctx,
		"SELECT "+applicationColumns+" FROM `RegistrationApplication` WHERE `id` = ? LIMIT 1", applicationID))
	if errors.Is(err, sql.ErrNoRows) {
		return applicationRecord{}, false, nil
	}
	if err != nil {
		return applicationRecord{}, false, err
	}
	return application, true, nil
}

// loadApplicationByIDTypeAnyStatus reads an application of one type without a
// status filter. The approval and recovery paths need to see an already approved
// row to resume it, so they must not reuse the pending-only loader.
func loadApplicationByIDTypeAnyStatus(ctx context.Context, q dbtx, applicationID string, applicationType applicationType) (applicationRecord, bool, error) {
	application, err := scanApplication(q.QueryRowContext(ctx,
		"SELECT "+applicationColumns+" FROM `RegistrationApplication` "+
			"WHERE `id` = ? AND `type` = ? LIMIT 1",
		applicationID, string(applicationType)))
	if errors.Is(err, sql.ErrNoRows) {
		return applicationRecord{}, false, nil
	}
	if err != nil {
		return applicationRecord{}, false, err
	}
	return application, true, nil
}

// loadApplicationMetadata reads only the metadata leaf; the delivery-result
// recorder needs the current document to append an attempt.
func loadApplicationMetadata(ctx context.Context, q dbtx, applicationID string) (json.RawMessage, bool, error) {
	var metadata []byte
	err := q.QueryRowContext(ctx,
		"SELECT `metadata` FROM `RegistrationApplication` WHERE `id` = ? LIMIT 1", applicationID).Scan(&metadata)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if len(metadata) == 0 {
		return nil, true, nil
	}
	return append(json.RawMessage(nil), metadata...), true, nil
}

// attachApprovedOrg records the application → organization → invitation
// association and the initial progress document. It only touches an approved
// application that still has no generated invite, so a concurrent rejection or a
// second concurrent completion can never overwrite the first result. It runs in
// the same transaction that created the organization and the invitation.
func attachApprovedOrg(ctx context.Context, exec dbtx, applicationID, orgID, inviteID string, metadata json.RawMessage, now time.Time) error {
	result, err := exec.ExecContext(ctx,
		"UPDATE `RegistrationApplication` SET `orgId` = ?, `generatedInviteId` = ?, `metadata` = ?, "+
			"`updatedAt` = ? WHERE `id` = ? AND `status` = 'approved' AND `generatedInviteId` IS NULL",
		orgID, inviteID, metadata, now, applicationID)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return conflict("Registration application was already completed by another request")
	}
	return nil
}

// setApplicationOrgAssociation heals a historical row that already has a
// generated invitation but no recorded organization. The invitation is the
// trusted link, so only orgId and the progress document change. The orgId IS
// NULL predicate keeps a concurrent heal idempotent.
func setApplicationOrgAssociation(ctx context.Context, exec dbtx, applicationID, orgID string, metadata json.RawMessage, now time.Time) error {
	result, err := exec.ExecContext(ctx,
		"UPDATE `RegistrationApplication` SET `orgId` = ?, `metadata` = ?, `updatedAt` = ? "+
			"WHERE `id` = ? AND `status` = 'approved' AND `orgId` IS NULL",
		orgID, metadata, now, applicationID)
	if err != nil {
		return err
	}
	if _, err := result.RowsAffected(); err != nil {
		return err
	}
	// A zero affected count means another request already healed the row; the
	// desired end state (orgId recorded) is reached either way, so it is not an
	// error.
	return nil
}

// updateApplicationMetadata persists a refreshed progress document. Delivery
// recording uses it after the commit; a failure here never rewinds the already
// committed organization or invitation.
func updateApplicationMetadata(ctx context.Context, exec dbtx, applicationID string, metadata json.RawMessage, now time.Time) error {
	_, err := exec.ExecContext(ctx,
		"UPDATE `RegistrationApplication` SET `metadata` = ?, `updatedAt` = ? WHERE `id` = ?",
		metadata, now, applicationID)
	return err
}

func insertApplication(ctx context.Context, q dbtx, application applicationRecord) error {
	_, err := q.ExecContext(ctx,
		"INSERT INTO `RegistrationApplication` (`id`, `type`, `status`, `email`, `firstName`, `lastName`, "+
			"`orgId`, `requestedOrgName`, `requestedOrgSlug`, `requestedDescription`, `createdAt`, `updatedAt`) "+
			"VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		application.ID, string(application.Type), application.Email, application.FirstName,
		application.LastName, nullableString(application.OrgID), nullableString(application.RequestedOrgName),
		nullableString(application.RequestedOrgSlug), nullableString(application.RequestedDescription),
		application.CreatedAt, application.UpdatedAt)
	return err
}

// claimApplication transitions one pending application to approved and reports
// whether this request won the claim. It is the only conditional update: the
// pending read happened outside the statement, so a loser must be told 409.
func claimApplication(ctx context.Context, exec dbtx, applicationID, actorID string, now time.Time) (bool, error) {
	result, err := exec.ExecContext(ctx,
		"UPDATE `RegistrationApplication` SET `status` = 'approved', `reviewedById` = ?, "+
			"`reviewedAt` = ?, `updatedAt` = ? WHERE `id` = ? AND `status` = 'pending'",
		actorID, now, now, applicationID)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return affected == 1, nil
}

// releaseApplicationClaim is the compensation used when the organization or the
// invite could not be created: only an approved application that has no
// generated invite returns to pending. The failure of the compensation itself is
// swallowed, exactly like the source `.catch(() => undefined)`.
func releaseApplicationClaim(ctx context.Context, exec dbtx, applicationID string, now time.Time) {
	_, _ = exec.ExecContext(ctx,
		"UPDATE `RegistrationApplication` SET `status` = 'pending', `updatedAt` = ? "+
			"WHERE `id` = ? AND `status` = 'approved' AND `generatedInviteId` IS NULL",
		now, applicationID)
}

func linkGeneratedInvite(ctx context.Context, exec dbtx, applicationID, inviteID string, now time.Time) error {
	_, err := exec.ExecContext(ctx,
		"UPDATE `RegistrationApplication` SET `generatedInviteId` = ?, `updatedAt` = ? WHERE `id` = ?",
		inviteID, now, applicationID)
	return err
}

// rejectApplication writes the rejection decision. The source reads the pending
// row first and then updates by id, so the update carries no status predicate.
func rejectApplication(ctx context.Context, exec dbtx, applicationID, actorID string, reason *string, now time.Time) error {
	_, err := exec.ExecContext(ctx,
		"UPDATE `RegistrationApplication` SET `status` = 'rejected', `decisionReason` = ?, "+
			"`reviewedById` = ?, `reviewedAt` = ?, `updatedAt` = ? WHERE `id` = ?",
		nullableString(reason), actorID, now, now, applicationID)
	return err
}

// loadOrgApplications reads the organization's join_org applications, newest
// first, and batches both the org and the reviewer relations.
func loadOrgApplications(ctx context.Context, q dbtx, orgID string) ([]applicationWithOrgAndReviewer, error) {
	rows, err := q.QueryContext(ctx,
		"SELECT "+applicationColumns+" FROM `RegistrationApplication` "+
			"WHERE `orgId` = ? AND `type` = 'join_org' ORDER BY `createdAt` DESC", orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	applications := make([]applicationRecord, 0, 8)
	for rows.Next() {
		application, err := scanApplication(rows)
		if err != nil {
			return nil, err
		}
		applications = append(applications, application)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	orgs, err := loadOrgsByIDs(ctx, q, []string{orgID})
	if err != nil {
		return nil, err
	}
	reviewerIDs := make([]string, 0, len(applications))
	for _, application := range applications {
		if application.ReviewedByID != nil {
			reviewerIDs = append(reviewerIDs, *application.ReviewedByID)
		}
	}
	reviewers, err := loadUsersByIDs(ctx, q, reviewerIDs)
	if err != nil {
		return nil, err
	}
	out := make([]applicationWithOrgAndReviewer, 0, len(applications))
	for _, application := range applications {
		item := applicationWithOrgAndReviewer{applicationScalar: application.scalar()}
		if org, ok := orgs[orgID]; ok {
			view := org.view()
			item.Org = &view
		}
		if application.ReviewedByID != nil {
			if reviewer, ok := reviewers[*application.ReviewedByID]; ok {
				item.ReviewedBy = reviewer.view()
			}
		}
		out = append(out, item)
	}
	return out, nil
}

// loadPlatformApplications reads every new_org application, newest first, with
// the reviewer relation only.
func loadPlatformApplications(ctx context.Context, q dbtx) ([]applicationWithReviewer, error) {
	rows, err := q.QueryContext(ctx,
		"SELECT "+applicationColumns+" FROM `RegistrationApplication` "+
			"WHERE `type` = 'new_org' ORDER BY `createdAt` DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	applications := make([]applicationRecord, 0, 8)
	for rows.Next() {
		application, err := scanApplication(rows)
		if err != nil {
			return nil, err
		}
		applications = append(applications, application)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	reviewerIDs := make([]string, 0, len(applications))
	inviteIDs := make([]string, 0, len(applications))
	for _, application := range applications {
		if application.ReviewedByID != nil {
			reviewerIDs = append(reviewerIDs, *application.ReviewedByID)
		}
		if application.GeneratedInviteID != nil {
			inviteIDs = append(inviteIDs, *application.GeneratedInviteID)
		}
	}
	reviewers, err := loadUsersByIDs(ctx, q, reviewerIDs)
	if err != nil {
		return nil, err
	}
	invites, err := loadInvitesByIDs(ctx, q, inviteIDs)
	if err != nil {
		return nil, err
	}
	out := make([]applicationWithReviewer, 0, len(applications))
	for _, application := range applications {
		item := applicationWithReviewer{applicationScalar: application.scalar()}
		if application.GeneratedInviteID != nil && item.ApprovalProgress != nil {
			if invite, ok := invites[*application.GeneratedInviteID]; ok {
				status := string(invite.Status)
				item.ApprovalProgress.InviteStatus = &status
			}
		}
		if application.ReviewedByID != nil {
			if reviewer, ok := reviewers[*application.ReviewedByID]; ok {
				item.ReviewedBy = reviewer.view()
			}
		}
		out = append(out, item)
	}
	return out, nil
}
