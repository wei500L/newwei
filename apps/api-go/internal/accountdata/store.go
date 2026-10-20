package accountdata

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

// jsDateLayout is the exact `new Date().toISOString()` member layout
// (millisecond precision, UTC, trailing Z).
const jsDateLayout = "2006-01-02T15:04:05.000Z"

// smallSections holds the parts NestJS loads with small, bounded queries. The
// potentially large arrays are streamed separately by the writer.
type smallSections struct {
	account              *exportAccount
	membership           *exportMembership
	userSettings         []exportUserSetting
	contentSubscriptions []exportContentSubscription
	newsBehavior         exportNewsBehavior
	digest               exportDigest
}

// loadSmall runs the bounded reads concurrently. A failure of any dependency
// aborts the export before a single body byte is written.
func (s *Service) loadSmall(ctx context.Context, orgID, userID string) (*smallSections, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("accountdata: mysql is not configured")
	}
	if s.behavior == nil {
		return nil, errors.New("accountdata: news behavior reader is not configured")
	}
	sections := &smallSections{}
	var group sync.WaitGroup
	var lock sync.Mutex
	var firstErr error
	run := func(load func() error) {
		group.Add(1)
		go func() {
			defer group.Done()
			if err := load(); err != nil {
				lock.Lock()
				if firstErr == nil {
					firstErr = err
				}
				lock.Unlock()
			}
		}()
	}
	run(func() error {
		account, err := s.loadAccount(ctx, userID)
		if err != nil {
			return err
		}
		sections.account = account
		return nil
	})
	run(func() error {
		membership, err := s.loadMembership(ctx, orgID, userID)
		if err != nil {
			return err
		}
		sections.membership = membership
		return nil
	})
	run(func() error {
		settings, err := s.loadUserSettings(ctx, orgID, userID)
		if err != nil {
			return err
		}
		sections.userSettings = settings
		return nil
	})
	run(func() error {
		subscriptions, err := s.loadContentSubscriptions(ctx, orgID, userID)
		if err != nil {
			return err
		}
		sections.contentSubscriptions = subscriptions
		return nil
	})
	run(func() error {
		aggregates, err := s.loadBehaviorAggregates(ctx, orgID, userID)
		if err != nil {
			return err
		}
		sections.newsBehavior.Aggregates = aggregates
		return nil
	})
	run(func() error {
		snapshot, err := s.loadSimilaritySnapshot(ctx, orgID, userID)
		if err != nil {
			return err
		}
		sections.newsBehavior.SimilaritySnapshot = snapshot
		return nil
	})
	run(func() error {
		schedule, err := s.loadDeliverySchedule(ctx, orgID, userID)
		if err != nil {
			return err
		}
		sections.digest.DeliverySchedule = schedule
		return nil
	})
	run(func() error {
		profile, err := s.behavior.ProfileJSON(ctx, orgID, userID)
		if err != nil {
			// getProfile only touches Redis; an ioredis failure is a 500 in
			// NestJS (non-HttpException).
			return redisWrap(err)
		}
		sections.newsBehavior.Profile = json.RawMessage(profile)
		return nil
	})
	group.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	return sections, nil
}

// loadAccount mirrors loadAccount: user.findUnique with totpFactor and the
// recoveryCodes ordered by createdAt asc.
func (s *Service) loadAccount(ctx context.Context, userID string) (*exportAccount, error) {
	var row exportAccount
	var emailVerified, lastLoginAt sql.NullTime
	var pendingEmail, avatarURL sql.NullString
	var createdAt, updatedAt time.Time
	err := s.db.QueryRowContext(ctx,
		"SELECT `id`, `email`, `emailVerified`, `pendingEmail`, `firstName`, `lastName`, "+
			"`avatarUrl`, `isActive`, `lastLoginAt`, `createdAt`, `updatedAt` "+
			"FROM `User` WHERE `id` = ? LIMIT 1", userID).
		Scan(&row.ID, &row.Email, &emailVerified, &pendingEmail, &row.FirstName, &row.LastName,
			&avatarURL, &row.IsActive, &lastLoginAt, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, dbWrap(err)
	}
	row.EmailVerified = formatTime(emailVerified)
	row.PendingEmail = formatNullString(pendingEmail)
	row.AvatarURL = formatNullString(avatarURL)
	row.LastLoginAt = formatTime(lastLoginAt)
	row.CreatedAt = formatTimeValue(createdAt)
	row.UpdatedAt = formatTimeValue(updatedAt)
	row.RecoveryCodes = []exportRecoveryCode{}

	totp, err := s.loadTotpFactor(ctx, userID)
	if err != nil {
		return nil, err
	}
	row.TotpFactor = totp
	codes, err := s.loadRecoveryCodes(ctx, userID)
	if err != nil {
		return nil, err
	}
	row.RecoveryCodes = codes
	return &row, nil
}

