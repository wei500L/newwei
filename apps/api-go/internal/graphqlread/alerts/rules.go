package alerts

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/go-sql-driver/mysql"

	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// ruleDB is the query surface shared by *sql.DB and *sql.Tx.
type ruleDB interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

const alertRuleSelect = "SELECT `id`, `orgId`, `name`, `description`, `severity`, `status`, `metricProvider`, " +
	"`metricSlug`, `operator`, `thresholdValue`, `thresholdLower`, `thresholdUpper`, `changeWindowMin`, " +
	"`cooldownSeconds`, `checkIntervalSec`, `lastTriggeredAt`, `metadata`, `createdAt` " +
	"FROM `AlertRule` WHERE `orgId` = ?"

// alertRuleChannelSelect reads the channel links of one organization's rules.
//
// The join to AlertRule and the c.orgId = r.orgId condition keep a historical
// cross-organization link from leaking another tenant's channel target and
// config (B1). ORDER BY ruleId, channelId only makes the order stable: Prisma
// reads relations without ORDER BY, and the unique (ruleId, channelId) index
// scans in exactly this order, so no caller can depend on a different one.
const alertRuleChannelSelect = "SELECT l.`ruleId`, c.`id`, c.`name`, c.`type`, c.`target`, c.`isActive`, " +
	"c.`config`, c.`createdAt`, c.`updatedAt` " +
	"FROM `AlertRuleChannel` AS l " +
	"INNER JOIN `AlertNotificationChannel` AS c ON c.`id` = l.`channelId` " +
	"INNER JOIN `AlertRule` AS r ON r.`id` = l.`ruleId` " +
	"WHERE r.`orgId` = ? AND c.`orgId` = r.`orgId`"

// alertRules lists one organization's rules, creating the missing system
// default rules first exactly like AlertsService.listRules. ruleID empty means
// every rule of the organization.
//
// The createdAt ascending order matches the NestJS query; id ascending is the
// tie-break. The 17 default rules are inserted in one burst, and MySQL's
// DATETIME(3) only keeps milliseconds, so several rows legitimately share a
// createdAt. Without the deterministic tie-break their relative order would be
// engine-dependent and the console list would reshuffle between reads.
func alertRules(ctx context.Context, db *sql.DB, queue RuleQueue, orgID, traceID string) ([]AlertRuleModel, error) {
	if err := requireDB(db); err != nil {
		return nil, err
	}
	if err := ensureDefaultRules(ctx, db, queue, orgID, traceID); err != nil {
		return nil, err
	}
	return loadRuleModels(ctx, db, orgID, "")
}

// loadRuleModel reloads exactly one rule of the organization, with its
// channels. It returns (nil, nil) when the rule does not exist or belongs to
// another organization.
func loadRuleModel(ctx context.Context, db *sql.DB, orgID, ruleID string) (*AlertRuleModel, error) {
	models, err := loadRuleModels(ctx, db, orgID, ruleID)
	if err != nil {
		return nil, err
	}
	if len(models) == 0 {
		return nil, nil
	}
	return &models[0], nil
}

// loadRuleModels reads the rules and their channel links in two queries (one
// for the rules, one for every link of the organization) instead of one query
// per rule.
func loadRuleModels(ctx context.Context, db *sql.DB, orgID, ruleID string) ([]AlertRuleModel, error) {
	rows, err := queryRuleRows(ctx, db, orgID, ruleID)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return []AlertRuleModel{}, nil
	}
	channels, err := loadRuleChannels(ctx, db, orgID, ruleID)
	if err != nil {
		return nil, err
	}
	models := make([]AlertRuleModel, 0, len(rows))
	for _, row := range rows {
		models = append(models, projectRule(row, channels[row.ID]))
	}
	return models, nil
}

func queryRuleRows(ctx context.Context, db ruleDB, orgID, ruleID string) ([]ruleRow, error) {
	query := alertRuleSelect
	args := []any{orgID}
	if ruleID != "" {
		query += " AND `id` = ?"
		args = append(args, ruleID)
	}
	query += " ORDER BY `createdAt` ASC, `id` ASC"
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, queryErr("list alert rules", err)
	}
	defer rows.Close()

	rules := make([]ruleRow, 0)
	for rows.Next() {
		row, err := scanRuleRow(rows)
		if err != nil {
			return nil, err
		}
		rules = append(rules, row)
	}
	if err := rows.Err(); err != nil {
		return nil, queryErr("list alert rules", err)
	}
	if err := rows.Close(); err != nil {
		return nil, queryErr("list alert rules", err)
	}
	return rules, nil
}

