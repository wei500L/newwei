//go:build integration

// Alert rule migration integration tests. They run against the real MySQL 8.4
// and Redis 7.2 services of the existing api-go-user-settings-integration CI
// job: `go test -tags=integration ./internal/graphqlread/alerts/ -run
// 'TestAlertRules'`.
//
// The test schema mirrors the Prisma columns, the unique (ruleId, channelId)
// index and the ON DELETE CASCADE foreign keys the migration relies on. The
// Redis assertions read the raw bull:alerts:* structures (wait list, delayed
// zset, repeat zset and repeat hash, job hash fields) instead of trusting the
// producer's own output.
//
// Environment (the CI job already provides both):
//
//	DATABASE_URL=mysql://root:secret@127.0.0.1:3306/app
//	API_GO_TEST_REDIS_ADDR=127.0.0.1:6379
package alerts

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/alertqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

func openAlertRulesDB(t *testing.T) *sql.DB {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set — integration test requires a MySQL service")
	}
	db, err := usersettings.OpenMySQLFromURL(url)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func openAlertRulesRedis(t *testing.T) *redis.Client {
	t.Helper()
	addr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if addr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR not set — integration test requires a Redis service")
	}
	client := redis.NewClient(&redis.Options{Addr: addr, Protocol: 2})
	t.Cleanup(func() { _ = client.Close() })
	return client
}