func (s *Service) loadTotpFactor(ctx context.Context, userID string) (*exportTotpFactor, error) {
	var row exportTotpFactor
	var label sql.NullString
	var enrolledAt, verifiedAt, disabledAt, lastUsedAt, createdAt, updatedAt sql.NullTime
	err := s.db.QueryRowContext(ctx,
		"SELECT `label`, `enrolledAt`, `verifiedAt`, `disabledAt`, `lastUsedAt`, `createdAt`, `updatedAt` "+
			"FROM `UserTotpFactor` WHERE `userId` = ? LIMIT 1", userID).
		Scan(&label, &enrolledAt, &verifiedAt, &disabledAt, &lastUsedAt, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, dbWrap(err)
	}
	row.Label = formatNullString(label)
	row.EnrolledAt = formatTime(enrolledAt)
	row.VerifiedAt = formatTime(verifiedAt)
	row.DisabledAt = formatTime(disabledAt)
	row.LastUsedAt = formatTime(lastUsedAt)
	row.CreatedAt = formatTime(createdAt)
	row.UpdatedAt = formatTime(updatedAt)
	return &row, nil
}

func (s *Service) loadRecoveryCodes(ctx context.Context, userID string) ([]exportRecoveryCode, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT `usedAt`, `createdAt` FROM `UserRecoveryCode` WHERE `userId` = ? ORDER BY `createdAt` ASC", userID)
	if err != nil {
		return nil, dbWrap(err)
	}
	defer rows.Close()
	codes := make([]exportRecoveryCode, 0)
	for rows.Next() {
		var usedAt sql.NullTime
		var createdAt time.Time
		if err := rows.Scan(&usedAt, &createdAt); err != nil {
			return nil, dbWrap(err)
		}
		codes = append(codes, exportRecoveryCode{
			UsedAt:    formatTime(usedAt),
			CreatedAt: formatTimeValue(createdAt),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, dbWrap(err)
	}
	return codes, nil
}

// loadMembership mirrors the membership.findUnique select with org, the primary
// role, and the additional roles (role.name asc).
func (s *Service) loadMembership(ctx context.Context, orgID, userID string) (*exportMembership, error) {
	var row exportMembership
	var createdAt time.Time
	var org exportMembershipOrg
	var orgDescription, orgPlanTier, orgSubscriptionStatus sql.NullString
	var orgCreatedAt, orgUpdatedAt time.Time
	var roleID, roleName string
	var roleDescription sql.NullString
	var roleIsSystem bool
	err := s.db.QueryRowContext(ctx,
		"SELECT `m`.`id`, `m`.`userId`, `m`.`orgId`, `m`.`roleId`, `m`.`isActive`, `m`.`createdAt`, "+
			"`o`.`id`, `o`.`name`, `o`.`slug`, `o`.`description`, `o`.`planTier`, `o`.`subscriptionStatus`, "+
			"`o`.`isActive`, `o`.`createdAt`, `o`.`updatedAt`, "+
			"`r`.`id`, `r`.`name`, `r`.`description`, `r`.`isSystem` "+
			"FROM `Membership` `m` "+
			"JOIN `Org` `o` ON `o`.`id` = `m`.`orgId` "+
			"JOIN `Role` `r` ON `r`.`id` = `m`.`roleId` AND `r`.`orgId` = `m`.`orgId` "+
			"WHERE `m`.`userId` = ? AND `m`.`orgId` = ? LIMIT 1", userID, orgID).
		Scan(&row.ID, &row.UserID, &row.OrgID, &row.RoleID, &row.IsActive, &createdAt,
			&org.ID, &org.Name, &org.Slug, &orgDescription, &orgPlanTier, &orgSubscriptionStatus,
			&org.IsActive, &orgCreatedAt, &orgUpdatedAt,
			&roleID, &roleName, &roleDescription, &roleIsSystem)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, dbWrap(err)
	}
	row.CreatedAt = formatTimeValue(createdAt)
	org.Description = formatNullString(orgDescription)
	org.PlanTier = formatNullString(orgPlanTier)
	org.SubscriptionStatus = formatNullString(orgSubscriptionStatus)
	org.CreatedAt = formatTimeValue(orgCreatedAt)
	org.UpdatedAt = formatTimeValue(orgUpdatedAt)
	row.Org = &org

	primaryPermissions, err := s.loadRolePermissions(ctx, roleID)
	if err != nil {
		return nil, err
	}
	row.Role = &exportRole{
		ID:          roleID,
		Name:        roleName,
		Description: formatNullString(roleDescription),
		IsSystem:    roleIsSystem,
		Permissions: primaryPermissions,
	}

	roles, err := s.loadMembershipRoles(ctx, orgID, row.ID)
	if err != nil {
		return nil, err
	}
	row.Roles = roles
	return &row, nil
}

// loadRolePermissions mirrors `permissions: { select: { permission … },
// orderBy: [{ permission: { name: "asc" } }] }`.
func (s *Service) loadRolePermissions(ctx context.Context, roleID string) ([]exportRolePermission, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT `p`.`name`, `p`.`description` FROM `RolePermission` `rp` "+
			"JOIN `Permission` `p` ON `p`.`id` = `rp`.`permissionId` "+
			"WHERE `rp`.`roleId` = ? ORDER BY `p`.`name` ASC", roleID)
	if err != nil {
		return nil, dbWrap(err)
	}
	defer rows.Close()
	permissions := make([]exportRolePermission, 0)
	for rows.Next() {
		var permission exportPermission
		var description sql.NullString
		if err := rows.Scan(&permission.Name, &description); err != nil {
			return nil, dbWrap(err)
		}
		permission.Description = formatNullString(description)
		permissions = append(permissions, exportRolePermission{Permission: permission})
	}
	if err := rows.Err(); err != nil {
		return nil, dbWrap(err)
	}
	return permissions, nil
}