func scanRuleRow(scanner rowScanner) (ruleRow, error) {
	var (
		row              ruleRow
		description      sql.NullString
		thresholdValue   sql.NullString
		thresholdLower   sql.NullString
		thresholdUpper   sql.NullString
		changeWindowMin  sql.NullInt64
		lastTriggeredAt  sql.NullTime
		metadata         []byte
		createdAt        time.Time
		cooldownSeconds  int64
		checkIntervalSec int64
	)
	if err := scanner.Scan(
		&row.ID,
		&row.OrgID,
		&row.Name,
		&description,
		&row.Severity,
		&row.Status,
		&row.MetricProvider,
		&row.MetricSlug,
		&row.Operator,
		&thresholdValue,
		&thresholdLower,
		&thresholdUpper,
		&changeWindowMin,
		&cooldownSeconds,
		&checkIntervalSec,
		&lastTriggeredAt,
		&metadata,
		&createdAt,
	); err != nil {
		return ruleRow{}, queryErr("scan alert rule", err)
	}
	row.Description = nullStringPtr(description)
	row.ThresholdValue = optDecimal(thresholdValue)
	row.ThresholdLower = optDecimal(thresholdLower)
	row.ThresholdUpper = optDecimal(thresholdUpper)
	row.ChangeWindowMin = nullWindow(changeWindowMin)
	row.CooldownSeconds = float64(cooldownSeconds)
	row.CheckIntervalSec = float64(checkIntervalSec)
	row.LastTriggeredAt = nullTimePtr(lastTriggeredAt)
	row.Metadata = jsonScalar(metadata)
	row.CreatedAt = utcTime(createdAt)
	return row, nil
}

// projectRule applies the resolver projection: metricSlug is alias-normalized
// and trimmed, decimals go through the finite-number rule, and every linked
// channel (including inactive ones) is returned.
func projectRule(row ruleRow, channels []AlertChannelModel) AlertRuleModel {
	if channels == nil {
		channels = []AlertChannelModel{}
	}
	return AlertRuleModel{
		ID:               row.ID,
		Name:             row.Name,
		Description:      row.Description,
		Severity:         row.Severity,
		Status:           row.Status,
		MetricProvider:   row.MetricProvider,
		MetricSlug:       normalizeMetricSlug(row.MetricSlug),
		Operator:         row.Operator,
		ThresholdValue:   row.ThresholdValue,
		ThresholdLower:   row.ThresholdLower,
		ThresholdUpper:   row.ThresholdUpper,
		ChangeWindowMin:  row.ChangeWindowMin,
		CooldownSeconds:  row.CooldownSeconds,
		CheckIntervalSec: row.CheckIntervalSec,
		LastTriggeredAt:  row.LastTriggeredAt,
		Metadata:         row.Metadata,
		Channels:         channels,
	}
}

// loadRuleChannels reads every channel link of the organization's rules, keyed
// by rule id.
func loadRuleChannels(ctx context.Context, db ruleDB, orgID, ruleID string) (map[string][]AlertChannelModel, error) {
	query := alertRuleChannelSelect
	args := []any{orgID}
	if ruleID != "" {
		query += " AND r.`id` = ?"
		args = append(args, ruleID)
	}
	query += " ORDER BY l.`ruleId` ASC, l.`channelId` ASC"
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, queryErr("list alert rule channels", err)
	}
	defer rows.Close()

	channels := map[string][]AlertChannelModel{}
	for rows.Next() {
		var (
			ruleID   string
			channel  AlertChannelModel
			config   []byte
			created  time.Time
			updated  time.Time
			isActive bool
		)
		if err := rows.Scan(
			&ruleID,
			&channel.ID,
			&channel.Name,
			&channel.Type,
			&channel.Target,
			&isActive,
			&config,
			&created,
			&updated,
		); err != nil {
			return nil, queryErr("scan alert rule channel", err)
		}
		channel.IsActive = isActive
		channel.Config = jsonScalar(config)
		channel.CreatedAt = utcTime(created)
		channel.UpdatedAt = utcTime(updated)
		channels[ruleID] = append(channels[ruleID], channel)
	}
	if err := rows.Err(); err != nil {
		return nil, queryErr("list alert rule channels", err)
	}
	if err := rows.Close(); err != nil {
		return nil, queryErr("list alert rule channels", err)
	}
	return channels, nil
}

// createdDefaultRule is the minimum a freshly created default rule needs for
// the post-insert side effects.
type createdDefaultRule struct {
	ID               string
	CheckIntervalSec int
}

