package alertworker

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

// sqlExecutor is the shared surface of *sql.DB and *sql.Tx the repository uses.
type sqlExecutor interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// repository holds the MySQL reads and writes of the alert worker. Every query
// mirrors the Prisma query in alerts.service.ts one to one; the comments name
// the NestJS method.
type repository struct {
	db *sql.DB
}

func newRepository(db *sql.DB) *repository {
	return &repository{db: db}
}

// ruleColumns is the AlertRule column list the worker reads. The prefix keeps
// every column unambiguous when the query joins other tables.
func ruleColumns(prefix string) string {
	return prefix + "`id`, " + prefix + "`orgId`, " + prefix + "`name`, " + prefix + "`description`, " +
		prefix + "`severity`, " + prefix + "`status`, " + prefix + "`metricProvider`, " +
		prefix + "`metricSlug`, " + prefix + "`operator`, " + prefix + "`thresholdValue`, " +
		prefix + "`thresholdLower`, " + prefix + "`thresholdUpper`, " + prefix + "`changeWindowMin`, " +
		prefix + "`cooldownSeconds`, " + prefix + "`checkIntervalSec`, " + prefix + "`lastTriggeredAt`, " +
		prefix + "`metadata`, " + prefix + "`createdById`"
}

// channelColumns is the AlertNotificationChannel column list, prefixed for joins.
func channelColumns(prefix string) string {
	return prefix + "`id`, " + prefix + "`orgId`, " + prefix + "`type`, " + prefix + "`name`, " +
		prefix + "`target`, " + prefix + "`config`, " + prefix + "`isActive`, " + prefix + "`createdAt`, " +
		prefix + "`updatedAt`"
}

func scanRule(scanner interface{ Scan(dest ...any) error }) (Rule, error) {
	var rule Rule
	var description, createdByID sql.NullString
	var thresholdValue, thresholdLower, thresholdUpper sql.NullString
	var changeWindowMin sql.NullInt64
	var lastTriggeredAt sql.NullTime
	var metadata []byte
	if err := scanner.Scan(
		&rule.ID, &rule.OrgID, &rule.Name, &description, &rule.Severity, &rule.Status,
		&rule.MetricProvider, &rule.MetricSlug, &rule.Operator,
		&thresholdValue, &thresholdLower, &thresholdUpper, &changeWindowMin,
		&rule.CooldownSeconds, &rule.CheckIntervalSec, &lastTriggeredAt, &metadata, &createdByID,
	); err != nil {
		return Rule{}, err
	}
	rule.Description = nullStringPtr(description)
	rule.CreatedByID = nullStringPtr(createdByID)
	rule.ThresholdValue = parseNullableDecimal(thresholdValue)
	rule.ThresholdLower = parseNullableDecimal(thresholdLower)
	rule.ThresholdUpper = parseNullableDecimal(thresholdUpper)
	if changeWindowMin.Valid {
		value := int(changeWindowMin.Int64)
		rule.ChangeWindowMin = &value
	}
	if lastTriggeredAt.Valid {
		value := lastTriggeredAt.Time.UTC()
		rule.LastTriggeredAt = &value
	}
	if len(metadata) > 0 {
		rule.Metadata = json.RawMessage(metadata)
	}
	return rule, nil
}

func scanChannel(scanner interface{ Scan(dest ...any) error }) (Channel, error) {
	var channel Channel
	var config []byte
	if err := scanner.Scan(
		&channel.ID, &channel.OrgID, &channel.Type, &channel.Name, &channel.Target,
		&config, &channel.IsActive, &channel.CreatedAt, &channel.UpdatedAt,
	); err != nil {
		return Channel{}, err
	}
	if len(config) > 0 {
		channel.Config = json.RawMessage(config)
	}
	return channel, nil
}

