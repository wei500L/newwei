//go:build integration

// Integration test for the startup alert-rule schedule reconciliation against a
// real MySQL 8.4 and Redis 7.2 (the services the CI
// `api-go-user-settings-integration` job provides).
//
// Coverage: the default-rule pass plus one EnsureRuleSchedule per active rule,
// the 60s interval floor, the paused rule being ignored, the idempotency of a
// second cycle, and the exact BullMQ 5.63.2 repeat layout
// (`bull:alerts:repeat` zset member plus its hash) that the NestJS
// AlertsService.ensureAllSchedules writes.
//
// Environment (CI injects them; missing values skip the test):
//
//	DATABASE_URL=mysql://root:secret@127.0.0.1:3306/<db>
//	API_GO_TEST_REDIS_ADDR=127.0.0.1:6379
package alertworker

import (
	"context"
	"database/sql"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/alertworker/queue"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

const (
	arOrgID       = "org-it-reconcile"
	arRuleActiveA = "ar-rule-active-a"
	arRuleActiveB = "ar-rule-active-b"
	arRulePaused  = "ar-rule-paused-c"
	// arStatusPaused is AlertStatus.paused (packages/db/prisma/schema.prisma:1749);
	// the worker never queries this state, so the shared constants do not name it.
	arStatusPaused = "paused"
	// arRuleIntervalA is below the 60s floor of ensureRuleSchedule;
	// arRuleIntervalB is kept as is.
	arRuleIntervalA = 30
	arRuleIntervalB = 300
)

// arAlertRuleDDL is the minimal AlertRule table: every column
// ensureDefaultRulesForAllOrgs inserts plus the columns the reconciliation reads.
// It is the DDL of createAlertWorkerSchema (integration_test.go), so both tests
// agree on the schema shape without depending on Prisma migrate.
var arAlertRuleDDL = "CREATE TABLE `AlertRule` (" +
	"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL," +
	"`description` VARCHAR(191) NULL, `severity` VARCHAR(191) NOT NULL DEFAULT 'medium'," +
	"`status` VARCHAR(191) NOT NULL DEFAULT 'active', `metricProvider` VARCHAR(191) NOT NULL," +
	"`dataItemId` VARCHAR(191) NULL, `metricSlug` VARCHAR(191) NOT NULL, `operator` VARCHAR(191) NOT NULL," +
	"`thresholdValue` DECIMAL(38,12) NULL, `thresholdLower` DECIMAL(38,12) NULL, `thresholdUpper` DECIMAL(38,12) NULL," +
	"`changeWindowMin` INT NULL, `cooldownSeconds` INT NOT NULL DEFAULT 3600, `checkIntervalSec` INT NOT NULL DEFAULT 300," +
	"`lastTriggeredAt` DATETIME(3) NULL, `metadata` JSON NULL, `createdById` VARCHAR(191) NULL," +
	"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
	"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

// arOrgDDL is the minimal Org table ensureDefaultRulesForAllOrgs reads.
var arOrgDDL = "CREATE TABLE `Org` (" +
	"`id` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL, `slug` VARCHAR(191) NOT NULL," +
	"`isActive` BOOLEAN NOT NULL DEFAULT true," +
	"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL," +
	"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

func openAlertReconcileMySQL(t *testing.T) *sql.DB {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL is not set")
	}
	db, err := usersettings.OpenMySQLFromURL(databaseURL)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func openAlertReconcileRedis(t *testing.T) *redis.Client {
	t.Helper()
	address := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if address == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR is not set")
	}
	client := redis.NewClient(&redis.Options{Addr: address, Protocol: 2})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		t.Fatalf("redis ping: %v", err)
	}
	if err := client.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("redis flush: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

// rebuildAlertReconcileTables recreates the two tables this test owns. The
// other integration fixture recreates the whole schema itself, so dropping only
// these two keeps the two files independent of their run order.
func rebuildAlertReconcileTables(t *testing.T, db *sql.DB) {
	t.Helper()
	ctx := context.Background()
	for _, table := range []string{"AlertRule", "Org"} {
		if _, err := db.ExecContext(ctx, "DROP TABLE IF EXISTS `"+table+"`"); err != nil {
			t.Fatalf("drop %s: %v", table, err)
		}
	}
	for _, statement := range []string{arOrgDDL, arAlertRuleDDL} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("create table: %v", err)
		}
	}
}

// seedAlertReconcileFixtures inserts one organization, two active rules and one
// paused rule. The paused rule must never receive a schedule.
func seedAlertReconcileFixtures(t *testing.T, db *sql.DB) {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := db.ExecContext(ctx,
		"INSERT INTO `Org` (`id`,`name`,`slug`,`isActive`,`updatedAt`) VALUES (?,?,?,?,?)",
		arOrgID, "IT reconcile", "it-reconcile", true, now); err != nil {
		t.Fatalf("insert org: %v", err)
	}
	insertRule := func(id, status string, interval int) {
		t.Helper()
		if _, err := db.ExecContext(ctx,
			"INSERT INTO `AlertRule` (`id`,`orgId`,`name`,`description`,`severity`,`status`,`metricProvider`,"+
				"`metricSlug`,`operator`,`thresholdValue`,`changeWindowMin`,`cooldownSeconds`,`checkIntervalSec`,"+
				"`metadata`,`createdAt`,`updatedAt`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
			id, arOrgID, "IT "+id, "reconcile fixture", "high", status, "system_event", "audit.it",
			"gte", "1", 60, 3600, interval, []byte(`{}`), now, now); err != nil {
			t.Fatalf("insert rule %s: %v", id, err)
		}
	}
	insertRule(arRuleActiveA, StatusActive, arRuleIntervalA)
	insertRule(arRuleActiveB, StatusActive, arRuleIntervalB)
	insertRule(arRulePaused, arStatusPaused, arRuleIntervalB)
}

