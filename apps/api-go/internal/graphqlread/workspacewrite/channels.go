package workspacewrite

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/alerts"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

const (
	alertChannelEmail   = "email"
	alertChannelWebhook = "webhook"

	alertDeliveryPending = "pending"
	alertDeliverySending = "sending"
	alertDeliveryFailed  = "failed"
)

// alertChannelSelect reads one channel scoped to the caller's organization.
const alertChannelSelect = "SELECT `id`, `name`, `type`, `target`, `isActive`, `config`, `createdAt`, `updatedAt` " +
	"FROM `AlertNotificationChannel` WHERE `id` = ? AND `orgId` = ? LIMIT 1"

// emailExtractPattern is the EmailService EMAIL_EXTRACT_REGEX. It only bounds
// the candidate shape; every candidate is then filtered by the isEmail port.
var emailExtractPattern = regexp.MustCompile(
	"(?i)[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+")

// createAlertChannel creates one delivery configuration row. No email is sent
// and no webhook is probed; the row is only persisted.
func (s *service) createAlertChannel(ctx contract.Context, input alertChannelInput) (alerts.AlertChannelModel, error) {
	if s == nil || s.db == nil {
		return alerts.AlertChannelModel{}, errDatabaseUnavailable
	}
	callCtx := callContext(ctx)
	target, err := normalizeChannelTarget(callCtx, input.Type, input.Target)
	if err != nil {
		return alerts.AlertChannelModel{}, err
	}
	configText, err := jsonText(input.Config)
	if err != nil {
		return alerts.AlertChannelModel{}, err
	}
	isActive := true
	if input.IsActive != nil {
		isActive = *input.IsActive
	}
	id, err := newRowID()
	if err != nil {
		return alerts.AlertChannelModel{}, err
	}
	now := nowMillis()
	if _, err := s.db.ExecContext(callCtx,
		"INSERT INTO `AlertNotificationChannel` (`id`, `orgId`, `type`, `name`, `target`, `config`, `isActive`, `createdById`, `createdAt`, `updatedAt`) "+
			"VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?)",
		id, ctx.Identity.OrgID, input.Type, input.Name, target, configText, isActive,
		sqlNullableString(userIDPtr(ctx.Identity.UserID)), now, now); err != nil {
		return alerts.AlertChannelModel{}, err
	}
	model, err := loadAlertChannel(callCtx, s.db, ctx.Identity.OrgID, id)
	if err != nil {
		return alerts.AlertChannelModel{}, err
	}
	if model == nil {
		return alerts.AlertChannelModel{}, errors.New("workspacewrite: saved alert channel could not be reloaded")
	}
	return *model, nil
}

// updateAlertChannel updates only the supplied properties of one channel of the
// caller's organization. The channel type never changes, and a target update is
// normalized with the stored type, never with a client-supplied one.
//
// The three DTO states are preserved: an omitted property is not written, an
// explicit null is written as null (which the database rejects for the
// non-nullable columns, the same 500 branch NestJS takes), and a value is
// written after normalization. config keeps its `value ?? {}` rule.
func (s *service) updateAlertChannel(ctx contract.Context, input updateAlertChannelInput) (alerts.AlertChannelModel, error) {
	if s == nil || s.db == nil {
		return alerts.AlertChannelModel{}, errDatabaseUnavailable
	}
	callCtx := callContext(ctx)
	orgID := ctx.Identity.OrgID
	var existingType string
	err := s.db.QueryRowContext(callCtx,
		"SELECT `type` FROM `AlertNotificationChannel` WHERE `id` = ? AND `orgId` = ? LIMIT 1", input.ID, orgID).Scan(&existingType)
	if errors.Is(err, sql.ErrNoRows) {
		// NestJS raises an ordinary Error here, which the global filter reports
		// as 500 / Internal server error.
		return alerts.AlertChannelModel{}, errors.New("Alert channel not found for this org")
	}
	if err != nil {
		return alerts.AlertChannelModel{}, err
	}

	assignments := make([]string, 0, 5)
	args := make([]any, 0, 6)
	if input.NameSet {
		assignments = append(assignments, "`name` = ?")
		args = append(args, sqlNullableString(input.Name))
	}
	if input.TargetSet {
		assignments = append(assignments, "`target` = ?")
		if input.Target == nil {
			args = append(args, nil)
		} else {
			normalized, err := normalizeChannelTarget(callCtx, existingType, *input.Target)
			if err != nil {
				return alerts.AlertChannelModel{}, err
			}
			args = append(args, normalized)
		}
	}
	if input.IsActiveSet {
		assignments = append(assignments, "`isActive` = ?")
		if input.IsActive == nil {
			args = append(args, nil)
		} else {
			args = append(args, *input.IsActive)
		}
	}
	if input.ConfigSet {
		configText, err := jsonText(input.Config)
		if err != nil {
			return alerts.AlertChannelModel{}, err
		}
		assignments = append(assignments, "`config` = CAST(? AS JSON)")
		args = append(args, configText)
	}
	assignments = append(assignments, "`updatedAt` = ?")
	args = append(args, nowMillis(), input.ID, orgID)
	if _, err := s.db.ExecContext(callCtx,
		"UPDATE `AlertNotificationChannel` SET "+strings.Join(assignments, ", ")+" WHERE `id` = ? AND `orgId` = ?", args...); err != nil {
		return alerts.AlertChannelModel{}, err
	}
	model, err := loadAlertChannel(callCtx, s.db, orgID, input.ID)
	if err != nil {
		return alerts.AlertChannelModel{}, err
	}
	if model == nil {
		return alerts.AlertChannelModel{}, errors.New("Alert channel not found for this org")
	}
	return *model, nil
}

