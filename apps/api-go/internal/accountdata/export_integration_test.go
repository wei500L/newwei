//go:build integration

// 头像签名与个人数据导出的远端集成测试（build tag integration；普通
// `go test ./...` 不依赖 MySQL/Redis）。CI 在已有的
// api-go-user-settings-integration job 的 MySQL/Redis service 上运行。
//
// 覆盖：真实 MySQL fixture 下的完整导出、跨组织隔离、限流第 4 次 429、
// 审计写入（byteLength / recordCounts / ipAddress）。Mongo 不在该 job 的
// service 列表里，因此 assistantRuns 用 fake source 覆盖（PR 中如实说明）；
// 生产接线使用真实 assistantruns collection。
package accountdata

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
	"github.com/wei500L/newwei/apps/api-go/internal/newsbehavior"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

func integrationDatabaseURL(t *testing.T) string {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set — integration test requires MySQL")
	}
	return url
}

func integrationRedis(t *testing.T) *redis.Client {
	t.Helper()
	addr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if addr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR not set — integration test requires Redis")
	}
	return redis.NewClient(&redis.Options{Addr: addr})
}

var integrationDDL = []string{
	"CREATE TABLE IF NOT EXISTS `Org` (`id` VARCHAR(191) PRIMARY KEY, `name` VARCHAR(191) NOT NULL, `slug` VARCHAR(191) NOT NULL, `description` TEXT NULL, `planTier` VARCHAR(191) NULL, `subscriptionStatus` VARCHAR(191) NULL, `isActive` TINYINT(1) NOT NULL DEFAULT 1, `createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL)",
	"CREATE TABLE IF NOT EXISTS `User` (`id` VARCHAR(191) PRIMARY KEY, `email` VARCHAR(191) NOT NULL, `emailVerified` DATETIME(3) NULL, `pendingEmail` VARCHAR(191) NULL, `firstName` VARCHAR(191) NOT NULL, `lastName` VARCHAR(191) NOT NULL, `avatarUrl` VARCHAR(191) NULL, `isActive` TINYINT(1) NOT NULL DEFAULT 1, `lastLoginAt` DATETIME(3) NULL, `createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL)",
	"CREATE TABLE IF NOT EXISTS `Role` (`id` VARCHAR(191) PRIMARY KEY, `orgId` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL, `description` TEXT NULL, `isSystem` TINYINT(1) NOT NULL DEFAULT 0)",
	"CREATE TABLE IF NOT EXISTS `Permission` (`id` VARCHAR(191) PRIMARY KEY, `name` VARCHAR(191) NOT NULL, `description` TEXT NULL)",
	"CREATE TABLE IF NOT EXISTS `RolePermission` (`roleId` VARCHAR(191) NOT NULL, `permissionId` VARCHAR(191) NOT NULL)",
	"CREATE TABLE IF NOT EXISTS `Membership` (`id` VARCHAR(191) PRIMARY KEY, `userId` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `roleId` VARCHAR(191) NOT NULL, `isActive` TINYINT(1) NOT NULL DEFAULT 1, `createdAt` DATETIME(3) NOT NULL)",
	"CREATE TABLE IF NOT EXISTS `MembershipRole` (`membershipId` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `roleId` VARCHAR(191) NOT NULL, `createdAt` DATETIME(3) NOT NULL)",
	"CREATE TABLE IF NOT EXISTS `UserTotpFactor` (`userId` VARCHAR(191) PRIMARY KEY, `label` VARCHAR(191) NULL, `enrolledAt` DATETIME(3) NOT NULL, `verifiedAt` DATETIME(3) NULL, `disabledAt` DATETIME(3) NULL, `lastUsedAt` DATETIME(3) NULL, `createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL)",
	"CREATE TABLE IF NOT EXISTS `UserRecoveryCode` (`userId` VARCHAR(191) NOT NULL, `usedAt` DATETIME(3) NULL, `createdAt` DATETIME(3) NOT NULL)",
	"CREATE TABLE IF NOT EXISTS `UserSetting` (`orgId` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NOT NULL, `key` VARCHAR(191) NOT NULL, `value` JSON NOT NULL, `createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL)",
	"CREATE TABLE IF NOT EXISTS `UserContentSubscription` (`id` VARCHAR(191) PRIMARY KEY, `orgId` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NOT NULL, `kind` VARCHAR(191) NOT NULL, `normalizedValue` VARCHAR(191) NOT NULL, `displayValue` VARCHAR(191) NOT NULL, `taxonomyPath` VARCHAR(191) NULL, `taxonomyVersion` VARCHAR(191) NULL, `source` VARCHAR(191) NOT NULL, `metadata` JSON NULL, `createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL)",
	"CREATE TABLE IF NOT EXISTS `UserNewsBehaviorAggregate` (`orgId` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NOT NULL, `signalType` VARCHAR(191) NOT NULL, `signalKey` VARCHAR(191) NOT NULL, `score` DOUBLE NOT NULL, `lastInteractedAt` DATETIME(3) NOT NULL, `createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL)",
	"CREATE TABLE IF NOT EXISTS `UserNewsSimilaritySnapshot` (`orgId` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NOT NULL, `dirty` TINYINT(1) NOT NULL DEFAULT 1, `computedAt` DATETIME(3) NULL, `createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL)",
	"CREATE TABLE IF NOT EXISTS `UserDigestDeliverySchedule` (`orgId` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NOT NULL, `enabled` TINYINT(1) NOT NULL DEFAULT 0, `timezone` VARCHAR(191) NOT NULL, `sendHour` INT NOT NULL, `sendMinute` INT NOT NULL, `nextRunAt` DATETIME(3) NULL, `lastSentAt` DATETIME(3) NULL, `lastStatus` VARCHAR(191) NOT NULL, `lastStatusAt` DATETIME(3) NULL, `lastError` TEXT NULL, `createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL)",
	"CREATE TABLE IF NOT EXISTS `SavedAnalysisView` (`id` VARCHAR(191) PRIMARY KEY, `orgId` VARCHAR(191) NOT NULL, `createdById` VARCHAR(191) NOT NULL, `title` VARCHAR(191) NOT NULL, `description` TEXT NULL, `surface` VARCHAR(191) NOT NULL, `routePath` VARCHAR(191) NOT NULL, `queryState` JSON NOT NULL, `visibility` VARCHAR(191) NOT NULL, `createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL)",
	"CREATE TABLE IF NOT EXISTS `AnalysisThread` (`id` VARCHAR(191) PRIMARY KEY, `orgId` VARCHAR(191) NOT NULL, `createdById` VARCHAR(191) NOT NULL, `subjectType` VARCHAR(191) NOT NULL, `subjectId` VARCHAR(191) NOT NULL, `noteMarkdown` TEXT NULL, `createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL)",
	"CREATE TABLE IF NOT EXISTS `AnalysisComment` (`id` VARCHAR(191) PRIMARY KEY, `orgId` VARCHAR(191) NOT NULL, `createdById` VARCHAR(191) NOT NULL, `threadId` VARCHAR(191) NOT NULL, `bodyMarkdown` TEXT NOT NULL, `createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL)",
	"CREATE TABLE IF NOT EXISTS `Notification` (`id` VARCHAR(191) PRIMARY KEY, `orgId` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NULL, `type` VARCHAR(191) NOT NULL, `title` VARCHAR(191) NOT NULL, `body` TEXT NULL, `data` JSON NULL, `readAt` DATETIME(3) NULL, `createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL)",
	"CREATE TABLE IF NOT EXISTS `AuditLog` (`id` VARCHAR(191) PRIMARY KEY, `orgId` VARCHAR(191) NOT NULL, `actorId` VARCHAR(191) NULL, `resource` VARCHAR(191) NOT NULL, `action` VARCHAR(191) NOT NULL, `metadata` JSON NULL, `ipAddress` VARCHAR(191) NULL, `createdAt` DATETIME(3) NOT NULL)",
	"CREATE TABLE IF NOT EXISTS `AuditLogOutbox` (`id` VARCHAR(191) PRIMARY KEY, `orgId` VARCHAR(191) NOT NULL, `payload` JSON NOT NULL, `status` VARCHAR(191) NOT NULL, `attempts` INT NOT NULL DEFAULT 0, `availableAt` DATETIME(3) NOT NULL, `createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL)",
}