// loadMembershipRoles mirrors the membership.roles include ordered by role.name.
func (s *Service) loadMembershipRoles(ctx context.Context, orgID, membershipID string) ([]exportMembershipRole, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT `mr`.`roleId`, `mr`.`createdAt`, `r`.`id`, `r`.`name`, `r`.`description`, `r`.`isSystem` "+
			"FROM `MembershipRole` `mr` "+
			"JOIN `Role` `r` ON `r`.`id` = `mr`.`roleId` AND `r`.`orgId` = `mr`.`orgId` "+
			"WHERE `mr`.`membershipId` = ? AND `mr`.`orgId` = ? ORDER BY `r`.`name` ASC",
		membershipID, orgID)
	if err != nil {
		return nil, dbWrap(err)
	}
	defer rows.Close()
	type roleRow struct {
		roleID    string
		createdAt time.Time
		role      exportRole
	}
	loaded := make([]roleRow, 0)
	for rows.Next() {
		var item roleRow
		var description sql.NullString
		if err := rows.Scan(&item.roleID, &item.createdAt, &item.role.ID, &item.role.Name,
			&description, &item.role.IsSystem); err != nil {
			return nil, dbWrap(err)
		}
		item.role.Description = formatNullString(description)
		loaded = append(loaded, item)
	}
	if err := rows.Err(); err != nil {
		return nil, dbWrap(err)
	}
	roles := make([]exportMembershipRole, 0, len(loaded))
	for _, item := range loaded {
		permissions, err := s.loadRolePermissions(ctx, item.roleID)
		if err != nil {
			return nil, err
		}
		item.role.Permissions = permissions
		roles = append(roles, exportMembershipRole{
			RoleID:    item.roleID,
			CreatedAt: formatTimeValue(item.createdAt),
			Role:      item.role,
		})
	}
	return roles, nil
}