// ensureDefaultRules creates the missing default rules for the organization.
//
// The existing slugs are read with one query covering the three default
// providers. Only a successfully inserted rule gets its schedule (T5) and one
// evaluation task; a primary-key duplicate (MySQL 1062, Prisma P2002) means a
// concurrent request won the race, and that request already scheduled the rule.
func ensureDefaultRules(ctx context.Context, db *sql.DB, queue RuleQueue, orgID, traceID string) error {
	existing, err := loadDefaultRuleSlugs(ctx, db, orgID)
	if err != nil {
		return err
	}
	if queue == nil {
		return errors.New("alerts: alert queue is not configured")
	}
	for _, group := range defaultRuleGroups {
		// A provider with no stored rule has no inner map yet; initialize it so a
		// successful insert can be recorded for the rest of the loop.
		providerSlugs := existing[group.Provider]
		if providerSlugs == nil {
			providerSlugs = map[string]bool{}
			existing[group.Provider] = providerSlugs
		}
		for _, definition := range group.Definitions {
			metricSlug := normalizeMetricSlug(definition.MetricSlug)
			if providerSlugs[metricSlug] {
				continue
			}
			created, err := insertDefaultRule(ctx, db, orgID, group, definition, metricSlug)
			if err != nil {
				if isDuplicateKey(err) {
					// A concurrent alertRules request inserted the same
					// deterministic id; it owns the schedule and the evaluation.
					continue
				}
				return err
			}
			if err := queue.EnsureRuleSchedule(ctx, created.ID, orgID, created.CheckIntervalSec, true); err != nil {
				return err
			}
			if err := queue.EnqueueRuleCheck(ctx, created.ID, orgID, traceID); err != nil {
				return err
			}
			providerSlugs[metricSlug] = true
		}
	}
	return nil
}

// loadDefaultRuleSlugs reads the organization's existing slugs for the three
// default-rule providers in one query.
func loadDefaultRuleSlugs(ctx context.Context, db *sql.DB, orgID string) (map[string]map[string]bool, error) {
	providers := make([]any, 0, len(defaultRuleGroups))
	slugPlaceholders := placeholders(len(defaultRuleGroups))
	for _, group := range defaultRuleGroups {
		providers = append(providers, group.Provider)
	}
	args := append([]any{orgID}, providers...)
	rows, err := db.QueryContext(ctx,
		"SELECT `metricProvider`, `metricSlug` FROM `AlertRule` WHERE `orgId` = ? AND `metricProvider` IN ("+
			slugPlaceholders+")", args...)
	if err != nil {
		return nil, queryErr("list default rule slugs", err)
	}
	defer rows.Close()

	existing := map[string]map[string]bool{}
	for rows.Next() {
		var provider, slug string
		if err := rows.Scan(&provider, &slug); err != nil {
			return nil, queryErr("scan default rule slug", err)
		}
		normalized := normalizeMetricSlug(slug)
		if normalized == "" {
			continue
		}
		if existing[provider] == nil {
			existing[provider] = map[string]bool{}
		}
		existing[provider][normalized] = true
	}
	if err := rows.Err(); err != nil {
		return nil, queryErr("list default rule slugs", err)
	}
	if err := rows.Close(); err != nil {
		return nil, queryErr("list default rule slugs", err)
	}
	return existing, nil
}

// insertDefaultRule writes one system default rule with the deterministic id
// and returns it for the schedule and evaluation side effects.
func insertDefaultRule(ctx context.Context, db *sql.DB, orgID string, group defaultRuleGroup, definition defaultRuleDefinition, metricSlug string) (createdDefaultRule, error) {
	metadata, err := json.Marshal(defaultRuleMetadata{
		SystemDefault:  true,
		DefaultRuleKey: definition.Key,
		Version:        1,
	})
	if err != nil {
		return createdDefaultRule{}, err
	}
	id := defaultAlertRuleID(group.IDPrefix, definition.Key, orgID)
	now := nowTime()
	if _, err := db.ExecContext(ctx,
		"INSERT INTO `AlertRule` (`id`, `orgId`, `name`, `description`, `severity`, `status`, `metricProvider`, "+
			"`dataItemId`, `metricSlug`, `operator`, `thresholdValue`, `thresholdLower`, `thresholdUpper`, "+
			"`changeWindowMin`, `cooldownSeconds`, `checkIntervalSec`, `lastTriggeredAt`, `metadata`, "+
			"`createdById`, `createdAt`, `updatedAt`) "+
			"VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, 60, ?, 300, NULL, CAST(? AS JSON), NULL, ?, ?)",
		id, orgID, definition.Name, definition.Description, definition.Severity, statusActive,
		group.Provider, metricSlug, definition.Operator, definition.ThresholdValue,
		group.CooldownSeconds, string(metadata), now, now,
	); err != nil {
		return createdDefaultRule{}, err
	}
	return createdDefaultRule{ID: id, CheckIntervalSec: 300}, nil
}

// isDuplicateKey reports a MySQL duplicate-primary-key error (1062), the
// equivalent of Prisma's P2002.
func isDuplicateKey(err error) bool {
	var mysqlErr *mysql.MySQLError
	if errors.As(err, &mysqlErr) {
		return mysqlErr.Number == 1062
	}
	return false
}