// loadRuleWithChannels mirrors AlertsService.evaluateRule's
// `alertRule.findUnique({include: {channels: {include: {channel: true}}}})`:
// every link is loaded, including inactive and cross-org channels, because the
// caller filters them (and logs the ones B2 drops).
func (r *repository) loadRuleWithChannels(ctx context.Context, exec sqlExecutor, ruleID string) (Rule, []ruleChannelLink, error) {
	var rule Rule
	row := exec.QueryRowContext(ctx, "SELECT "+ruleColumns("")+" FROM `AlertRule` WHERE `id` = ?", ruleID)
	rule, err := scanRule(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Rule{}, nil, nil
	}
	if err != nil {
		return Rule{}, nil, fmt.Errorf("alertworker: load alert rule %s: %w", ruleID, err)
	}

	rows, err := exec.QueryContext(ctx,
		"SELECT `rc`.`ruleId`, `rc`.`channelId`, "+channelColumns("c.")+
			" FROM `AlertRuleChannel` `rc` LEFT JOIN `AlertNotificationChannel` `c` ON `c`.`id` = `rc`.`channelId`"+
			" WHERE `rc`.`ruleId` = ?", ruleID)
	if err != nil {
		return Rule{}, nil, fmt.Errorf("alertworker: load rule channels %s: %w", ruleID, err)
	}
	defer rows.Close()
	links := make([]ruleChannelLink, 0, 4)
	for rows.Next() {
		var link ruleChannelLink
		var channelID sql.NullString
		var (
			id, orgID, channelType, name, target sql.NullString
			config                               []byte
			isActive                             sql.NullBool
			createdAt, updatedAt                 sql.NullTime
		)
		if err := rows.Scan(
			&link.RuleID, &channelID,
			&id, &orgID, &channelType, &name, &target, &config, &isActive, &createdAt, &updatedAt,
		); err != nil {
			return Rule{}, nil, fmt.Errorf("alertworker: scan rule channel %s: %w", ruleID, err)
		}
		if channelID.Valid {
			link.ChannelID = channelID.String
		}
		if id.Valid {
			channel := &Channel{
				ID:        id.String,
				OrgID:     orgID.String,
				Type:      channelType.String,
				Name:      name.String,
				Target:    target.String,
				IsActive:  isActive.Bool,
				CreatedAt: createdAt.Time.UTC(),
				UpdatedAt: updatedAt.Time.UTC(),
			}
			if len(config) > 0 {
				channel.Config = json.RawMessage(config)
			}
			link.Channel = channel
		}
		links = append(links, link)
	}
	if err := rows.Err(); err != nil {
		return Rule{}, nil, fmt.Errorf("alertworker: iterate rule channels %s: %w", ruleID, err)
	}
	return rule, links, nil
}

// activeRule is one row of the scan: the columns ensureAllSchedules and
// enqueueActiveRuleChecks select.
type activeRule struct {
	ID               string
	OrgID            string
	CheckIntervalSec int
}

// listActiveRules mirrors `alertRule.findMany({where: {status: active}})`.
func (r *repository) listActiveRules(ctx context.Context, exec sqlExecutor) ([]activeRule, error) {
	rows, err := exec.QueryContext(ctx,
		"SELECT `id`, `orgId`, `checkIntervalSec` FROM `AlertRule` WHERE `status` = ? ORDER BY `id` ASC",
		StatusActive)
	if err != nil {
		return nil, fmt.Errorf("alertworker: list active alert rules: %w", err)
	}
	defer rows.Close()
	rules := make([]activeRule, 0, 64)
	for rows.Next() {
		var rule activeRule
		if err := rows.Scan(&rule.ID, &rule.OrgID, &rule.CheckIntervalSec); err != nil {
			return nil, fmt.Errorf("alertworker: scan active alert rule: %w", err)
		}
		rules = append(rules, rule)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("alertworker: iterate active alert rules: %w", err)
	}
	return rules, nil
}