var alertRulesTables = []string{
	"CREATE TABLE IF NOT EXISTS `AlertRule` (" +
		"`id` VARCHAR(191) NOT NULL," +
		"`orgId` VARCHAR(191) NOT NULL," +
		"`name` VARCHAR(191) NOT NULL," +
		"`description` VARCHAR(191) NULL," +
		"`severity` VARCHAR(16) NOT NULL DEFAULT 'medium'," +
		"`status` VARCHAR(16) NOT NULL DEFAULT 'active'," +
		"`metricProvider` VARCHAR(32) NOT NULL DEFAULT 'economic_data'," +
		"`dataItemId` VARCHAR(191) NULL," +
		"`metricSlug` VARCHAR(191) NOT NULL," +
		"`operator` VARCHAR(32) NOT NULL," +
		"`thresholdValue` DECIMAL(38, 12) NULL," +
		"`thresholdLower` DECIMAL(38, 12) NULL," +
		"`thresholdUpper` DECIMAL(38, 12) NULL," +
		"`changeWindowMin` INT NULL," +
		"`cooldownSeconds` INT NOT NULL DEFAULT 3600," +
		"`checkIntervalSec` INT NOT NULL DEFAULT 300," +
		"`lastTriggeredAt` DATETIME(3) NULL," +
		"`metadata` JSON NULL," +
		"`createdById` VARCHAR(191) NULL," +
		"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
		"`updatedAt` DATETIME(3) NOT NULL," +
		"PRIMARY KEY (`id`)" +
		") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	"CREATE TABLE IF NOT EXISTS `AlertNotificationChannel` (" +
		"`id` VARCHAR(191) NOT NULL," +
		"`orgId` VARCHAR(191) NOT NULL," +
		"`type` VARCHAR(16) NOT NULL," +
		"`name` VARCHAR(80) NOT NULL," +
		"`target` VARCHAR(191) NOT NULL," +
		"`config` JSON NULL," +
		"`isActive` TINYINT(1) NOT NULL DEFAULT 1," +
		"`createdById` VARCHAR(191) NULL," +
		"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
		"`updatedAt` DATETIME(3) NOT NULL," +
		"PRIMARY KEY (`id`)" +
		") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	"CREATE TABLE IF NOT EXISTS `AlertEvent` (" +
		"`id` VARCHAR(191) NOT NULL," +
		"`ruleId` VARCHAR(191) NOT NULL," +
		"`triggeredAt` DATETIME(3) NOT NULL," +
		"`metricValue` DECIMAL(38, 12) NOT NULL," +
		"`changePercent` DOUBLE NULL," +
		"`severity` VARCHAR(16) NOT NULL," +
		"`status` VARCHAR(16) NOT NULL DEFAULT 'pending'," +
		"`message` VARCHAR(191) NULL," +
		"`context` JSON NULL," +
		"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
		"PRIMARY KEY (`id`)," +
		"KEY `AlertEvent_rule` (`ruleId`)," +
		"CONSTRAINT `it_AlertEvent_rule_fkey` FOREIGN KEY (`ruleId`) REFERENCES `AlertRule` (`id`) ON DELETE CASCADE" +
		") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	"CREATE TABLE IF NOT EXISTS `AlertDelivery` (" +
		"`id` VARCHAR(191) NOT NULL," +
		"`eventId` VARCHAR(191) NOT NULL," +
		"`channelId` VARCHAR(191) NULL," +
		"`channelType` VARCHAR(16) NOT NULL," +
		"`targetSnapshot` JSON NULL," +
		"`status` VARCHAR(16) NOT NULL DEFAULT 'pending'," +
		"`error` VARCHAR(191) NULL," +
		"`sentAt` DATETIME(3) NULL," +
		"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
		"PRIMARY KEY (`id`)," +
		"KEY `AlertDelivery_event` (`eventId`)," +
		"CONSTRAINT `it_AlertDelivery_event_fkey` FOREIGN KEY (`eventId`) REFERENCES `AlertEvent` (`id`) ON DELETE CASCADE" +
		") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	"CREATE TABLE IF NOT EXISTS `AlertRuleChannel` (" +
		"`id` VARCHAR(191) NOT NULL," +
		"`ruleId` VARCHAR(191) NOT NULL," +
		"`channelId` VARCHAR(191) NOT NULL," +
		"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
		"UNIQUE KEY `it_AlertRuleChannel_rule_channel` (`ruleId`, `channelId`)," +
		"PRIMARY KEY (`id`)," +
		"CONSTRAINT `it_AlertRuleChannel_rule_fkey` FOREIGN KEY (`ruleId`) REFERENCES `AlertRule` (`id`) ON DELETE CASCADE," +
		"CONSTRAINT `it_AlertRuleChannel_channel_fkey` FOREIGN KEY (`channelId`) REFERENCES `AlertNotificationChannel` (`id`) ON DELETE CASCADE" +
		") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	"CREATE TABLE IF NOT EXISTS `EconomicDataItem` (" +
		"`id` VARCHAR(191) NOT NULL," +
		"`slug` VARCHAR(191) NOT NULL," +
		"`displayName` VARCHAR(191) NOT NULL," +
		"PRIMARY KEY (`id`)," +
		"UNIQUE KEY `EconomicDataItem_slug` (`slug`)" +
		") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
}

func prepareAlertRulesIntegration(t *testing.T) (*sql.DB, *redis.Client) {
	t.Helper()
	db := openAlertRulesDB(t)
	client := openAlertRulesRedis(t)
	ctx := context.Background()
	for _, statement := range alertRulesTables {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("create alert rules fixtures: %v", err)
		}
	}
	return db, client
}

func purgeAlertRulesOrg(t *testing.T, db *sql.DB, orgIDs ...string) {
	t.Helper()
	for _, orgID := range orgIDs {
		if _, err := db.Exec("DELETE FROM `AlertRule` WHERE `orgId` = ?", orgID); err != nil {
			t.Fatalf("purge rules: %v", err)
		}
		if _, err := db.Exec("DELETE FROM `AlertNotificationChannel` WHERE `orgId` = ?", orgID); err != nil {
			t.Fatalf("purge channels: %v", err)
		}
	}
}

// purgeAlertQueue removes every bull:alerts:* key so the raw-structure
// assertions see only the writes under test.
func purgeAlertQueue(t *testing.T, client *redis.Client) {
	t.Helper()
	ctx := context.Background()
	var cursor uint64
	for {
		keys, next, err := client.Scan(ctx, cursor, "bull:alerts:*", 200).Result()
		if err != nil {
			t.Fatalf("scan alert queue keys: %v", err)
		}
		if len(keys) > 0 {
			if err := client.Del(ctx, keys...).Err(); err != nil {
				t.Fatalf("delete alert queue keys: %v", err)
			}
		}
		if next == 0 {
			break
		}
		cursor = next
	}
}

func countRows(t *testing.T, db *sql.DB, query string, args ...any) int {
	t.Helper()
	var count int
	if err := db.QueryRow(query, args...).Scan(&count); err != nil {
		t.Fatalf("count rows: %v", err)
	}
	return count
}

func insertAlertChannel(t *testing.T, db *sql.DB, id, orgID string) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := db.Exec(
		"INSERT INTO `AlertNotificationChannel` (`id`, `orgId`, `type`, `name`, `target`, `config`, `isActive`, `createdAt`, `updatedAt`) "+
			"VALUES (?, ?, 'email', ?, ?, CAST('{}' AS JSON), 1, ?, ?)",
		id, orgID, id, "alerts-it@example.com", now, now); err != nil {
		t.Fatalf("insert channel: %v", err)
	}
}

func insertAlertRule(t *testing.T, db *sql.DB, id, orgID, name, status string, checkIntervalSec int) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := db.Exec(
		"INSERT INTO `AlertRule` (`id`, `orgId`, `name`, `severity`, `status`, `metricProvider`, `metricSlug`, "+
			"`operator`, `cooldownSeconds`, `checkIntervalSec`, `metadata`, `createdAt`, `updatedAt`) "+
			"VALUES (?, ?, ?, 'medium', ?, 'crawl_task', 'crawl_quality.http_304_hit_rate', 'lte', 3600, ?, CAST('{}' AS JSON), ?, ?)",
		id, orgID, name, status, checkIntervalSec, now, now); err != nil {
		t.Fatalf("insert rule: %v", err)
	}
}

func insertAlertEvent(t *testing.T, db *sql.DB, id, ruleID string) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := db.Exec(
		"INSERT INTO `AlertEvent` (`id`, `ruleId`, `triggeredAt`, `metricValue`, `severity`, `status`, `createdAt`) "+
			"VALUES (?, ?, ?, 1.0, 'medium', 'pending', ?)", id, ruleID, now, now); err != nil {
		t.Fatalf("insert event: %v", err)
	}
}

func insertAlertDelivery(t *testing.T, db *sql.DB, id, eventID string) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := db.Exec(
		"INSERT INTO `AlertDelivery` (`id`, `eventId`, `channelType`, `status`, `createdAt`) VALUES (?, ?, 'email', 'pending', ?)",
		id, eventID, now); err != nil {
		t.Fatalf("insert delivery: %v", err)
	}
}