// nowTime is the millisecond UTC timestamp written to DATETIME(3) columns.
// Prisma's @updatedAt has no database default, so Go must supply it.
func nowTime() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// ruleMissingMessage is the ordinary Error the NestJS service raises when the
// id exists but belongs to another organization; the exception filter reports
// it as 500 / Internal server error.
const ruleMissingMessage = "Alert rule not found for this org"

// channelMissingMessage is the ordinary Error of the B1 validation.
const channelMissingMessage = "Alert channel not found for this org"

// ruleState is the subset of a stored rule the upsert branch needs.
type ruleState struct {
	ID             string
	OrgID          string
	MetricProvider string
}

// loadRuleState reads one rule by id without an organization filter so the
// caller can distinguish "missing" from "another tenant".
func loadRuleState(ctx context.Context, db ruleDB, ruleID string) (*ruleState, error) {
	var state ruleState
	err := db.QueryRowContext(ctx,
		"SELECT `id`, `orgId`, `metricProvider` FROM `AlertRule` WHERE `id` = ? LIMIT 1", ruleID).
		Scan(&state.ID, &state.OrgID, &state.MetricProvider)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, queryErr("load alert rule", err)
	}
	return &state, nil
}

// dataItemIDForSlug resolves the EconomicDataItem of a metric slug. The item is
// read-only here: the upsert never writes EconomicDataItem.
func dataItemIDForSlug(ctx context.Context, db ruleDB, metricSlug string) (*string, error) {
	var id string
	err := db.QueryRowContext(ctx,
		"SELECT `id` FROM `EconomicDataItem` WHERE `slug` = ? LIMIT 1", metricSlug).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, queryErr("load economic data item", err)
	}
	return &id, nil
}

// validateChannelOwnership checks that every unique channel id belongs to the
// organization. It runs inside the transaction before any row is written, so a
// cross-organization link aborts the whole save (B1).
func validateChannelOwnership(ctx context.Context, db ruleDB, orgID string, channelIDs []string) error {
	if len(channelIDs) == 0 {
		return nil
	}
	args := make([]any, 0, len(channelIDs)+1)
	args = append(args, orgID)
	for _, id := range channelIDs {
		args = append(args, id)
	}
	var count int
	err := db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM `AlertNotificationChannel` WHERE `orgId` = ? AND `id` IN ("+
			placeholders(len(channelIDs))+")", args...).Scan(&count)
	if err != nil {
		return queryErr("validate alert channels", err)
	}
	if count != len(channelIDs) {
		return errors.New(channelMissingMessage)
	}
	return nil
}

// dedupeChannelIDs removes duplicates in first-occurrence order (B2). The input
// [a, a] would otherwise violate AlertRuleChannel's unique (ruleId, channelId)
// constraint and fail the whole save.
func dedupeChannelIDs(channelIDs []string) []string {
	unique := make([]string, 0, len(channelIDs))
	seen := make(map[string]struct{}, len(channelIDs))
	for _, id := range channelIDs {
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		unique = append(unique, id)
	}
	return unique
}

// currentValueFinite reports whether metadata.currentValue is a finite JSON
// number, mirroring `typeof input.metadata.currentValue === "number"` plus
// Number.isFinite. A non-object metadata document has no such member.
//
// The leaf is decoded through an interface value, not json.Number: json.Number
// is a string type, so decoding a JSON string into it would succeed and turn
// "5" into 5. encoding/json decodes a JSON number into float64 and every other
// JSON type into a non-float64, which is exactly the typeof check.
func currentValueFinite(metadata json.RawMessage) bool {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(metadata, &fields); err != nil {
		return false
	}
	raw, ok := fields["currentValue"]
	if !ok {
		return false
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return false
	}
	number, ok := value.(float64)
	if !ok {
		return false
	}
	return isFinite(number)
}

// ensureProducer guards the resolver boundary. main always constructs the
// producer when the switch is go; a nil producer means the assembly is wrong.
func ensureProducer(queue RuleQueue) error {
	if queue == nil {
		return errors.New("alerts: alert queue is not configured")
	}
	return nil
}

// errRuleReload mirrors the resolver's "Failed to reload rule" ordinary Error.
var errRuleReload = errors.New("Failed to reload rule")

// traceIDFromContext returns the request trace id in the ensureTraceId shape.
// The HTTP trace middleware already stores a normalized id; EnsureTraceID is
// idempotent for it and generates 16 random bytes when the context has none.
func traceIDFromContext(ctx context.Context) string {
	return httpx.EnsureTraceID(httpx.TraceIDFromContext(ctx))
}
