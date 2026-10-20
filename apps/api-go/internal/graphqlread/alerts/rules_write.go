package alerts

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

const (
	defaultCooldownSeconds  = 3600
	defaultCheckIntervalSec = 300
)

// upsertRule creates or updates one rule and its channel links in a single
// MySQL transaction, then replaces its schedule and enqueues one evaluation.
//
// Unlike AlertsService.upsertRule it reloads only the saved rule instead of the
// whole organization list (O3) and therefore never creates default rules as a
// side effect; alertRules remains the only root that backfills defaults.
func upsertRule(ctx context.Context, db *sql.DB, queue RuleQueue, orgID, userID string, input upsertAlertRuleInput, traceID string) (*AlertRuleModel, error) {
	if err := requireDB(db); err != nil {
		return nil, err
	}
	if err := ensureProducer(queue); err != nil {
		return nil, err
	}

	var existing *ruleState
	if input.ID != nil {
		state, err := loadRuleState(ctx, db, *input.ID)
		if err != nil {
			return nil, err
		}
		if state == nil || state.OrgID != orgID {
			return nil, errors.New(ruleMissingMessage)
		}
		existing = state
	}

	metricSlug := normalizeMetricSlug(input.MetricSlug)
	if metricSlug == "" {
		return nil, errors.New("metricSlug is required")
	}

	// Provider precedence: input, then the stored rule, then economic_data.
	metricProvider := providerEconomic
	if input.MetricProvider != nil {
		metricProvider = *input.MetricProvider
	} else if existing != nil {
		metricProvider = existing.MetricProvider
	}
	if metricProvider == providerSystemMetric && metricSlug == customManualSystemMetricSlug {
		if !currentValueFinite(input.Metadata) {
			return nil, errors.New("custom.manual metric requires metadata.currentValue")
		}
	}
	var dataItemID *string
	if metricProvider == providerEconomic {
		itemID, err := dataItemIDForSlug(ctx, db, metricSlug)
		if err != nil {
			return nil, err
		}
		dataItemID = itemID
	}

	severity := severityMedium
	if input.Severity != nil {
		severity = *input.Severity
	}
	status := statusActive
	if input.Status != nil {
		status = *input.Status
	}
	cooldownSeconds := defaultCooldownSeconds
	if input.CooldownSeconds != nil {
		cooldownSeconds = *input.CooldownSeconds
	}
	checkIntervalSec := defaultCheckIntervalSec
	if input.CheckIntervalSec != nil {
		checkIntervalSec = *input.CheckIntervalSec
	}
	metadata := string(input.Metadata)
	if metadata == "" {
		metadata = "{}"
	}

	// B2: duplicates are dropped in first-occurrence order before anything is
	// written, so [a, a] saves once instead of violating the unique index.
	channelIDs := dedupeChannelIDs(input.ChannelIDs)

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, queryErr("begin alert rule transaction", err)
	}
	defer func() { _ = tx.Rollback() }()

	// B1: the ownership check runs before any write in the transaction.
	if input.ChannelIDsSet {
		if err := validateChannelOwnership(ctx, tx, orgID, channelIDs); err != nil {
			return nil, err
		}
	}

	now := nowTime()
	ruleID := ""
	if existing != nil {
		ruleID = existing.ID
		assignments := []string{
			"`name` = ?",
			"`severity` = ?",
			"`status` = ?",
			"`metricProvider` = ?",
			"`metricSlug` = ?",
			"`operator` = ?",
			"`thresholdValue` = ?",
			"`thresholdLower` = ?",
			"`thresholdUpper` = ?",
			"`changeWindowMin` = ?",
			"`cooldownSeconds` = ?",
			"`checkIntervalSec` = ?",
			"`metadata` = CAST(? AS JSON)",
			"`dataItemId` = ?",
			"`updatedAt` = ?",
		}
		args := []any{
			input.Name,
			severity,
			status,
			metricProvider,
			metricSlug,
			input.Operator,
			nullableFloat(input.ThresholdValue),
			nullableFloat(input.ThresholdLower),
			nullableFloat(input.ThresholdUpper),
			nullableInt(input.ChangeWindowMin),
			cooldownSeconds,
			checkIntervalSec,
			metadata,
			nullableString(dataItemID),
			now,
		}
		// The three description states: omitted leaves the column untouched,
		// explicit null writes NULL, a string overwrites it. This is the only
		// property where an omitted input is not replaced by the DTO default.
		if input.DescriptionSet {
			assignments = append(assignments, "`description` = ?")
			args = append(args, nullableString(input.Description))
		}
		args = append(args, ruleID, orgID)
		if _, err := tx.ExecContext(ctx,
			"UPDATE `AlertRule` SET "+strings.Join(assignments, ", ")+" WHERE `id` = ? AND `orgId` = ?", args...); err != nil {
			return nil, queryErr("update alert rule", err)
		}
	} else {
		ruleID, err = newRowID()
		if err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO `AlertRule` (`id`, `orgId`, `name`, `description`, `severity`, `status`, `metricProvider`, "+
				"`dataItemId`, `metricSlug`, `operator`, `thresholdValue`, `thresholdLower`, `thresholdUpper`, "+
				"`changeWindowMin`, `cooldownSeconds`, `checkIntervalSec`, `lastTriggeredAt`, `metadata`, "+
				"`createdById`, `createdAt`, `updatedAt`) "+
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, CAST(? AS JSON), ?, ?, ?)",
			ruleID, orgID, input.Name, nullableString(input.Description), severity, status,
			metricProvider, nullableString(dataItemID), metricSlug, input.Operator,
			nullableFloat(input.ThresholdValue), nullableFloat(input.ThresholdLower), nullableFloat(input.ThresholdUpper),
			nullableInt(input.ChangeWindowMin), cooldownSeconds, checkIntervalSec, metadata,
			nullableString(userIDPtr(userID)), now, now,
		); err != nil {
			return nil, queryErr("create alert rule", err)
		}
	}

	if input.ChannelIDsSet {
		if _, err := tx.ExecContext(ctx, "DELETE FROM `AlertRuleChannel` WHERE `ruleId` = ?", ruleID); err != nil {
			return nil, queryErr("clear alert rule channels", err)
		}
		for _, channelID := range channelIDs {
			linkID, err := newRowID()
			if err != nil {
				return nil, err
			}
			if _, err := tx.ExecContext(ctx,
				"INSERT INTO `AlertRuleChannel` (`id`, `ruleId`, `channelId`, `createdAt`) VALUES (?, ?, ?, ?)",
				linkID, ruleID, channelID, now); err != nil {
				return nil, queryErr("link alert rule channel", err)
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, queryErr("commit alert rule transaction", err)
	}

	// Every Redis write happens after the commit, exactly like the NestJS
	// service: a queue failure is returned, the rule stays saved, and the
	// request is not replayed through the legacy gateway.
	if err := queue.EnsureRuleSchedule(ctx, ruleID, orgID, checkIntervalSec, status == statusActive); err != nil {
		return nil, err
	}
	// An evaluation is enqueued regardless of the rule status; evaluateRule
	// itself skips a rule that is not active.
	if err := queue.EnqueueRuleCheck(ctx, ruleID, orgID, traceID); err != nil {
		return nil, err
	}

	model, err := loadRuleModel(ctx, db, orgID, ruleID)
	if err != nil {
		return nil, err
	}
	if model == nil {
		return nil, errRuleReload
	}
	return model, nil
}

// deleteRule removes one rule of the organization and then every schedule and
// pending job of it. AlertEvent, AlertDelivery and AlertRuleChannel rows are
// removed by the foreign-key ON DELETE CASCADE. A rule of another organization
// returns false without any side effect.
func deleteRule(ctx context.Context, db *sql.DB, queue RuleQueue, orgID, ruleID string) (bool, error) {
	if err := requireDB(db); err != nil {
		return false, err
	}
	if err := ensureProducer(queue); err != nil {
		return false, err
	}
	var existing string
	err := db.QueryRowContext(ctx,
		"SELECT `id` FROM `AlertRule` WHERE `id` = ? AND `orgId` = ? LIMIT 1", ruleID, orgID).Scan(&existing)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, queryErr("load alert rule", err)
	}
	if _, err := db.ExecContext(ctx, "DELETE FROM `AlertRule` WHERE `id` = ? AND `orgId` = ?", ruleID, orgID); err != nil {
		return false, queryErr("delete alert rule", err)
	}
	if err := queue.RemoveRuleJobs(ctx, ruleID); err != nil {
		return false, err
	}
	return true, nil
}