func waitJobIDs(t *testing.T, client *redis.Client) []string {
	t.Helper()
	ids, err := client.LRange(context.Background(), "bull:alerts:wait", 0, -1).Result()
	if err != nil {
		t.Fatalf("read wait list: %v", err)
	}
	return ids
}

func delayedJobIDs(t *testing.T, client *redis.Client) []string {
	t.Helper()
	ids, err := client.ZRange(context.Background(), "bull:alerts:delayed", 0, -1).Result()
	if err != nil {
		t.Fatalf("read delayed zset: %v", err)
	}
	return ids
}

func repeatMembers(t *testing.T, client *redis.Client) []string {
	t.Helper()
	members, err := client.ZRange(context.Background(), "bull:alerts:repeat", 0, -1).Result()
	if err != nil {
		t.Fatalf("read repeat zset: %v", err)
	}
	return members
}

func jobFields(t *testing.T, client *redis.Client, jobID string) map[string]string {
	t.Helper()
	fields, err := client.HGetAll(context.Background(), "bull:alerts:"+jobID).Result()
	if err != nil {
		t.Fatalf("read job %s: %v", jobID, err)
	}
	return fields
}

func repeatRuleNames(t *testing.T, client *redis.Client) []string {
	t.Helper()
	members := repeatMembers(t, client)
	names := make([]string, 0, len(members))
	for _, member := range members {
		fields, err := client.HGetAll(context.Background(), "bull:alerts:repeat:"+member).Result()
		if err != nil {
			t.Fatalf("read repeat hash: %v", err)
		}
		names = append(names, fields["name"])
	}
	return names
}

// TestAlertRulesDefaultsBackfill checks T1: one call creates the 17 default
// rules and one schedule + one evaluation each, a second call adds nothing, and
// two concurrent first requests neither fail nor duplicate rows.
func TestAlertRulesDefaultsBackfill(t *testing.T) {
	db, client := prepareAlertRulesIntegration(t)
	producer := alertqueue.New(client)
	ctx := context.Background()

	const orgID = "org-it-alert-defaults"
	purgeAlertRulesOrg(t, db, orgID)
	purgeAlertQueue(t, client)

	rules, err := alertRules(ctx, db, producer, orgID, "trace-defaults")
	if err != nil {
		t.Fatalf("first alertRules: %v", err)
	}
	if len(rules) != 17 {
		t.Fatalf("first alertRules returned %d rules, want 17", len(rules))
	}
	if got := countRows(t, db, "SELECT COUNT(*) FROM `AlertRule` WHERE `orgId` = ?", orgID); got != 17 {
		t.Fatalf("stored default rules = %d, want 17", got)
	}
	if got := len(repeatMembers(t, client)); got != 17 {
		t.Fatalf("repeat schedules = %d, want 17", got)
	}
	if got := len(delayedJobIDs(t, client)); got != 17 {
		t.Fatalf("delayed jobs = %d, want 17", got)
	}
	if got := len(waitJobIDs(t, client)); got != 17 {
		t.Fatalf("evaluation jobs = %d, want 17", got)
	}
	// Each default rule has exactly one schedule named after it.
	names := repeatRuleNames(t, client)
	ruleIDs := map[string]bool{}
	for _, rule := range rules {
		ruleIDs[rule.ID] = true
	}
	for _, name := range names {
		if !strings.HasPrefix(name, "evaluate-rule:") || !ruleIDs[strings.TrimPrefix(name, "evaluate-rule:")] {
			t.Fatalf("unexpected repeat schedule name %q", name)
		}
	}
	// The second call must not duplicate rows or enqueue anything.
	second, err := alertRules(ctx, db, producer, orgID, "trace-defaults-2")
	if err != nil {
		t.Fatalf("second alertRules: %v", err)
	}
	if len(second) != 17 {
		t.Fatalf("second alertRules returned %d rules, want 17", len(second))
	}
	if got := countRows(t, db, "SELECT COUNT(*) FROM `AlertRule` WHERE `orgId` = ?", orgID); got != 17 {
		t.Fatalf("stored rules after second call = %d, want 17", got)
	}
	if got := len(repeatMembers(t, client)); got != 17 {
		t.Fatalf("repeat schedules after second call = %d, want 17", got)
	}
	if got := len(delayedJobIDs(t, client)); got != 17 {
		t.Fatalf("delayed jobs after second call = %d, want 17", got)
	}
	if got := len(waitJobIDs(t, client)); got != 17 {
		t.Fatalf("evaluation jobs after second call = %d, want 17", got)
	}

	// Two concurrent first requests for the same fresh organization.
	const concurrentOrg = "org-it-alert-concurrent"
	purgeAlertRulesOrg(t, db, concurrentOrg)
	purgeAlertQueue(t, client)
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for index := 0; index < 2; index++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			_, errs[index] = alertRules(ctx, db, producer, concurrentOrg, "trace-concurrent")
		}(index)
	}
	wg.Wait()
	for index, err := range errs {
		if err != nil {
			t.Fatalf("concurrent alertRules[%d]: %v", index, err)
		}
	}
	if got := countRows(t, db, "SELECT COUNT(*) FROM `AlertRule` WHERE `orgId` = ?", concurrentOrg); got != 17 {
		t.Fatalf("concurrent stored rules = %d, want 17", got)
	}
	if got := len(repeatMembers(t, client)); got != 17 {
		t.Fatalf("concurrent repeat schedules = %d, want 17", got)
	}
	if got := len(delayedJobIDs(t, client)); got != 17 {
		t.Fatalf("concurrent delayed jobs = %d, want 17", got)
	}
}