type fakeAssistantRuns struct {
	orgID  string
	userID string
	run    AssistantRun
}

func (f fakeAssistantRuns) ForEachAssistantRun(ctx context.Context, orgID, userID string, yield func(AssistantRun) error) error {
	if orgID != f.orgID || userID != f.userID {
		return nil
	}
	return yield(f.run)
}

func TestDataExportIntegration(t *testing.T) {
	db, err := usersettings.OpenMySQLFromURL(integrationDatabaseURL(t))
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	defer db.Close()
	redisClient := integrationRedis(t)
	defer redisClient.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	for _, statement := range integrationDDL {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("ddl: %v", err)
		}
	}

	suffix := time.Now().UTC().Format("150405.000000000")
	orgID := "org-accountdata-" + suffix
	otherOrgID := "org-accountdata-other-" + suffix
	userID := "user-accountdata-" + suffix
	created := time.Date(2026, 10, 20, 0, 0, 0, 123000000, time.UTC)

	cleanup := func() {
		for _, table := range []string{"AuditLog", "AuditLogOutbox", "Notification", "AnalysisComment",
			"AnalysisThread", "SavedAnalysisView", "UserDigestDeliverySchedule", "UserNewsSimilaritySnapshot",
			"UserNewsBehaviorAggregate", "UserContentSubscription", "UserSetting", "MembershipRole",
			"Membership", "Role"} {
			_, _ = db.ExecContext(ctx, "DELETE FROM `"+table+"` WHERE `orgId` IN (?, ?)", orgID, otherOrgID)
		}
		_, _ = db.ExecContext(ctx, "DELETE FROM `UserRecoveryCode` WHERE `userId` = ?", userID)
		_, _ = db.ExecContext(ctx, "DELETE FROM `UserTotpFactor` WHERE `userId` = ?", userID)
		_, _ = db.ExecContext(ctx, "DELETE FROM `User` WHERE `id` = ?", userID)
		_, _ = db.ExecContext(ctx, "DELETE FROM `Org` WHERE `id` IN (?, ?)", orgID, otherOrgID)
		_, _ = db.ExecContext(ctx, "DELETE FROM `RolePermission` WHERE `roleId` = ?", "role-"+suffix)
		_, _ = db.ExecContext(ctx, "DELETE FROM `Permission` WHERE `id` = ?", "perm-"+suffix)
	}
	cleanup()
	defer cleanup()

	exec := func(statement string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(ctx, statement, args...); err != nil {
			t.Fatalf("exec %q: %v", statement, err)
		}
	}
	exec("INSERT INTO `Org` (`id`,`name`,`slug`,`isActive`,`createdAt`,`updatedAt`) VALUES (?,?,?,1,?,?)", orgID, "Acme", "acme-corp", created, created)
	exec("INSERT INTO `Org` (`id`,`name`,`slug`,`isActive`,`createdAt`,`updatedAt`) VALUES (?,?,?,1,?,?)", otherOrgID, "Other", "other-corp", created, created)
	exec("INSERT INTO `User` (`id`,`email`,`firstName`,`lastName`,`isActive`,`createdAt`,`updatedAt`) VALUES (?,?,?,?,1,?,?)", userID, "user@example.com", "Ada", "Lovelace", created, created)
	exec("INSERT INTO `Role` (`id`,`orgId`,`name`,`isSystem`) VALUES (?,?,?,1)", "role-"+suffix, orgID, "owner")
	exec("INSERT INTO `Permission` (`id`,`name`) VALUES (?,?)", "perm-"+suffix, "settings.manage")
	exec("INSERT INTO `RolePermission` (`roleId`,`permissionId`) VALUES (?,?)", "role-"+suffix, "perm-"+suffix)
	exec("INSERT INTO `Membership` (`id`,`userId`,`orgId`,`roleId`,`isActive`,`createdAt`) VALUES (?,?,?,?,1,?)", "membership-"+suffix, userID, orgID, "role-"+suffix, created)
	exec("INSERT INTO `MembershipRole` (`membershipId`,`orgId`,`roleId`,`createdAt`) VALUES (?,?,?,?)", "membership-"+suffix, orgID, "role-"+suffix, created)
	exec("INSERT INTO `UserSetting` (`orgId`,`userId`,`key`,`value`,`createdAt`,`updatedAt`) VALUES (?,?,?,?,?,?)", orgID, userID, "theme", `{"mode":"dark"}`, created, created)
	exec("INSERT INTO `UserSetting` (`orgId`,`userId`,`key`,`value`,`createdAt`,`updatedAt`) VALUES (?,?,?,?,?,?)", otherOrgID, userID, "other", `{"mode":"light"}`, created, created)
	exec("INSERT INTO `UserContentSubscription` (`id`,`orgId`,`userId`,`kind`,`normalizedValue`,`displayValue`,`source`,`metadata`,`createdAt`,`updatedAt`) VALUES (?,?,?,?,?,?,?,?,?,?)", "sub-"+suffix, orgID, userID, "topic", "ai", "AI", "manual", `null`, created, created)
	exec("INSERT INTO `UserNewsBehaviorAggregate` (`orgId`,`userId`,`signalType`,`signalKey`,`score`,`lastInteractedAt`,`createdAt`,`updatedAt`) VALUES (?,?,?,?,?,?,?,?)", orgID, userID, "topic", "ai", 0.5, created, created, created)
	exec("INSERT INTO `UserNewsSimilaritySnapshot` (`orgId`,`userId`,`dirty`,`createdAt`,`updatedAt`) VALUES (?,?,0,?,?)", orgID, userID, created, created)
	exec("INSERT INTO `UserDigestDeliverySchedule` (`orgId`,`userId`,`enabled`,`timezone`,`sendHour`,`sendMinute`,`lastStatus`,`createdAt`,`updatedAt`) VALUES (?,?,1,?,?,?,?,?,?)", orgID, userID, "UTC", 9, 30, "idle", created, created)
	exec("INSERT INTO `SavedAnalysisView` (`id`,`orgId`,`createdById`,`title`,`surface`,`routePath`,`queryState`,`visibility`,`createdAt`,`updatedAt`) VALUES (?,?,?,?,?,?,?,?,?,?)", "view-a-"+suffix, orgID, userID, "Mine", "search", "/search", `{"q":"ai"}`, "private", created, created)
	exec("INSERT INTO `SavedAnalysisView` (`id`,`orgId`,`createdById`,`title`,`surface`,`routePath`,`queryState`,`visibility`,`createdAt`,`updatedAt`) VALUES (?,?,?,?,?,?,?,?,?,?)", "view-b-"+suffix, otherOrgID, userID, "Other org", "search", "/search", `{"q":"x"}`, "private", created, created)
	exec("INSERT INTO `AnalysisThread` (`id`,`orgId`,`createdById`,`subjectType`,`subjectId`,`createdAt`,`updatedAt`) VALUES (?,?,?,?,?,?,?)", "thread-a-"+suffix, orgID, userID, "item", "item-1", created, created)
	exec("INSERT INTO `AnalysisComment` (`id`,`orgId`,`createdById`,`threadId`,`bodyMarkdown`,`createdAt`,`updatedAt`) VALUES (?,?,?,?,?,?,?)", "comment-a-"+suffix, orgID, userID, "thread-a-"+suffix, "hello", created, created)
	exec("INSERT INTO `AnalysisComment` (`id`,`orgId`,`createdById`,`threadId`,`bodyMarkdown`,`createdAt`,`updatedAt`) VALUES (?,?,?,?,?,?,?)", "comment-b-"+suffix, otherOrgID, userID, "thread-b-"+suffix, "other org", created, created)
	exec("INSERT INTO `Notification` (`id`,`orgId`,`userId`,`type`,`title`,`createdAt`,`updatedAt`) VALUES (?,?,?,?,?,?,?)", "notification-a-"+suffix, orgID, userID, "crawl_completed", "mine", created, created)
	exec("INSERT INTO `Notification` (`id`,`orgId`,`userId`,`type`,`title`,`createdAt`,`updatedAt`) VALUES (?,?,?,?,?,?,?)", "notification-b-"+suffix, otherOrgID, userID, "crawl_completed", "other org", created, created)

	assistant := fakeAssistantRuns{orgID: orgID, userID: userID, run: AssistantRun{
		ID: stringPointer("65f0c0ffee00000000000001"), OrgID: &orgID, Type: stringPointer("query"),
		Status: stringPointer("completed"), Summary: nil, Error: nil, Model: nil,
		TriggeredByID: &userID, CreatedAt: formatTimeValue(created), UpdatedAt: formatTimeValue(created),
	}}
	service := NewService(Options{
		DB:            db,
		Redis:         redisClient,
		Behavior:      newsbehavior.NewService(db, redisClient),
		AssistantRuns: assistant,
		Config:        Config{TrustProxy: ""},
		Now:           func() time.Time { return created },
	})
	identity := &accountsecurity.Identity{UserID: userID, OrgID: orgID}

	call := func() *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, "/api/auth/data-export", nil)
		request.RemoteAddr = "203.0.113.9:43123"
		recorder := httptest.NewRecorder()
		service.ServeDataExport(recorder, request, identity)
		return recorder
	}

	first := call()
	if first.Code != http.StatusOK {
		t.Fatalf("first export status = %d, body = %s", first.Code, first.Body.String())
	}
	if got := first.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q", got)
	}
	if got := first.Header().Get("Pragma"); got != "no-cache" {
		t.Errorf("Pragma = %q", got)
	}
	if got := first.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q", got)
	}
	if got := first.Header().Get("Content-Disposition"); !strings.Contains(got, `filename="wei-user-data-acme-corp-2026-10-20.json"`) {
		t.Errorf("Content-Disposition = %q", got)
	}
	body := first.Body.Bytes()
	var document struct {
		Format  string `json:"format"`
		Version int    `json:"version"`
		Subject struct {
			UserID string `json:"userId"`
			OrgID  string `json:"orgId"`
		} `json:"subject"`
		Sections struct {
			UserSettings      []struct{ Key string } `json:"userSettings"`
			Notifications     []struct{ ID string }  `json:"notifications"`
			AssistantRuns     []struct{ ID string }  `json:"assistantRuns"`
			AnalysisWorkspace struct {
				SavedViews []struct{ ID string } `json:"savedViews"`
				Comments   []struct{ ID string } `json:"comments"`
			} `json:"analysisWorkspace"`
		} `json:"sections"`
	}
	if err := json.Unmarshal(body, &document); err != nil {
		t.Fatalf("export body is not JSON: %v", err)
	}
	if document.Format != exportFormat || document.Version != 1 {
		t.Fatalf("format/version = %q/%d", document.Format, document.Version)
	}
	if document.Subject.UserID != userID || document.Subject.OrgID != orgID {
		t.Fatalf("subject = %+v", document.Subject)
	}
	text := string(body)
	if strings.Contains(text, "other org") || strings.Contains(text, "view-b-"+suffix) ||
		strings.Contains(text, "comment-b-"+suffix) || strings.Contains(text, "notification-b-"+suffix) {
		t.Fatal("export leaked another organization's data")
	}
	if len(document.Sections.AssistantRuns) != 1 {
		t.Fatalf("assistantRuns = %d", len(document.Sections.AssistantRuns))
	}

	// The audit row records the real byte length, the eight counters and the
	// socket address (TRUST_PROXY unset).
	var metadataRaw []byte
	var ipAddress string
	if err := db.QueryRowContext(ctx,
		"SELECT `metadata`, `ipAddress` FROM `AuditLog` WHERE `orgId` = ? AND `resource` = 'data_export' ORDER BY `createdAt` DESC LIMIT 1",
		orgID).Scan(&metadataRaw, &ipAddress); err != nil {
		t.Fatalf("read audit: %v", err)
	}
	var metadata dataExportAuditMetadata
	if err := json.Unmarshal(metadataRaw, &metadata); err != nil {
		t.Fatalf("audit metadata: %v", err)
	}
	if metadata.ByteLength != int64(len(body)) {
		t.Errorf("byteLength = %d, want %d", metadata.ByteLength, len(body))
	}
	if metadata.RecordCounts.UserSettings != 1 || metadata.RecordCounts.Notifications != 1 ||
		metadata.RecordCounts.SavedViews != 1 || metadata.RecordCounts.AnalysisComments != 1 ||
		metadata.RecordCounts.AssistantRuns != 1 {
		t.Errorf("recordCounts = %+v", metadata.RecordCounts)
	}
	if ipAddress != "203.0.113.9" {
		t.Errorf("audit ipAddress = %q", ipAddress)
	}

	// The quota is 3/hour: the fourth request is throttled with the exact text.
	for index := 2; index <= 3; index++ {
		if recorder := call(); recorder.Code != http.StatusOK {
			t.Fatalf("export %d status = %d", index, recorder.Code)
		}
	}
	throttled := call()
	if throttled.Code != http.StatusTooManyRequests {
		t.Fatalf("fourth export status = %d, want 429", throttled.Code)
	}
	if !strings.Contains(throttled.Body.String(), dataExportRateLimitMessage) {
		t.Fatalf("429 body = %s", throttled.Body.String())
	}

	// AuditLogOutbox fallback: with the AuditLog table unavailable the completed
	// download must still be enqueued for replay instead of failing the response.
	outboxOrgID := "org-accountdata-outbox-" + suffix
	outboxUserID := "user-accountdata-outbox-" + suffix
	exec("DROP TABLE IF EXISTS `AuditLog`")
	request := httptest.NewRequest(http.MethodGet, "/api/auth/data-export", nil)
	request.RemoteAddr = "198.51.100.7:40000"
	recorder := httptest.NewRecorder()
	service.ServeDataExport(recorder, request, &accountsecurity.Identity{UserID: outboxUserID, OrgID: outboxOrgID})
	if recorder.Code != http.StatusOK {
		t.Fatalf("outbox export status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	exec(integrationDDL[len(integrationDDL)-2])
	var outboxPayload []byte
	if err := db.QueryRowContext(ctx,
		"SELECT `payload` FROM `AuditLogOutbox` WHERE `orgId` = ? LIMIT 1", outboxOrgID).Scan(&outboxPayload); err != nil {
		t.Fatalf("read audit outbox: %v", err)
	}
	var outbox auditOutboxPayload
	if err := json.Unmarshal(outboxPayload, &outbox); err != nil {
		t.Fatalf("outbox payload: %v", err)
	}
	if outbox.Resource != "data_export" || outbox.Action != "download" || outbox.OrgID != outboxOrgID {
		t.Fatalf("outbox payload = %+v", outbox)
	}
	if len(outbox.Metadata) == 0 {
		t.Fatal("outbox payload lost the audit metadata")
	}
}