// listOrgIDs mirrors `org.findMany({select: {id}}). Note that the NestJS
// default-rule pass does not filter by isActive.
func (r *repository) listOrgIDs(ctx context.Context, exec sqlExecutor) ([]string, error) {
	rows, err := exec.QueryContext(ctx, "SELECT `id` FROM `Org`")
	if err != nil {
		return nil, fmt.Errorf("alertworker: list orgs: %w", err)
	}
	defer rows.Close()
	orgs := make([]string, 0, 16)
	for rows.Next() {
		var orgID string
		if err := rows.Scan(&orgID); err != nil {
			return nil, fmt.Errorf("alertworker: scan org: %w", err)
		}
		orgs = append(orgs, orgID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("alertworker: iterate orgs: %w", err)
	}
	return orgs, nil
}

// defaultRuleKey is an (orgId, provider, normalized slug) tuple already present
// in AlertRule.
type defaultRuleKey struct {
	OrgID          string
	MetricProvider string
	MetricSlug     string
}

// listDefaultRuleKeys is the O1 single query: every existing default-rule
// provider slug of every organization, so the caller can compute the missing
// set in memory instead of running three findMany per organization.
func (r *repository) listDefaultRuleKeys(ctx context.Context, exec sqlExecutor) ([]defaultRuleKey, error) {
	rows, err := exec.QueryContext(ctx,
		"SELECT `orgId`, `metricProvider`, `metricSlug` FROM `AlertRule`"+
			" WHERE `metricProvider` IN (?, ?, ?)",
		"crawl_task", "realtime_signal", "pipeline_job")
	if err != nil {
		return nil, fmt.Errorf("alertworker: list existing default rules: %w", err)
	}
	defer rows.Close()
	keys := make([]defaultRuleKey, 0, 128)
	for rows.Next() {
		var key defaultRuleKey
		if err := rows.Scan(&key.OrgID, &key.MetricProvider, &key.MetricSlug); err != nil {
			return nil, fmt.Errorf("alertworker: scan existing default rule: %w", err)
		}
		keys = append(keys, key)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("alertworker: iterate existing default rules: %w", err)
	}
	return keys, nil
}

// defaultRuleInsert is one default rule to create.
type defaultRuleInsert struct {
	ID              string
	OrgID           string
	Name            string
	Description     string
	Severity        string
	MetricProvider  string
	MetricSlug      string
	Operator        string
	ThresholdValue  float64
	CooldownSeconds int
	Metadata        []byte
	Now             time.Time
}

// insertDefaultRule mirrors the Prisma `alertRule.create` of
// ensureMetricProviderDefaultRules. The second result is false when the primary
// key already exists, which is exactly the NestJS P2002 branch that logs and
// returns without scheduling.
func (r *repository) insertDefaultRule(ctx context.Context, exec sqlExecutor, insert defaultRuleInsert) (bool, error) {
	now := insert.Now.UTC().Truncate(time.Millisecond)
	_, err := exec.ExecContext(ctx,
		"INSERT INTO `AlertRule` (`id`, `orgId`, `name`, `description`, `severity`, `status`, `metricProvider`, "+
			"`metricSlug`, `operator`, `thresholdValue`, `thresholdLower`, `thresholdUpper`, `changeWindowMin`, "+
			"`cooldownSeconds`, `checkIntervalSec`, `dataItemId`, `metadata`, `createdAt`, `updatedAt`) "+
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?, ?, ?)",
		insert.ID, insert.OrgID, insert.Name, insert.Description, insert.Severity, StatusActive,
		insert.MetricProvider, insert.MetricSlug, insert.Operator, formatDecimal(insert.ThresholdValue),
		60, insert.CooldownSeconds, 300, insert.Metadata, now, now)
	if err != nil {
		var mysqlErr *mysql.MySQLError
		if errors.As(err, &mysqlErr) && mysqlErr.Number == 1062 {
			return false, nil
		}
		return false, fmt.Errorf("alertworker: insert default rule %s: %w", insert.ID, err)
	}
	return true, nil
}