// TestAlertRulesUpsert covers T2, B2, B3 and Q1: create, schedule, evaluation,
// channel replacement, the three description states, duplicate channel ids,
// interval replacement, the custom.manual guard and the economic_data item
// link.
func TestAlertRulesUpsert(t *testing.T) {
	db, client := prepareAlertRulesIntegration(t)
	producer := alertqueue.New(client)
	ctx := context.Background()

	const orgID = "org-it-alert-upsert"
	purgeAlertRulesOrg(t, db, orgID)
	purgeAlertQueue(t, client)
	insertAlertChannel(t, db, "chan-it-1", orgID)
	insertAlertChannel(t, db, "chan-it-2", orgID)

	input := mustParseRuleInput(t, map[string]any{
		"name":           "Manual rule",
		"description":    "first",
		"severity":       "high",
		"status":         "active",
		"metricProvider": "pipeline_job",
		"metricSlug":     " pipeline.success_rate ",
		"operator":       "lte",
		"thresholdValue": float64(0.8),
		// B2: duplicate channel ids save once instead of failing on the unique
		// (ruleId, channelId) index.
		"channelIds":       []any{"chan-it-1", "chan-it-1", "chan-it-2"},
		"checkIntervalSec": int64(300),
		"metadata":         map[string]any{"origin": "integration"},
	})
	model, err := upsertRule(ctx, db, producer, orgID, "user-it-1", input, "trace-upsert")
	if err != nil {
		t.Fatalf("create rule: %v", err)
	}
	if model.ID == "" || model.Name != "Manual rule" || model.MetricSlug != "pipeline.success_rate" {
		t.Fatalf("created rule = %+v", model)
	}
	if model.Description == nil || *model.Description != "first" {
		t.Fatalf("created description = %+v", model.Description)
	}
	if len(model.Channels) != 2 {
		t.Fatalf("created rule channels = %d, want 2", len(model.Channels))
	}
	if got := countRows(t, db, "SELECT COUNT(*) FROM `AlertRuleChannel` WHERE `ruleId` = ?", model.ID); got != 2 {
		t.Fatalf("stored links = %d, want 2", got)
	}
	var createdBy sql.NullString
	if err := db.QueryRow("SELECT `createdById` FROM `AlertRule` WHERE `id` = ?", model.ID).Scan(&createdBy); err != nil {
		t.Fatal(err)
	}
	if !createdBy.Valid || createdBy.String != "user-it-1" {
		t.Fatalf("createdById = %+v", createdBy)
	}

	// Evaluation job: name, data and opts must be the BullMQ shapes.
	wait := waitJobIDs(t, client)
	if len(wait) != 1 {
		t.Fatalf("wait jobs = %v, want 1", wait)
	}
	jobID := wait[0]
	if !strings.HasPrefix(jobID, "evaluate:"+model.ID+":") {
		t.Fatalf("job id = %q", jobID)
	}
	fields := jobFields(t, client, jobID)
	if fields["name"] != "evaluate-rule:"+model.ID {
		t.Fatalf("job name = %q", fields["name"])
	}
	var data struct {
		Type    string `json:"type"`
		RuleID  string `json:"ruleId"`
		OrgID   string `json:"orgId"`
		TraceID string `json:"traceId"`
	}
	if err := json.Unmarshal([]byte(fields["data"]), &data); err != nil {
		t.Fatalf("decode job data: %v", err)
	}
	if data.Type != "evaluate" || data.RuleID != model.ID || data.OrgID != orgID || data.TraceID != "trace-upsert" {
		t.Fatalf("job data = %+v", data)
	}
	var opts struct {
		JobID            string `json:"jobId"`
		RemoveOnComplete bool   `json:"removeOnComplete"`
		RemoveOnFail     struct {
			Age   int64 `json:"age"`
			Count int64 `json:"count"`
		} `json:"removeOnFail"`
	}
	if err := json.Unmarshal([]byte(fields["opts"]), &opts); err != nil {
		t.Fatalf("decode job opts: %v", err)
	}
	if opts.JobID != jobID || !opts.RemoveOnComplete || opts.RemoveOnFail.Age != 604800 || opts.RemoveOnFail.Count != 10000 {
		t.Fatalf("job opts = %+v", opts)
	}
	if fields["delay"] != "0" || fields["priority"] != "0" {
		t.Fatalf("job delay/priority = %q/%q", fields["delay"], fields["priority"])
	}

	// Schedule: exactly one repeat hash named after the rule, with every=300000.
	assertRuleSchedule(t, client, model.ID, 300000)

	// Update: change the interval and omit the description (must stay "first").
	update := mustParseRuleInput(t, map[string]any{
		"id":               model.ID,
		"name":             "Manual rule v2",
		"metricSlug":       "pipeline.success_rate",
		"operator":         "gte",
		"checkIntervalSec": int64(600),
	})
	model, err = upsertRule(ctx, db, producer, orgID, "user-it-1", update, "trace-upsert-2")
	if err != nil {
		t.Fatalf("update rule: %v", err)
	}
	if model.Name != "Manual rule v2" {
		t.Fatalf("updated name = %q", model.Name)
	}
	if model.Description == nil || *model.Description != "first" {
		t.Fatalf("omitted description changed to %+v", model.Description)
	}
	if len(model.Channels) != 2 {
		t.Fatalf("omitted channelIds changed links to %d", len(model.Channels))
	}
	// B3: the old interval must be gone, not kept next to the new one.
	assertRuleSchedule(t, client, model.ID, 600000)

	// Explicit null description writes NULL.
	explicitNull := mustParseRuleInput(t, map[string]any{
		"id":          model.ID,
		"name":        "Manual rule v3",
		"metricSlug":  "pipeline.success_rate",
		"operator":    "gte",
		"description": nil,
	})
	model, err = upsertRule(ctx, db, producer, orgID, "user-it-1", explicitNull, "trace-upsert-3")
	if err != nil {
		t.Fatalf("null description: %v", err)
	}
	if model.Description != nil {
		t.Fatalf("null description = %+v", model.Description)
	}

	// An omitted description on a later update keeps the NULL.
	keepNull := mustParseRuleInput(t, map[string]any{
		"id":         model.ID,
		"name":       "Manual rule v4",
		"metricSlug": "pipeline.success_rate",
		"operator":   "gte",
	})
	model, err = upsertRule(ctx, db, producer, orgID, "user-it-1", keepNull, "trace-upsert-4")
	if err != nil {
		t.Fatalf("omitted description after null: %v", err)
	}
	if model.Description != nil {
		t.Fatalf("omitted description after null = %+v", model.Description)
	}

	// An empty channelIds array clears every link.
	clear := mustParseRuleInput(t, map[string]any{
		"id":         model.ID,
		"name":       "Manual rule v5",
		"metricSlug": "pipeline.success_rate",
		"operator":   "gte",
		"channelIds": []any{},
	})
	model, err = upsertRule(ctx, db, producer, orgID, "user-it-1", clear, "trace-upsert-5")
	if err != nil {
		t.Fatalf("clear channels: %v", err)
	}
	if len(model.Channels) != 0 {
		t.Fatalf("cleared channels = %d", len(model.Channels))
	}

	// Q1: an explicit null threshold is stored as NULL rather than throwing.
	nullThreshold := mustParseRuleInput(t, map[string]any{
		"name":           "Null threshold rule",
		"metricSlug":     "pipeline.failure_rate",
		"operator":       "gte",
		"thresholdValue": nil,
	})
	nullModel, err := upsertRule(ctx, db, producer, orgID, "user-it-1", nullThreshold, "trace-upsert-6")
	if err != nil {
		t.Fatalf("null threshold: %v", err)
	}
	if nullModel.ThresholdValue != nil {
		t.Fatalf("thresholdValue = %+v, want nil", nullModel.ThresholdValue)
	}

	// custom.manual requires a finite metadata.currentValue.
	manualMissing := mustParseRuleInput(t, map[string]any{
		"name":           "Manual metric",
		"metricProvider": "system_metric",
		"metricSlug":     "custom.manual",
		"operator":       "gte",
	})
	if _, err := upsertRule(ctx, db, producer, orgID, "user-it-1", manualMissing, "trace-upsert-7"); err == nil ||
		err.Error() != "custom.manual metric requires metadata.currentValue" {
		t.Fatalf("custom.manual without currentValue error = %v", err)
	}
	manualOK := mustParseRuleInput(t, map[string]any{
		"name":           "Manual metric",
		"metricProvider": "system_metric",
		"metricSlug":     "custom.manual",
		"operator":       "gte",
		"metadata":       map[string]any{"currentValue": float64(12.5)},
	})
	if _, err := upsertRule(ctx, db, producer, orgID, "user-it-1", manualOK, "trace-upsert-8"); err != nil {
		t.Fatalf("custom.manual with currentValue: %v", err)
	}

	// economic_data links the read-only EconomicDataItem when the slug exists.
	if _, err := db.Exec("INSERT INTO `EconomicDataItem` (`id`, `slug`, `displayName`) VALUES (?, ?, ?) "+
		"ON DUPLICATE KEY UPDATE `displayName` = VALUES(`displayName`)", "econ-it-1", "econ.gdp", "GDP"); err != nil {
		t.Fatalf("insert economic item: %v", err)
	}
	econ := mustParseRuleInput(t, map[string]any{
		"name":           "Economic rule",
		"metricProvider": "economic_data",
		"metricSlug":     "econ.gdp",
		"operator":       "gte",
	})
	econModel, err := upsertRule(ctx, db, producer, orgID, "user-it-1", econ, "trace-upsert-9")
	if err != nil {
		t.Fatalf("economic rule: %v", err)
	}
	var dataItemID sql.NullString
	if err := db.QueryRow("SELECT `dataItemId` FROM `AlertRule` WHERE `id` = ?", econModel.ID).Scan(&dataItemID); err != nil {
		t.Fatal(err)
	}
	if !dataItemID.Valid || dataItemID.String != "econ-it-1" {
		t.Fatalf("dataItemId = %+v", dataItemID)
	}
	missingItem := mustParseRuleInput(t, map[string]any{
		"name":           "Economic rule missing item",
		"metricProvider": "economic_data",
		"metricSlug":     "econ.missing",
		"operator":       "gte",
	})
	missingModel, err := upsertRule(ctx, db, producer, orgID, "user-it-1", missingItem, "trace-upsert-10")
	if err != nil {
		t.Fatalf("economic rule without item: %v", err)
	}
	var missingID sql.NullString
	if err := db.QueryRow("SELECT `dataItemId` FROM `AlertRule` WHERE `id` = ?", missingModel.ID).Scan(&missingID); err != nil {
		t.Fatal(err)
	}
	if missingID.Valid {
		t.Fatalf("dataItemId = %+v, want NULL", missingID)
	}
}