// triggerRuleCheck enqueues one evaluation of a rule that belongs to the
// organization. A foreign rule returns false and enqueues nothing.
func triggerRuleCheck(ctx context.Context, db *sql.DB, queue RuleQueue, orgID, ruleID, traceID string) (bool, error) {
	if err := requireDB(db); err != nil {
		return false, err
	}
	if err := ensureProducer(queue); err != nil {
		return false, err
	}
	var existing string
	err := db.QueryRowContext(ctx,
		"SELECT `id` FROM `AlertRule` WHERE `id` = ? AND `orgId` = ? LIMIT 1", ruleID, orgID).Scan(&existing)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, queryErr("load alert rule", err)
	}
	if err := queue.EnqueueRuleCheck(ctx, ruleID, orgID, traceID); err != nil {
		return false, err
	}
	return true, nil
}

// newRowID writes a Prisma cuid-style primary key. MySQL has no client-side
// default, so Go supplies it: "c" plus 24 hexadecimal digits (25 characters),
// the same shape the other migrated write batches use.
func newRowID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}

func nullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableFloat(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableInt(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

func userIDPtr(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// alertRulesResolver lists the organization's rules after backfilling defaults.
func (s *ruleService) alertRulesResolver(ctx contract.Context) ([]AlertRuleModel, error) {
	return alertRules(ctx.Ctx, s.db, s.queue, ctx.Identity.OrgID, traceIDFromContext(ctx.Ctx))
}

// upsertAlertRuleResolver parses, validates and saves one rule.
func (s *ruleService) upsertAlertRuleResolver(ctx contract.Context) (AlertRuleModel, error) {
	input, err := parseUpsertAlertRuleInput(ctx.Args)
	if err != nil {
		return AlertRuleModel{}, err
	}
	model, err := upsertRule(ctx.Ctx, s.db, s.queue, ctx.Identity.OrgID, ctx.Identity.UserID, input, traceIDFromContext(ctx.Ctx))
	if err != nil {
		return AlertRuleModel{}, err
	}
	if model == nil {
		return AlertRuleModel{}, errRuleReload
	}
	return *model, nil
}

// deleteAlertRuleResolver reports whether the rule was removed.
func (s *ruleService) deleteAlertRuleResolver(ctx contract.Context) (bool, error) {
	ruleID, err := requiredStringArg(ctx.Args, "ruleId")
	if err != nil {
		return false, err
	}
	return deleteRule(ctx.Ctx, s.db, s.queue, ctx.Identity.OrgID, ruleID)
}

// triggerAlertRuleResolver reports whether an evaluation was enqueued.
func (s *ruleService) triggerAlertRuleResolver(ctx contract.Context) (bool, error) {
	ruleID, err := requiredStringArg(ctx.Args, "ruleId")
	if err != nil {
		return false, err
	}
	return triggerRuleCheck(ctx.Ctx, s.db, s.queue, ctx.Identity.OrgID, ruleID, traceIDFromContext(ctx.Ctx))
}