// claimRuleCooldown mirrors the transactional
// `alertRule.updateMany({where: {id, status: active, OR: [lastTriggeredAt null,
// lte: now - cooldown]}, data: {lastTriggeredAt: new Date()}})`.
func (r *repository) claimRuleCooldown(ctx context.Context, exec sqlExecutor, ruleID string, cooldownSeconds int, now time.Time) (bool, error) {
	result, err := exec.ExecContext(ctx,
		"UPDATE `AlertRule` SET `lastTriggeredAt` = ? WHERE `id` = ? AND `status` = ?"+
			" AND (`lastTriggeredAt` IS NULL OR `lastTriggeredAt` <= ?)",
		now.UTC().Truncate(time.Millisecond), ruleID, StatusActive,
		now.Add(-time.Duration(cooldownSeconds)*time.Second).UTC().Truncate(time.Millisecond))
	if err != nil {
		return false, fmt.Errorf("alertworker: claim rule cooldown %s: %w", ruleID, err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("alertworker: claim rule cooldown %s: %w", ruleID, err)
	}
	return affected == 1, nil
}

// eventInsert is one AlertEvent to create.
type eventInsert struct {
	ID            string
	RuleID        string
	TriggeredAt   time.Time
	MetricValue   float64
	ChangePercent *float64
	Severity      string
	Message       *string
	Context       []byte
	Now           time.Time
}

// insertEvent mirrors `tx.alertEvent.create`.
func (r *repository) insertEvent(ctx context.Context, exec sqlExecutor, insert eventInsert) error {
	_, err := exec.ExecContext(ctx,
		"INSERT INTO `AlertEvent` (`id`, `ruleId`, `triggeredAt`, `metricValue`, `changePercent`, `severity`, "+
			"`status`, `message`, `context`, `createdAt`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		insert.ID, insert.RuleID, insert.TriggeredAt.UTC().Truncate(time.Millisecond),
		formatDecimal(insert.MetricValue), insert.ChangePercent, insert.Severity, EventStatusPending,
		insert.Message, nullableJSON(insert.Context), insert.Now.UTC().Truncate(time.Millisecond))
	if err != nil {
		return fmt.Errorf("alertworker: insert alert event %s: %w", insert.ID, err)
	}
	return nil
}

// deliveryInsert is one AlertDelivery to create.
type deliveryInsert struct {
	ID             string
	EventID        string
	ChannelID      *string
	ChannelType    string
	TargetSnapshot []byte
	Now            time.Time
}

// insertDelivery mirrors `tx.alertDelivery.create`.
func (r *repository) insertDelivery(ctx context.Context, exec sqlExecutor, insert deliveryInsert) error {
	_, err := exec.ExecContext(ctx,
		"INSERT INTO `AlertDelivery` (`id`, `eventId`, `channelId`, `channelType`, `targetSnapshot`, `status`, `createdAt`)"+
			" VALUES (?, ?, ?, ?, ?, ?, ?)",
		insert.ID, insert.EventID, insert.ChannelID, insert.ChannelType,
		nullableJSON(insert.TargetSnapshot), DeliveryStatusPending, insert.Now.UTC().Truncate(time.Millisecond))
	if err != nil {
		return fmt.Errorf("alertworker: insert alert delivery %s: %w", insert.ID, err)
	}
	return nil
}

// markEventDelivered mirrors the in-transaction
// `alertEvent.update({status: delivered})` when a rule produced no deliveries.
func (r *repository) markEventDelivered(ctx context.Context, exec sqlExecutor, eventID string) error {
	_, err := exec.ExecContext(ctx, "UPDATE `AlertEvent` SET `status` = ? WHERE `id` = ?", EventStatusDelivered, eventID)
	if err != nil {
		return fmt.Errorf("alertworker: mark event %s delivered: %w", eventID, err)
	}
	return nil
}

// loadEventStatus reads the single status column (O5): reconcileEventStatus
// only needs the current status and the delivery statuses.
func (r *repository) loadEventStatus(ctx context.Context, exec sqlExecutor, eventID string) (*string, error) {
	var status string
	err := exec.QueryRowContext(ctx, "SELECT `status` FROM `AlertEvent` WHERE `id` = ?", eventID).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("alertworker: load event status %s: %w", eventID, err)
	}
	return &status, nil
}