func assertRuleSchedule(t *testing.T, client *redis.Client, ruleID string, everyMillis int64) {
	t.Helper()
	wantEvery := strconv.FormatInt(everyMillis, 10)
	members := repeatMembers(t, client)
	matches := 0
	repeatKeys := map[string]bool{}
	for _, member := range members {
		fields, err := client.HGetAll(context.Background(), "bull:alerts:repeat:"+member).Result()
		if err != nil {
			t.Fatalf("read repeat hash: %v", err)
		}
		if fields["name"] != "evaluate-rule:"+ruleID {
			continue
		}
		matches++
		repeatKeys[member] = true
		if fields["every"] != wantEvery {
			t.Fatalf("repeat every = %q, want %q", fields["every"], wantEvery)
		}
	}
	if matches != 1 {
		t.Fatalf("repeat schedules for %s = %d, want exactly 1", ruleID, matches)
	}
	// The next iteration is exactly one delayed job named after the rule and
	// pointing back to the repeat hash through rjk.
	delayedMatches := 0
	for _, jobID := range delayedJobIDs(t, client) {
		fields := jobFields(t, client, jobID)
		if fields["name"] != "evaluate-rule:"+ruleID {
			continue
		}
		delayedMatches++
		if !repeatKeys[fields["rjk"]] {
			t.Fatalf("delayed job rjk = %q, not a repeat key of the rule", fields["rjk"])
		}
		var opts struct {
			JobID  string `json:"jobId"`
			Repeat struct {
				Every int64  `json:"every"`
				JobID string `json:"jobId"`
				Count int64  `json:"count"`
			} `json:"repeat"`
			PrevMillis int64 `json:"prevMillis"`
		}
		if err := json.Unmarshal([]byte(fields["opts"]), &opts); err != nil {
			t.Fatalf("decode delayed opts: %v", err)
		}
		if opts.JobID != jobID || opts.Repeat.Every != everyMillis || opts.Repeat.Count != 1 {
			t.Fatalf("delayed opts = %+v", opts)
		}
		if opts.Repeat.JobID != "evaluate-"+ruleID {
			t.Fatalf("delayed repeat jobId = %q", opts.Repeat.JobID)
		}
		if !strings.HasPrefix(jobID, "repeat:") || opts.PrevMillis == 0 {
			t.Fatalf("delayed job = %q prevMillis=%d", jobID, opts.PrevMillis)
		}
	}
	if delayedMatches != 1 {
		t.Fatalf("delayed iterations for %s = %d, want exactly 1", ruleID, delayedMatches)
	}
}