// deleteAlertChannel removes one channel of the caller's organization in one
// transaction. Pending and sending deliveries of the channel become failed with
// the "channel deleted" error, every remaining delivery of the channel keeps
// its history with a null channelId, and the channel row is deleted. The
// AlertRuleChannel links are removed by the foreign-key cascade, so historical
// deliveries and the alert rules themselves are preserved.
//
// The delivery table has no orgId column: tenancy is established by the channel
// row, which was already resolved through its orgId.
func (s *service) deleteAlertChannel(ctx context.Context, orgID, channelID string) (bool, error) {
	if s == nil || s.db == nil {
		return false, errDatabaseUnavailable
	}
	var existing string
	err := s.db.QueryRowContext(ctx, "SELECT `id` FROM `AlertNotificationChannel` WHERE `id` = ? AND `orgId` = ? LIMIT 1",
		channelID, orgID).Scan(&existing)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx,
		"UPDATE `AlertDelivery` SET `status` = ?, `error` = ? WHERE `channelId` = ? AND `status` IN (?, ?)",
		alertDeliveryFailed, "channel deleted", channelID, alertDeliveryPending, alertDeliverySending); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx,
		"UPDATE `AlertDelivery` SET `channelId` = NULL WHERE `channelId` = ?", channelID); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx,
		"DELETE FROM `AlertNotificationChannel` WHERE `id` = ? AND `orgId` = ?", channelID, orgID); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

// loadAlertChannel reads one channel scoped to the caller's organization.
func loadAlertChannel(ctx context.Context, q dbtx, orgID, channelID string) (*alerts.AlertChannelModel, error) {
	var (
		model                alerts.AlertChannelModel
		config               []byte
		isActive             bool
		createdAt, updatedAt time.Time
	)
	err := q.QueryRowContext(ctx, alertChannelSelect, channelID, orgID).Scan(
		&model.ID, &model.Name, &model.Type, &model.Target, &isActive, &config, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	model.IsActive = isActive
	model.Config = jsonScalar(config)
	model.CreatedAt = createdAt.UTC()
	model.UpdatedAt = updatedAt.UTC()
	return &model, nil
}

// normalizeChannelTarget mirrors AlertsService.normalizeChannelTarget: trim
// first, then normalize by channel type.
func normalizeChannelTarget(ctx context.Context, channelType, target string) (string, error) {
	normalizedTarget := jsTrim(target)
	switch channelType {
	case alertChannelEmail:
		return normalizeEmailTarget(normalizedTarget)
	case alertChannelWebhook:
		if err := assertSafeWebhookTarget(ctx, normalizedTarget); err != nil {
			return "", err
		}
	}
	return normalizedTarget, nil
}

// normalizeEmailTarget mirrors EmailService.normalizeEmailTarget. The leading
// trim already happened in normalizeChannelTarget.
func normalizeEmailTarget(target string) (string, error) {
	if target == "" {
		return "", badRequest("Invalid email target")
	}
	matches := emailExtractPattern.FindAllString(target, -1)
	emails := make([]string, 0, len(matches))
	seen := make(map[string]struct{}, len(matches))
	for _, match := range matches {
		candidate := jsTrim(match)
		if candidate == "" {
			continue
		}
		if !validatorIsEmail(candidate) {
			continue
		}
		if _, ok := seen[candidate]; ok {
			continue
		}
		seen[candidate] = struct{}{}
		emails = append(emails, candidate)
	}
	if len(emails) == 0 {
		return "", badRequest("Invalid email target")
	}
	return strings.Join(emails, ", "), nil
}

// createAlertChannelResolver creates the channel and returns its model.
func (s *service) createAlertChannelResolver(ctx contract.Context) (alerts.AlertChannelModel, error) {
	input, err := parseAlertChannelInput(callContext(ctx), ctx.Args)
	if err == nil {
		var model alerts.AlertChannelModel
		if model, err = s.createAlertChannel(ctx, input); err == nil {
			return model, nil
		}
	}
	return alerts.AlertChannelModel{}, graphqlFailure(err)
}

// updateAlertChannelResolver updates the channel and returns its model.
func (s *service) updateAlertChannelResolver(ctx contract.Context) (alerts.AlertChannelModel, error) {
	input, err := parseUpdateAlertChannelInput(ctx.Args)
	if err == nil {
		var model alerts.AlertChannelModel
		if model, err = s.updateAlertChannel(ctx, input); err == nil {
			return model, nil
		}
	}
	return alerts.AlertChannelModel{}, graphqlFailure(err)
}

// deleteAlertChannelResolver reports whether a channel was removed.
func (s *service) deleteAlertChannelResolver(ctx contract.Context) (bool, error) {
	channelID, err := requiredStringArg(ctx.Args, "channelId")
	if err == nil {
		var deleted bool
		if deleted, err = s.deleteAlertChannel(callContext(ctx), ctx.Identity.OrgID, channelID); err == nil {
			return deleted, nil
		}
	}
	return false, graphqlFailure(err)
}