// listDeliveryStatuses selects only the status column (O5), so a row with a
// large targetSnapshot is not read.
func (r *repository) listDeliveryStatuses(ctx context.Context, exec sqlExecutor, eventID string) ([]string, error) {
	rows, err := exec.QueryContext(ctx, "SELECT `status` FROM `AlertDelivery` WHERE `eventId` = ?", eventID)
	if err != nil {
		return nil, fmt.Errorf("alertworker: list delivery statuses %s: %w", eventID, err)
	}
	defer rows.Close()
	statuses := make([]string, 0, 4)
	for rows.Next() {
		var status string
		if err := rows.Scan(&status); err != nil {
			return nil, fmt.Errorf("alertworker: scan delivery status: %w", err)
		}
		statuses = append(statuses, status)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("alertworker: iterate delivery statuses: %w", err)
	}
	return statuses, nil
}

// updateEventStatus writes one event status.
func (r *repository) updateEventStatus(ctx context.Context, exec sqlExecutor, eventID, status string) error {
	_, err := exec.ExecContext(ctx, "UPDATE `AlertEvent` SET `status` = ? WHERE `id` = ?", status, eventID)
	if err != nil {
		return fmt.Errorf("alertworker: update event status %s: %w", eventID, err)
	}
	return nil
}

// loadDeliveryWithEventAndRule mirrors handleDeliveryJob's
// `alertDelivery.findUnique({include: {event: {include: {rule: true}}}})`.
func (r *repository) loadDeliveryWithEventAndRule(ctx context.Context, exec sqlExecutor, deliveryID string) (*DeliveryRow, error) {
	row := exec.QueryRowContext(ctx,
		"SELECT d.`id`, d.`eventId`, d.`channelId`, d.`channelType`, d.`targetSnapshot`, d.`status`, d.`error`, d.`sentAt`, "+
			"e.`id`, e.`ruleId`, e.`triggeredAt`, e.`metricValue`, e.`changePercent`, e.`severity`, e.`status`, e.`message`, e.`context`, "+
			ruleColumns("r.")+
			" FROM `AlertDelivery` `d`"+
			" JOIN `AlertEvent` `e` ON `e`.`id` = `d`.`eventId`"+
			" JOIN `AlertRule` `r` ON `r`.`id` = `e`.`ruleId`"+
			" WHERE `d`.`id` = ?", deliveryID)
	delivery, err := scanDeliveryWithEventAndRule(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return delivery, nil
}

func scanDeliveryWithEventAndRule(scanner interface{ Scan(dest ...any) error }) (*DeliveryRow, error) {
	var (
		deliveryID, eventID, channelType, deliveryStatus string
		channelID, deliveryError                         sql.NullString
		targetSnapshot                                   []byte
		sentAt                                           sql.NullTime

		eventRowID, eventRuleID, eventSeverity, eventStatus string
		eventTriggeredAt                                    time.Time
		eventMetricValue                                    string
		eventChangePercent                                  sql.NullFloat64
		eventMessage                                        sql.NullString
		eventContext                                        []byte

		ruleID, ruleOrgID, ruleName, ruleSeverity, ruleStatus      string
		ruleProvider, ruleSlug, ruleOperator                       string
		ruleDescription, ruleCreatedByID                           sql.NullString
		ruleThresholdValue, ruleThresholdLower, ruleThresholdUpper sql.NullString
		ruleChangeWindowMin                                        sql.NullInt64
		ruleCooldownSeconds, ruleCheckIntervalSec                  int
		ruleLastTriggeredAt                                        sql.NullTime
		ruleMetadata                                               []byte
	)
	if err := scanner.Scan(
		&deliveryID, &eventID, &channelID, &channelType, &targetSnapshot, &deliveryStatus, &deliveryError, &sentAt,
		&eventRowID, &eventRuleID, &eventTriggeredAt, &eventMetricValue, &eventChangePercent, &eventSeverity,
		&eventStatus, &eventMessage, &eventContext,
		&ruleID, &ruleOrgID, &ruleName, &ruleDescription, &ruleSeverity, &ruleStatus, &ruleProvider, &ruleSlug,
		&ruleOperator, &ruleThresholdValue, &ruleThresholdLower, &ruleThresholdUpper, &ruleChangeWindowMin,
		&ruleCooldownSeconds, &ruleCheckIntervalSec, &ruleLastTriggeredAt, &ruleMetadata, &ruleCreatedByID,
	); err != nil {
		return nil, err
	}
	delivery := &DeliveryRow{
		ID:             deliveryID,
		EventID:        eventID,
		ChannelType:    channelType,
		TargetSnapshot: json.RawMessage(targetSnapshot),
		Status:         deliveryStatus,
		Error:          nullStringPtr(deliveryError),
	}
	if channelID.Valid {
		value := channelID.String
		delivery.ChannelID = &value
	}
	if sentAt.Valid {
		value := sentAt.Time.UTC()
		delivery.SentAt = &value
	}
	metricValue, _ := parseDecimalString(eventMetricValue)
	delivery.Event = EventRow{
		ID:            eventRowID,
		RuleID:        eventRuleID,
		TriggeredAt:   eventTriggeredAt.UTC(),
		MetricValue:   metricValue,
		ChangePercent: nullFloatPtr(eventChangePercent),
		Severity:      eventSeverity,
		Status:        eventStatus,
		Message:       nullStringPtr(eventMessage),
	}
	if len(eventContext) > 0 {
		delivery.Event.Context = json.RawMessage(eventContext)
	}
	rule := Rule{
		ID:               ruleID,
		OrgID:            ruleOrgID,
		Name:             ruleName,
		Description:      nullStringPtr(ruleDescription),
		Severity:         ruleSeverity,
		Status:           ruleStatus,
		MetricProvider:   ruleProvider,
		MetricSlug:       ruleSlug,
		Operator:         ruleOperator,
		ThresholdValue:   parseNullableDecimal(ruleThresholdValue),
		ThresholdLower:   parseNullableDecimal(ruleThresholdLower),
		ThresholdUpper:   parseNullableDecimal(ruleThresholdUpper),
		CooldownSeconds:  ruleCooldownSeconds,
		CheckIntervalSec: ruleCheckIntervalSec,
		CreatedByID:      nullStringPtr(ruleCreatedByID),
	}
	if ruleChangeWindowMin.Valid {
		value := int(ruleChangeWindowMin.Int64)
		rule.ChangeWindowMin = &value
	}
	if ruleLastTriggeredAt.Valid {
		value := ruleLastTriggeredAt.Time.UTC()
		rule.LastTriggeredAt = &value
	}
	if len(ruleMetadata) > 0 {
		rule.Metadata = json.RawMessage(ruleMetadata)
	}
	delivery.Rule = rule
	return delivery, nil
}

// deliveryStatusUpdate is the `data` object of transitionDeliveryStatus: only
// the fields the caller sets are written, exactly like the Prisma updateMany.
type deliveryStatusUpdate struct {
	Status   string
	SentAt   *time.Time
	SetError bool
	Error    *string
}

// transitionDeliveryStatus mirrors transitionDeliveryStatus's conditional
// updateMany: the row only changes when its current status is one of `from`.
func (r *repository) transitionDeliveryStatus(ctx context.Context, exec sqlExecutor, deliveryID string, from []string, update deliveryStatusUpdate) (bool, error) {
	if len(from) == 0 {
		return false, nil
	}
	assignments := []string{"`status` = ?"}
	args := []any{update.Status}
	if update.SentAt != nil {
		assignments = append(assignments, "`sentAt` = ?")
		args = append(args, update.SentAt.UTC().Truncate(time.Millisecond))
	}
	if update.SetError {
		assignments = append(assignments, "`error` = ?")
		args = append(args, update.Error)
	}
	args = append(args, deliveryID)
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(from)), ",")
	for _, value := range from {
		args = append(args, value)
	}
	query := "UPDATE `AlertDelivery` SET " + strings.Join(assignments, ", ") +
		" WHERE `id` = ? AND `status` IN (" + placeholders + ")"
	result, err := exec.ExecContext(ctx, query, args...)
	if err != nil {
		return false, fmt.Errorf("alertworker: transition delivery %s: %w", deliveryID, err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("alertworker: transition delivery %s: %w", deliveryID, err)
	}
	return affected == 1, nil
}