// TestAlertRulesChannelTenantIsolation covers B1: a channel of another
// organization aborts the whole save before any row is written.
func TestAlertRulesChannelTenantIsolation(t *testing.T) {
	db, client := prepareAlertRulesIntegration(t)
	producer := alertqueue.New(client)
	ctx := context.Background()

	const orgID = "org-it-alert-tenant-a"
	const otherOrgID = "org-it-alert-tenant-b"
	purgeAlertRulesOrg(t, db, orgID, otherOrgID)
	purgeAlertQueue(t, client)
	insertAlertChannel(t, db, "chan-it-own", orgID)
	insertAlertChannel(t, db, "chan-it-foreign", otherOrgID)

	input := mustParseRuleInput(t, map[string]any{
		"name":       "Cross tenant rule",
		"metricSlug": "pipeline.success_rate",
		"operator":   "gte",
		"channelIds": []any{"chan-it-own", "chan-it-foreign"},
	})
	if _, err := upsertRule(ctx, db, producer, orgID, "user-it-1", input, "trace-b1"); err == nil ||
		err.Error() != "Alert channel not found for this org" {
		t.Fatalf("cross-org channel error = %v", err)
	}
	if got := countRows(t, db, "SELECT COUNT(*) FROM `AlertRule` WHERE `orgId` = ?", orgID); got != 0 {
		t.Fatalf("rules written after rejected channel = %d", got)
	}
	if got := countRows(t, db, "SELECT COUNT(*) FROM `AlertRuleChannel` WHERE `channelId` IN (?, ?)",
		"chan-it-own", "chan-it-foreign"); got != 0 {
		t.Fatalf("links written after rejected channel = %d", got)
	}
	if got := len(waitJobIDs(t, client)) + len(delayedJobIDs(t, client)); got != 0 {
		t.Fatalf("queue writes after rejected channel = %d", got)
	}

	// An own-only channel still saves.
	ownOnly := mustParseRuleInput(t, map[string]any{
		"name":       "Own channel rule",
		"metricSlug": "pipeline.success_rate",
		"operator":   "gte",
		"channelIds": []any{"chan-it-own"},
	})
	if _, err := upsertRule(ctx, db, producer, orgID, "user-it-1", ownOnly, "trace-b1-ok"); err != nil {
		t.Fatalf("own channel: %v", err)
	}
}