// loadUserSettings mirrors userSetting.findMany (key asc).
func (s *Service) loadUserSettings(ctx context.Context, orgID, userID string) ([]exportUserSetting, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT `key`, `value`, `createdAt`, `updatedAt` FROM `UserSetting` "+
			"WHERE `orgId` = ? AND `userId` = ? ORDER BY `key` ASC", orgID, userID)
	if err != nil {
		return nil, dbWrap(err)
	}
	defer rows.Close()
	settings := make([]exportUserSetting, 0)
	for rows.Next() {
		var item exportUserSetting
		var value []byte
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&item.Key, &value, &createdAt, &updatedAt); err != nil {
			return nil, dbWrap(err)
		}
		item.Value = rawJSON(value)
		item.CreatedAt = formatTimeValue(createdAt)
		item.UpdatedAt = formatTimeValue(updatedAt)
		settings = append(settings, item)
	}
	if err := rows.Err(); err != nil {
		return nil, dbWrap(err)
	}
	return settings, nil
}

// loadContentSubscriptions mirrors userContentSubscription.findMany
// (kind asc, displayValue asc).
func (s *Service) loadContentSubscriptions(ctx context.Context, orgID, userID string) ([]exportContentSubscription, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT `id`, `kind`, `normalizedValue`, `displayValue`, `taxonomyPath`, `taxonomyVersion`, "+
			"`source`, `metadata`, `createdAt`, `updatedAt` FROM `UserContentSubscription` "+
			"WHERE `orgId` = ? AND `userId` = ? ORDER BY `kind` ASC, `displayValue` ASC", orgID, userID)
	if err != nil {
		return nil, dbWrap(err)
	}
	defer rows.Close()
	subscriptions := make([]exportContentSubscription, 0)
	for rows.Next() {
		var item exportContentSubscription
		var taxonomyPath, taxonomyVersion sql.NullString
		var metadata []byte
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&item.ID, &item.Kind, &item.NormalizedValue, &item.DisplayValue,
			&taxonomyPath, &taxonomyVersion, &item.Source, &metadata, &createdAt, &updatedAt); err != nil {
			return nil, dbWrap(err)
		}
		item.TaxonomyPath = formatNullString(taxonomyPath)
		item.TaxonomyVersion = formatNullString(taxonomyVersion)
		item.Metadata = rawJSON(metadata)
		item.CreatedAt = formatTimeValue(createdAt)
		item.UpdatedAt = formatTimeValue(updatedAt)
		subscriptions = append(subscriptions, item)
	}
	if err := rows.Err(); err != nil {
		return nil, dbWrap(err)
	}
	return subscriptions, nil
}

// loadBehaviorAggregates mirrors userNewsBehaviorAggregate.findMany
// (signalType asc, signalKey asc).
func (s *Service) loadBehaviorAggregates(ctx context.Context, orgID, userID string) ([]exportBehaviorAggregate, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT `signalType`, `signalKey`, `score`, `lastInteractedAt`, `createdAt`, `updatedAt` "+
			"FROM `UserNewsBehaviorAggregate` WHERE `orgId` = ? AND `userId` = ? "+
			"ORDER BY `signalType` ASC, `signalKey` ASC", orgID, userID)
	if err != nil {
		return nil, dbWrap(err)
	}
	defer rows.Close()
	aggregates := make([]exportBehaviorAggregate, 0)
	for rows.Next() {
		var item exportBehaviorAggregate
		var lastInteractedAt time.Time
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&item.SignalType, &item.SignalKey, &item.Score, &lastInteractedAt,
			&createdAt, &updatedAt); err != nil {
			return nil, dbWrap(err)
		}
		item.LastInteractedAt = formatTimeValue(lastInteractedAt)
		item.CreatedAt = formatTimeValue(createdAt)
		item.UpdatedAt = formatTimeValue(updatedAt)
		aggregates = append(aggregates, item)
	}
	if err := rows.Err(); err != nil {
		return nil, dbWrap(err)
	}
	return aggregates, nil
}