// setDeliveryTargetSnapshot writes the in-app targetSnapshot.
func (r *repository) setDeliveryTargetSnapshot(ctx context.Context, exec sqlExecutor, deliveryID string, snapshot []byte) error {
	_, err := exec.ExecContext(ctx,
		"UPDATE `AlertDelivery` SET `targetSnapshot` = ? WHERE `id` = ?", nullableJSON(snapshot), deliveryID)
	if err != nil {
		return fmt.Errorf("alertworker: set delivery snapshot %s: %w", deliveryID, err)
	}
	return nil
}

// writeInAppDelivery mirrors the in-app success path: status sent, sentAt now,
// error NULL and the {userId, notificationId} snapshot.
func (r *repository) writeInAppDelivery(ctx context.Context, exec sqlExecutor, deliveryID string, snapshot []byte, now time.Time) error {
	_, err := exec.ExecContext(ctx,
		"UPDATE `AlertDelivery` SET `status` = ?, `sentAt` = ?, `error` = NULL, `targetSnapshot` = ? WHERE `id` = ?",
		DeliveryStatusSent, now.UTC().Truncate(time.Millisecond), nullableJSON(snapshot), deliveryID)
	if err != nil {
		return fmt.Errorf("alertworker: write in-app delivery %s: %w", deliveryID, err)
	}
	return nil
}