// TestAlertRulesUpsertTenantAndValidation covers the ordinary-error contract:
// another organization's rule id is 500, a blank metricSlug is 500, and an id
// that does not exist is 500.
func TestAlertRulesUpsertTenantAndValidation(t *testing.T) {
	db, client := prepareAlertRulesIntegration(t)
	producer := alertqueue.New(client)
	ctx := context.Background()

	const orgID = "org-it-alert-upsert-a"
	const otherOrgID = "org-it-alert-upsert-b"
	purgeAlertRulesOrg(t, db, orgID, otherOrgID)
	purgeAlertQueue(t, client)
	insertAlertRule(t, db, "rule-it-foreign", otherOrgID, "Foreign rule", "active", 300)

	foreign := mustParseRuleInput(t, map[string]any{
		"id":         "rule-it-foreign",
		"name":       "Hijack",
		"metricSlug": "pipeline.success_rate",
		"operator":   "gte",
	})
	if _, err := upsertRule(ctx, db, producer, orgID, "user-it-1", foreign, "trace-tenant"); err == nil ||
		err.Error() != "Alert rule not found for this org" {
		t.Fatalf("foreign rule error = %v", err)
	}
	missing := mustParseRuleInput(t, map[string]any{
		"id":         "rule-it-does-not-exist",
		"name":       "Missing",
		"metricSlug": "pipeline.success_rate",
		"operator":   "gte",
	})
	if _, err := upsertRule(ctx, db, producer, orgID, "user-it-1", missing, "trace-missing"); err == nil ||
		err.Error() != "Alert rule not found for this org" {
		t.Fatalf("missing rule error = %v", err)
	}

	blankSlug := mustParseRuleInput(t, map[string]any{
		"name":       "Blank slug",
		"metricSlug": "   ",
		"operator":   "gte",
	})
	if _, err := upsertRule(ctx, db, producer, orgID, "user-it-1", blankSlug, "trace-slug"); err == nil ||
		err.Error() != "metricSlug is required" {
		t.Fatalf("blank metricSlug error = %v", err)
	}
	// Nothing was written and nothing was enqueued.
	if got := countRows(t, db, "SELECT COUNT(*) FROM `AlertRule` WHERE `orgId` = ?", orgID); got != 0 {
		t.Fatalf("rules written after rejected upserts = %d", got)
	}
	if got := len(waitJobIDs(t, client)) + len(delayedJobIDs(t, client)); got != 0 {
		t.Fatalf("queue writes after rejected upserts = %d", got)
	}
}