// loadSimilaritySnapshot mirrors userNewsSimilaritySnapshot.findUnique.
func (s *Service) loadSimilaritySnapshot(ctx context.Context, orgID, userID string) (*exportSimilaritySnapshot, error) {
	var row exportSimilaritySnapshot
	var computedAt sql.NullTime
	var createdAt, updatedAt time.Time
	err := s.db.QueryRowContext(ctx,
		"SELECT `dirty`, `computedAt`, `createdAt`, `updatedAt` FROM `UserNewsSimilaritySnapshot` "+
			"WHERE `orgId` = ? AND `userId` = ? LIMIT 1", orgID, userID).
		Scan(&row.Dirty, &computedAt, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, dbWrap(err)
	}
	row.ComputedAt = formatTime(computedAt)
	row.CreatedAt = formatTimeValue(createdAt)
	row.UpdatedAt = formatTimeValue(updatedAt)
	return &row, nil
}

// loadDeliverySchedule mirrors userDigestDeliverySchedule.findUnique.
func (s *Service) loadDeliverySchedule(ctx context.Context, orgID, userID string) (*exportDeliverySchedule, error) {
	var row exportDeliverySchedule
	var nextRunAt, lastSentAt, lastStatusAt sql.NullTime
	var lastError sql.NullString
	var createdAt, updatedAt time.Time
	err := s.db.QueryRowContext(ctx,
		"SELECT `enabled`, `timezone`, `sendHour`, `sendMinute`, `nextRunAt`, `lastSentAt`, "+
			"`lastStatus`, `lastStatusAt`, `lastError`, `createdAt`, `updatedAt` "+
			"FROM `UserDigestDeliverySchedule` WHERE `orgId` = ? AND `userId` = ? LIMIT 1", orgID, userID).
		Scan(&row.Enabled, &row.Timezone, &row.SendHour, &row.SendMinute, &nextRunAt, &lastSentAt,
			&row.LastStatus, &lastStatusAt, &lastError, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, dbWrap(err)
	}
	row.NextRunAt = formatTime(nextRunAt)
	row.LastSentAt = formatTime(lastSentAt)
	row.LastStatusAt = formatTime(lastStatusAt)
	row.LastError = formatNullString(lastError)
	row.CreatedAt = formatTimeValue(createdAt)
	row.UpdatedAt = formatTimeValue(updatedAt)
	return &row, nil
}

// forEachSavedView streams savedAnalysisView rows (updatedAt desc, createdAt
// desc).
func (s *Service) forEachSavedView(ctx context.Context, orgID, userID string, yield func(exportSavedView) error) error {
	rows, err := s.db.QueryContext(ctx,
		"SELECT `id`, `title`, `description`, `surface`, `routePath`, `queryState`, `visibility`, "+
			"`createdAt`, `updatedAt` FROM `SavedAnalysisView` "+
			"WHERE `orgId` = ? AND `createdById` = ? ORDER BY `updatedAt` DESC, `createdAt` DESC",
		orgID, userID)
	if err != nil {
		return dbWrap(err)
	}
	defer rows.Close()
	for rows.Next() {
		var item exportSavedView
		var description sql.NullString
		var queryState []byte
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&item.ID, &item.Title, &description, &item.Surface, &item.RoutePath,
			&queryState, &item.Visibility, &createdAt, &updatedAt); err != nil {
			return dbWrap(err)
		}
		item.Description = formatNullString(description)
		item.QueryState = rawJSON(queryState)
		item.CreatedAt = formatTimeValue(createdAt)
		item.UpdatedAt = formatTimeValue(updatedAt)
		if err := yield(item); err != nil {
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return dbWrap(err)
	}
	return nil
}