// writeInAppDeliveryFailure mirrors the in-app failure path: status failed, the
// error message and the {userId} snapshot.
func (r *repository) writeInAppDeliveryFailure(ctx context.Context, exec sqlExecutor, deliveryID string, snapshot []byte, message string) error {
	_, err := exec.ExecContext(ctx,
		"UPDATE `AlertDelivery` SET `status` = ?, `error` = ?, `targetSnapshot` = ? WHERE `id` = ?",
		DeliveryStatusFailed, message, nullableJSON(snapshot), deliveryID)
	if err != nil {
		return fmt.Errorf("alertworker: write in-app delivery failure %s: %w", deliveryID, err)
	}
	return nil
}

// insertNotification mirrors NotificationsService.notify's
// `notification.create` (the dispatcher publish is replaced by the alert
// notification bridge).
func (r *repository) insertNotification(ctx context.Context, exec sqlExecutor, id, orgID, userID, title, body string, data []byte, now time.Time) error {
	_, err := exec.ExecContext(ctx,
		"INSERT INTO `Notification` (`id`, `orgId`, `userId`, `type`, `title`, `body`, `data`, `createdAt`, `updatedAt`)"+
			" VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		id, orgID, userID, NotificationTypeAlertTriggered, title, body, nullableJSON(data),
		now.UTC().Truncate(time.Millisecond), now.UTC().Truncate(time.Millisecond))
	if err != nil {
		return fmt.Errorf("alertworker: insert alert notification %s: %w", id, err)
	}
	return nil
}

// candidateMembership is one membership row of the recipient query (O4).
type candidateMembership struct {
	UserID         string
	MembershipID   string
	Eligible       bool
	FromLink       bool
	PermissionName *string
}