// TestAlertRulesDelete covers T3: cascade removal, schedule cleanup, and the
// cross-organization false without side effects.
func TestAlertRulesDelete(t *testing.T) {
	db, client := prepareAlertRulesIntegration(t)
	producer := alertqueue.New(client)
	ctx := context.Background()

	const orgID = "org-it-alert-delete"
	const otherOrgID = "org-it-alert-delete-other"
	purgeAlertRulesOrg(t, db, orgID, otherOrgID)
	purgeAlertQueue(t, client)
	insertAlertChannel(t, db, "chan-it-delete", orgID)
	insertAlertRule(t, db, "rule-it-delete", orgID, "Deletable", "active", 300)
	if _, err := db.Exec("INSERT INTO `AlertRuleChannel` (`id`, `ruleId`, `channelId`, `createdAt`) VALUES (?, ?, ?, ?)",
		"link-it-delete", "rule-it-delete", "chan-it-delete", time.Now().UTC().Truncate(time.Millisecond)); err != nil {
		t.Fatalf("insert link: %v", err)
	}
	insertAlertEvent(t, db, "event-it-delete", "rule-it-delete")
	insertAlertDelivery(t, db, "delivery-it-delete", "event-it-delete")
	if err := producer.EnsureRuleSchedule(ctx, "rule-it-delete", orgID, 300, true); err != nil {
		t.Fatalf("seed schedule: %v", err)
	}
	if err := producer.EnqueueRuleCheck(ctx, "rule-it-delete", orgID, "trace-delete"); err != nil {
		t.Fatalf("seed evaluation: %v", err)
	}

	deleted, err := deleteRule(ctx, db, producer, otherOrgID, "rule-it-delete")
	if err != nil {
		t.Fatalf("cross-org delete: %v", err)
	}
	if deleted {
		t.Fatal("cross-org delete returned true")
	}
	if got := countRows(t, db, "SELECT COUNT(*) FROM `AlertRule` WHERE `id` = ?", "rule-it-delete"); got != 1 {
		t.Fatalf("cross-org delete removed the rule")
	}
	assertRuleSchedule(t, client, "rule-it-delete", 300000)

	deleted, err = deleteRule(ctx, db, producer, orgID, "rule-it-delete")
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if !deleted {
		t.Fatal("delete returned false")
	}
	cascade := []struct {
		table  string
		column string
		value  string
	}{
		{"AlertRule", "`id`", "rule-it-delete"},
		{"AlertRuleChannel", "`ruleId`", "rule-it-delete"},
		{"AlertEvent", "`ruleId`", "rule-it-delete"},
		{"AlertDelivery", "`eventId`", "event-it-delete"},
	}
	for _, entry := range cascade {
		if got := countRows(t, db, "SELECT COUNT(*) FROM `"+entry.table+"` WHERE "+entry.column+" = ?", entry.value); got != 0 {
			t.Fatalf("%s rows after delete = %d", entry.table, got)
		}
	}
	if got := len(repeatMembers(t, client)); got != 0 {
		t.Fatalf("repeat schedules after delete = %d", got)
	}
	if got := len(delayedJobIDs(t, client)); got != 0 {
		t.Fatalf("delayed jobs after delete = %d", got)
	}
	if fields := jobFields(t, client, "evaluate-rule:rule-it-delete"); len(fields) != 0 {
		t.Fatalf("rule job hash still present: %v", fields)
	}
}

// TestAlertRulesTrigger covers T4: an own rule enqueues an evaluation, a
// foreign rule returns false and enqueues nothing.
func TestAlertRulesTrigger(t *testing.T) {
	db, client := prepareAlertRulesIntegration(t)
	producer := alertqueue.New(client)
	ctx := context.Background()

	const orgID = "org-it-alert-trigger"
	const otherOrgID = "org-it-alert-trigger-other"
	purgeAlertRulesOrg(t, db, orgID, otherOrgID)
	purgeAlertQueue(t, client)
	insertAlertRule(t, db, "rule-it-trigger", orgID, "Triggerable", "paused", 300)

	triggered, err := triggerRuleCheck(ctx, db, producer, otherOrgID, "rule-it-trigger", "trace-trigger-other")
	if err != nil {
		t.Fatalf("cross-org trigger: %v", err)
	}
	if triggered {
		t.Fatal("cross-org trigger returned true")
	}
	if got := len(waitJobIDs(t, client)); got != 0 {
		t.Fatalf("cross-org trigger enqueued %d jobs", got)
	}

	triggered, err = triggerRuleCheck(ctx, db, producer, orgID, "rule-it-trigger", "trace-trigger")
	if err != nil {
		t.Fatalf("trigger: %v", err)
	}
	if !triggered {
		t.Fatal("trigger returned false")
	}
	wait := waitJobIDs(t, client)
	if len(wait) != 1 {
		t.Fatalf("wait jobs = %v, want 1", wait)
	}
	if !strings.HasPrefix(wait[0], "evaluate:rule-it-trigger:") {
		t.Fatalf("job id = %q", wait[0])
	}
	fields := jobFields(t, client, wait[0])
	if fields["name"] != "evaluate-rule:rule-it-trigger" {
		t.Fatalf("job name = %q", fields["name"])
	}
	if !strings.Contains(fields["data"], `"traceId":"trace-trigger"`) {
		t.Fatalf("job data = %s", fields["data"])
	}
	// A paused rule is still enqueued; evaluateRule decides to skip it.
	if triggered, err := triggerRuleCheck(ctx, db, producer, orgID, "rule-it-missing", "trace-trigger-missing"); err != nil || triggered {
		t.Fatalf("missing rule trigger = %v/%v", triggered, err)
	}
}

func mustParseRuleInput(t *testing.T, input map[string]any) upsertAlertRuleInput {
	t.Helper()
	parsed, err := parseUpsertAlertRuleInput(map[string]any{"input": input})
	if err != nil {
		t.Fatalf("parse rule input: %v", err)
	}
	return parsed
}