// forEachAnalysisThread streams analysisThread rows (updatedAt desc, createdAt
// desc).
func (s *Service) forEachAnalysisThread(ctx context.Context, orgID, userID string, yield func(exportAnalysisThread) error) error {
	rows, err := s.db.QueryContext(ctx,
		"SELECT `id`, `subjectType`, `subjectId`, `noteMarkdown`, `createdAt`, `updatedAt` "+
			"FROM `AnalysisThread` WHERE `orgId` = ? AND `createdById` = ? "+
			"ORDER BY `updatedAt` DESC, `createdAt` DESC", orgID, userID)
	if err != nil {
		return dbWrap(err)
	}
	defer rows.Close()
	for rows.Next() {
		var item exportAnalysisThread
		var noteMarkdown sql.NullString
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&item.ID, &item.SubjectType, &item.SubjectID, &noteMarkdown,
			&createdAt, &updatedAt); err != nil {
			return dbWrap(err)
		}
		item.NoteMarkdown = formatNullString(noteMarkdown)
		item.CreatedAt = formatTimeValue(createdAt)
		item.UpdatedAt = formatTimeValue(updatedAt)
		if err := yield(item); err != nil {
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return dbWrap(err)
	}
	return nil
}

// forEachAnalysisComment streams analysisComment rows (createdAt asc).
func (s *Service) forEachAnalysisComment(ctx context.Context, orgID, userID string, yield func(exportAnalysisComment) error) error {
	rows, err := s.db.QueryContext(ctx,
		"SELECT `id`, `threadId`, `bodyMarkdown`, `createdAt`, `updatedAt` FROM `AnalysisComment` "+
			"WHERE `orgId` = ? AND `createdById` = ? ORDER BY `createdAt` ASC", orgID, userID)
	if err != nil {
		return dbWrap(err)
	}
	defer rows.Close()
	for rows.Next() {
		var item exportAnalysisComment
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&item.ID, &item.ThreadID, &item.BodyMarkdown, &createdAt, &updatedAt); err != nil {
			return dbWrap(err)
		}
		item.CreatedAt = formatTimeValue(createdAt)
		item.UpdatedAt = formatTimeValue(updatedAt)
		if err := yield(item); err != nil {
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return dbWrap(err)
	}
	return nil
}

// forEachNotification streams notification rows (createdAt desc).
func (s *Service) forEachNotification(ctx context.Context, orgID, userID string, yield func(exportNotification) error) error {
	rows, err := s.db.QueryContext(ctx,
		"SELECT `id`, `type`, `title`, `body`, `data`, `readAt`, `createdAt`, `updatedAt` "+
			"FROM `Notification` WHERE `orgId` = ? AND `userId` = ? ORDER BY `createdAt` DESC",
		orgID, userID)
	if err != nil {
		return dbWrap(err)
	}
	defer rows.Close()
	for rows.Next() {
		var item exportNotification
		var body sql.NullString
		var data []byte
		var readAt sql.NullTime
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&item.ID, &item.Type, &item.Title, &body, &data, &readAt, &createdAt, &updatedAt); err != nil {
			return dbWrap(err)
		}
		item.Body = formatNullString(body)
		item.Data = rawJSON(data)
		item.ReadAt = formatTime(readAt)
		item.CreatedAt = formatTimeValue(createdAt)
		item.UpdatedAt = formatTimeValue(updatedAt)
		if err := yield(item); err != nil {
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return dbWrap(err)
	}
	return nil
}

// forEachAssistantRun delegates to the Mongo source.
func (s *Service) forEachAssistantRun(ctx context.Context, orgID, userID string, yield func(AssistantRun) error) error {
	if s.assistantRuns == nil {
		return errors.New("accountdata: assistant run source is not configured")
	}
	return s.assistantRuns.ForEachAssistantRun(ctx, orgID, userID, yield)
}

// formatTimeValue renders a non-null timestamp as an ISO string.
func formatTimeValue(value time.Time) *string {
	formatted := value.UTC().Truncate(time.Millisecond).Format(jsDateLayout)
	return &formatted
}

// formatTime renders a nullable timestamp as an ISO string or JSON null.
func formatTime(value sql.NullTime) *string {
	if !value.Valid {
		return nil
	}
	return formatTimeValue(value.Time)
}

// formatNullString renders a nullable string as a string or JSON null.
func formatNullString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	text := value.String
	return &text
}

// rawJSON keeps one JSON column value unchanged. A nil value is the JSON null.
func rawJSON(value []byte) json.RawMessage {
	if value == nil {
		return nil
	}
	return json.RawMessage(append([]byte(nil), value...))
}