// listCandidateMemberships is the O4 single query: every active-user membership
// of the organization (or of the requested users) with its eligibility flags
// and permission names. The caller applies the collectMembershipRoles rule
// (MembershipRole rows win; the primary role is the fallback) in memory.
//
// The predicate matches the union of the two NestJS queries it replaces:
//   - `membership.findMany({where: {orgId, user: {isActive: true}}})` for the
//     notifyAll candidate set, and
//   - `membership.findMany({where: {orgId, userId in ids, isActive: true,
//     user: {isActive: true}, org: {isActive: true}}})` for the permission
//     filter.
//
// Eligibility is therefore reported as a column instead of a filter.
func (r *repository) listCandidateMemberships(ctx context.Context, exec sqlExecutor, orgID string, userIDs []string) ([]candidateMembership, error) {
	query := "SELECT m.`userId`, m.`id`, " +
		"(m.`isActive` = 1 AND u.`isActive` = 1 AND o.`isActive` = 1) AS eligible, " +
		"(mr.`membershipId` IS NOT NULL) AS fromLink, p.`name` " +
		"FROM `Membership` `m` " +
		"JOIN `User` `u` ON `u`.`id` = m.`userId` " +
		"JOIN `Org` `o` ON `o`.`id` = m.`orgId` " +
		"LEFT JOIN `MembershipRole` `mr` ON mr.`membershipId` = m.`id` AND mr.`orgId` = m.`orgId` " +
		"LEFT JOIN `RolePermission` `rp` ON rp.`roleId` = COALESCE(mr.`roleId`, m.`roleId`) " +
		"LEFT JOIN `Permission` `p` ON p.`id` = rp.`permissionId` " +
		"WHERE m.`orgId` = ?"
	args := []any{orgID}
	if len(userIDs) > 0 {
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(userIDs)), ",")
		query += " AND m.`userId` IN (" + placeholders + ")"
		for _, userID := range userIDs {
			args = append(args, userID)
		}
	}
	query += " ORDER BY m.`id` ASC"
	rows, err := exec.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("alertworker: list candidate memberships: %w", err)
	}
	defer rows.Close()
	rowsOut := make([]candidateMembership, 0, 32)
	for rows.Next() {
		var entry candidateMembership
		var eligible, fromLink sql.NullBool
		var permission sql.NullString
		if err := rows.Scan(&entry.UserID, &entry.MembershipID, &eligible, &fromLink, &permission); err != nil {
			return nil, fmt.Errorf("alertworker: scan candidate membership: %w", err)
		}
		entry.Eligible = eligible.Valid && eligible.Bool
		entry.FromLink = fromLink.Valid && fromLink.Bool
		if permission.Valid {
			value := permission.String
			entry.PermissionName = &value
		}
		rowsOut = append(rowsOut, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("alertworker: iterate candidate memberships: %w", err)
	}
	return rowsOut, nil
}

// listActiveMemberUserIDs is the notifyAll candidate query:
// `membership.findMany({where: {orgId, user: {isActive: true}},
// select: {userId}})`.
func (r *repository) listActiveMemberUserIDs(ctx context.Context, exec sqlExecutor, orgID string) ([]string, error) {
	rows, err := exec.QueryContext(ctx,
		"SELECT m.`userId` FROM `Membership` `m` JOIN `User` `u` ON `u`.`id` = m.`userId`"+
			" WHERE m.`orgId` = ? AND u.`isActive` = 1 ORDER BY m.`id` ASC", orgID)
	if err != nil {
		return nil, fmt.Errorf("alertworker: list active member user ids: %w", err)
	}
	defer rows.Close()
	userIDs := make([]string, 0, 16)
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			return nil, fmt.Errorf("alertworker: scan active member user id: %w", err)
		}
		userIDs = append(userIDs, userID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("alertworker: iterate active member user ids: %w", err)
	}
	return userIDs, nil
}

func nullStringPtr(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	copied := value.String
	return &copied
}

func nullFloatPtr(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	copied := value.Float64
	return &copied
}

func nullableJSON(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return value
}

func parseNullableDecimal(value sql.NullString) *float64 {
	if !value.Valid {
		return nil
	}
	parsed, ok := parseDecimalString(value.String)
	if !ok {
		return nil
	}
	return &parsed
}