// repeatSchedule is one decoded `bull:alerts:repeat` entry.
type repeatSchedule struct {
	name  string
	every string
}

// readRepeatSchedules decodes the repeat layout exactly like
// queue.Producer.removeRepeatablesByName: the zset member is the hashed repeat
// key and the hash under `<repeat>:<member>` holds the job name and the `every`
// interval in milliseconds.
func readRepeatSchedules(t *testing.T, client *redis.Client) []repeatSchedule {
	t.Helper()
	ctx := context.Background()
	keys := queue.NewKeys(queue.Prefix, queue.QueueName)
	members, err := client.ZRange(ctx, keys.Repeat, 0, -1).Result()
	if err != nil {
		t.Fatalf("read repeat zset: %v", err)
	}
	schedules := make([]repeatSchedule, 0, len(members))
	for _, member := range members {
		fields, err := client.HGetAll(ctx, keys.Repeat+":"+member).Result()
		if err != nil {
			t.Fatalf("read repeat hash %s: %v", member, err)
		}
		schedules = append(schedules, repeatSchedule{name: fields["name"], every: fields["every"]})
	}
	return schedules
}

// countRepeatByName counts the repeat members whose stored job name matches
// evaluate-rule:<ruleId>, the NestJS buildRuleJobName of one rule.
func countRepeatByName(schedules []repeatSchedule, ruleID string) int {
	name := queue.RuleJobName(ruleID)
	count := 0
	for _, schedule := range schedules {
		if schedule.name == name {
			count++
		}
	}
	return count
}

// everyByName returns the `every` value stored for one rule schedule.
func everyByName(schedules []repeatSchedule, ruleID string) string {
	name := queue.RuleJobName(ruleID)
	for _, schedule := range schedules {
		if schedule.name == name {
			return schedule.every
		}
	}
	return ""
}

// TestAlertReconcileIntegration proves ReconcileRuleSchedules creates exactly
// one repeat schedule per active rule, applies the 60s floor, leaves the paused
// rule alone and is idempotent.
func TestAlertReconcileIntegration(t *testing.T) {
	db := openAlertReconcileMySQL(t)
	client := openAlertReconcileRedis(t)
	rebuildAlertReconcileTables(t, db)
	seedAlertReconcileFixtures(t, db)

	service, err := New(Options{
		DB:    db,
		Redis: client,
		Config: Config{
			// The reconciliation is exercised directly; the queue consumer is not
			// started, so the scan interval and the namespace keep their defaults.
			BullMQNamespace: "it-alert-reconcile",
		},
	})
	if err != nil {
		t.Fatalf("build alert worker: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	if err := service.ReconcileRuleSchedules(ctx); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	schedules := readRepeatSchedules(t, client)
	if got := countRepeatByName(schedules, arRuleActiveA); got != 1 {
		t.Fatalf("repeat schedules of %s = %d, want 1", arRuleActiveA, got)
	}
	if got := countRepeatByName(schedules, arRuleActiveB); got != 1 {
		t.Fatalf("repeat schedules of %s = %d, want 1", arRuleActiveB, got)
	}
	if got := countRepeatByName(schedules, arRulePaused); got != 0 {
		t.Fatalf("repeat schedules of the paused rule = %d, want 0", got)
	}
	if got := everyByName(schedules, arRuleActiveA); got != strconv.Itoa(60*1000) {
		t.Fatalf("every of %s = %q, want %q (checkIntervalSec floored at 60s)",
			arRuleActiveA, got, strconv.Itoa(60*1000))
	}
	if got := everyByName(schedules, arRuleActiveB); got != strconv.Itoa(arRuleIntervalB*1000) {
		t.Fatalf("every of %s = %q, want %q", arRuleActiveB, got, strconv.Itoa(arRuleIntervalB*1000))
	}

	// The default-rule pass also runs under the same lease and creates the
	// system default rules, which is why the zset holds more than the two
	// fixture schedules and why the assertions above are keyed by rule id.
	createdDefaults := 0
	for _, schedule := range schedules {
		if strings.HasPrefix(schedule.name, queue.JobNameRulePrefix+"default-") {
			createdDefaults++
		}
	}
	if createdDefaults == 0 {
		t.Fatal("the default-rule pass must create the system default rule schedules")
	}

	// A second cycle must not duplicate a repeat schedule: EnsureRuleSchedule
	// replaces the previous one instead of adding another member.
	before := len(schedules)
	if err := service.ReconcileRuleSchedules(ctx); err != nil {
		t.Fatalf("second reconcile: %v", err)
	}
	after := readRepeatSchedules(t, client)
	if len(after) != before {
		t.Fatalf("repeat schedules after the second cycle = %d, want %d (idempotent)", len(after), before)
	}
	if got := countRepeatByName(after, arRuleActiveA); got != 1 {
		t.Fatalf("repeat schedules of %s after the second cycle = %d, want 1", arRuleActiveA, got)
	}

	// The paused rule still has no schedule after the second cycle.
	if got := countRepeatByName(after, arRulePaused); got != 0 {
		t.Fatalf("repeat schedules of the paused rule after the second cycle = %d, want 0", got)
	}

	// The default rules were really inserted into AlertRule, not only scheduled.
	var defaultRules int
	if err := db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM `AlertRule` WHERE `orgId` = ? AND `metricProvider` <> ?",
		arOrgID, "system_event").Scan(&defaultRules); err != nil {
		t.Fatalf("count default rules: %v", err)
	}
	if defaultRules == 0 {
		t.Fatalf("default rule rows = %d, want the created system defaults", defaultRules)
	}
}
