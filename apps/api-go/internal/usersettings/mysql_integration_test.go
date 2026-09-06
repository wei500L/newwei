//go:build integration

// Go-批2A 远端 MySQL 集成测试（build tag integration 与普通 go test 分离：
// `go test ./...` 不需要数据库；`go test -tags=integration ./...` 在
// GitHub Actions 的 MySQL service 上运行）。
//
// 验证真实数据访问的边界（不追求分支全覆盖）：
//   - 最小 UserSetting 表结构（与 Prisma migration 20260117123000 一致）；
//   - 无记录查询；
//   - 插入一条 onboarding JSON 后查询（orgId/userId/key 三条件）；
//   - 租户隔离：另一个用户/组织读不到该记录；
//   - updatedAt 毫秒 UTC 序列化（DATETIME(3)）。
//
// 环境变量（CI 注入，缺省即跳过——本地无数据库不失败）：
//
//	DATABASE_URL=mysql://root:secret@127.0.0.1:3306/<db>
package usersettings

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func integrationDatabaseURL(t *testing.T) string {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set — integration test requires a MySQL service")
	}
	return url
}

// createIntegrationTable 建 Prisma migration 同构的最小表（列名/类型/
// 唯一键一致；省略 FK 约束——测试库没有 Org/User 行）。
const createIntegrationTable = `
CREATE TABLE IF NOT EXISTS UserSetting (
    id VARCHAR(191) NOT NULL,
    orgId VARCHAR(191) NOT NULL,
    userId VARCHAR(191) NOT NULL,
    \`key\` VARCHAR(191) NOT NULL,
    value JSON NOT NULL,
    createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updatedAt DATETIME(3) NOT NULL,
    UNIQUE INDEX UserSetting_orgId_userId_key_key (orgId, userId, \`key\`),
    PRIMARY KEY (id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`

func TestOnboardingMySQLIntegration(t *testing.T) {
	databaseURL := integrationDatabaseURL(t)
	db, err := OpenMySQLFromURL(databaseURL)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if _, err := db.ExecContext(ctx, createIntegrationTable); err != nil {
		t.Fatalf("create table: %v", err)
	}

	const orgID = "org-it-a"
	const otherOrgID = "org-it-b"
	const userID = "user-it-1"
	const otherUserID = "user-it-2"

	// 清理旧 fixture（幂等重跑）。
	const cleanup = `DELETE FROM UserSetting WHERE orgId IN (?, ?)`
	if _, err := db.ExecContext(ctx, cleanup, orgID, otherOrgID); err != nil {
		t.Fatalf("cleanup: %v", err)
	}

	repo := NewMySQLRepository(db)

	// 1. 无记录：Found=false（业务结果，非错误）。
	record, err := repo.FindOnboarding(ctx, orgID, userID)
	if err != nil {
		t.Fatalf("find empty: %v", err)
	}
	if record.Found {
		t.Fatal("record.Found = true, want false（无记录）")
	}
	response := BuildOnboardingResponse(record)
	body, _ := json.Marshal(response)
	if !strings.Contains(string(body), `"settings":null`) {
		t.Errorf("no-record body = %s, want settings null", body)
	}

	// 2. 插入一条 onboarding JSON 后查询。
	insertedAt := time.Date(2026, 9, 3, 8, 30, 15, 123000000, time.UTC)
	const insert = `INSERT INTO UserSetting (id, orgId, userId, \`key\`, value, updatedAt)
	                VALUES (?, ?, ?, ?, ?, ?)`
	storedJSON := `{"completed":false,"dismissed":true,"checklist":{"today":true,"events":false,"map":false,"finance":false},"completedTours":{"today":true}}`
	if _, err := db.ExecContext(ctx, insert, "us-it-1", orgID, userID, OnboardingKey, storedJSON, insertedAt); err != nil {
		t.Fatalf("insert: %v", err)
	}

	record, err = repo.FindOnboarding(ctx, orgID, userID)
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if !record.Found {
		t.Fatal("record.Found = false, want true")
	}
	response = BuildOnboardingResponse(record)
	if response.UpdatedAt.Settings != "2026-09-03T08:30:15.123Z" {
		t.Errorf("updatedAt.settings = %q, want 2026-09-03T08:30:15.123Z（毫秒 UTC，toISOString 等价）", response.UpdatedAt.Settings)
	}
	settings := response.Settings
	if settings == nil {
		t.Fatal("settings = nil, want object")
	}
	if !settings.Dismissed || !settings.Checklist.Today || settings.Completed {
		t.Errorf("normalization mismatch: %+v", settings)
	}
	if len(settings.CompletedTours) != 1 || !settings.CompletedTours["today"] {
		t.Errorf("completedTours = %v, want {today:true}", settings.CompletedTours)
	}

	// 3. 租户隔离：另一个用户/组织读不到该记录。
	for name, args := range map[string][2]string{
		"other-user-same-org": {orgID, otherUserID},
		"other-org-same-user": {otherOrgID, userID},
	} {
		isolated, err := repo.FindOnboarding(ctx, args[0], args[1])
		if err != nil {
			t.Fatalf("%s: find: %v", name, err)
		}
		if isolated.Found {
			t.Errorf("%s: record.Found = true — orgId/userId 隔离失败", name)
		}
	}

	// 4. 其他 key 不串读（同 org+user 不同 key 的记录不被 onboarding 查询命中）。
	if _, err := db.ExecContext(ctx, insert, "us-it-2", orgID, userID, "ui:war-map:settings:v1", `{}`, insertedAt); err != nil {
		t.Fatalf("insert other key: %v", err)
	}
	record, err = repo.FindOnboarding(ctx, orgID, userID)
	if err != nil {
		t.Fatalf("find after other-key insert: %v", err)
	}
	if !record.Found {
		t.Fatal("record.Found = false — onboarding 记录不应被其他 key 串读影响")
	}
	if string(record.Value) != storedJSON && !jsonEqualString(string(record.Value), storedJSON) {
		t.Errorf("value mismatch: got %s", record.Value)
	}
}

func jsonEqualString(a, b string) bool {
	var av, bv any
	if err := json.Unmarshal([]byte(a), &av); err != nil {
		return false
	}
	if err := json.Unmarshal([]byte(b), &bv); err != nil {
		return false
	}
	aj, err := json.Marshal(av)
	if err != nil {
		return false
	}
	bj, err := json.Marshal(bv)
	if err != nil {
		return false
	}
	return string(aj) == string(bj)
}
