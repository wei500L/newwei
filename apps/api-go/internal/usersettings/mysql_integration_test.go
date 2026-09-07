//go:build integration

// user-settings 只读 repository 的远端 MySQL 集成测试（build tag
// integration 与普通 go test 分离：`go test ./...` 不需要数据库；
// `go test -tags=integration ./...` 在 GitHub Actions 的 MySQL service
// 上运行）。
//
// 验证真实数据访问的边界（不追求分支全覆盖；Go-批2A onboarding 起步，
// 批2B 扩展 rss-reader / spacetime-timeline——同一个测试函数）：
//   - 最小 UserSetting 表结构（与 Prisma migration 20260117123000 一致）；
//   - 无记录查询（onboarding）；
//   - 插入 onboarding JSON 后查询（orgId/userId/key 三条件）；
//   - 租户隔离：另一个用户/组织读不到该记录；
//   - 批2B：rss-reader / spacetime-timeline 两个固定 key 的真实读取与
//     normalization 抽查；三 key 互不串读；新端点同样受租户隔离；
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
// key 是 MySQL 保留字，需反引号转义——因此用普通字符串（Go 原始字符串
// 无法内嵌反引号）。
const createIntegrationTable = "CREATE TABLE IF NOT EXISTS UserSetting (" +
	"id VARCHAR(191) NOT NULL," +
	"orgId VARCHAR(191) NOT NULL," +
	"userId VARCHAR(191) NOT NULL," +
	"`key` VARCHAR(191) NOT NULL," +
	"value JSON NOT NULL," +
	"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
	"updatedAt DATETIME(3) NOT NULL," +
	"UNIQUE INDEX UserSetting_orgId_userId_key_key (orgId, userId, `key`)," +
	"PRIMARY KEY (id)" +
	") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

func TestUserSettingsMySQLIntegration(t *testing.T) {
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
	const insert = "INSERT INTO UserSetting (id, orgId, userId, `key`, value, updatedAt) VALUES (?, ?, ?, ?, ?, ?)"
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

	// 5. 批2B：rss-reader / spacetime-timeline 两个固定 key 的真实读取
	//    （normalization 深度由单元测试覆盖，这里抽查读取、updatedAt 与
	//    响应构建的关键语义）。
	rssJSON := `{"selectedSourceIds":["  src-1 ","src-2","src-1",42],"sourceLanguageFilters":[" zh ","ZH"],"translationEnabled":true,"translationProvider":"llm","targetLanguage":"  en-US ","showOriginalContent":false}`
	if _, err := db.ExecContext(ctx, insert, "us-it-3", orgID, userID, RSSReaderKey, rssJSON, insertedAt); err != nil {
		t.Fatalf("insert rss-reader: %v", err)
	}
	rssRecord, err := repo.FindRSSReader(ctx, orgID, userID)
	if err != nil {
		t.Fatalf("find rss-reader: %v", err)
	}
	if !rssRecord.Found {
		t.Fatal("rss-reader record.Found = false, want true")
	}
	rssResponse := BuildRSSReaderResponse(rssRecord)
	if rssResponse.UpdatedAt.Settings != "2026-09-03T08:30:15.123Z" {
		t.Errorf("rss updatedAt.settings = %q, want 2026-09-03T08:30:15.123Z（毫秒 UTC，toISOString 等价）", rssResponse.UpdatedAt.Settings)
	}
	if rss := rssResponse.Settings; rss == nil ||
		len(rss.SelectedSourceIDs) != 2 ||
		rss.SelectedSourceIDs[0] != "src-1" || rss.SelectedSourceIDs[1] != "src-2" ||
		len(rss.SourceLanguageFilters) != 1 || rss.SourceLanguageFilters[0] != "ZH" ||
		rss.TranslationProvider != "llm" || rss.TargetLanguage != "en-US" {
		t.Errorf("rss normalization mismatch: %+v", rssResponse.Settings)
	}

	spacetimeJSON := `{"authoritativeLock":false,"sourceType":"blog","sortBy":"latest","minHeatScore":-5,"minCredibilityScore":150,"timelineGranularity":"week","speed":0.1}`
	if _, err := db.ExecContext(ctx, insert, "us-it-4", orgID, userID, SpacetimeTimelineKey, spacetimeJSON, insertedAt); err != nil {
		t.Fatalf("insert spacetime-timeline: %v", err)
	}
	spacetimeRecord, err := repo.FindSpacetimeTimeline(ctx, orgID, userID)
	if err != nil {
		t.Fatalf("find spacetime-timeline: %v", err)
	}
	if !spacetimeRecord.Found {
		t.Fatal("spacetime-timeline record.Found = false, want true")
	}
	spacetimeResponse := BuildSpacetimeTimelineResponse(spacetimeRecord)
	if spacetimeResponse.UpdatedAt.Settings != "2026-09-03T08:30:15.123Z" {
		t.Errorf("spacetime updatedAt.settings = %q, want 2026-09-03T08:30:15.123Z（毫秒 UTC，toISOString 等价）", spacetimeResponse.UpdatedAt.Settings)
	}
	if s := spacetimeResponse.Settings; s == nil ||
		s.AuthoritativeLock ||
		s.SourceType != "blog" || s.SortBy != "latest" ||
		s.MinHeatScore != 0 || s.MinCredibilityScore != 100 ||
		s.TimelineGranularity != "week" || s.Speed != 0.25 {
		t.Errorf("spacetime normalization mismatch: %+v", spacetimeResponse.Settings)
	}

	// 6. 三 key 互不串读：同 org+user 已有 onboarding/rss/war-map/spacetime
	//    四条记录，onboarding 查询仍只命中自己的 key（值不被后续插入污染）；
	//    新端点同样受 orgId/userId 隔离（代表性一例）。
	record, err = repo.FindOnboarding(ctx, orgID, userID)
	if err != nil {
		t.Fatalf("find onboarding after batch2b inserts: %v", err)
	}
	if !record.Found || !jsonEqualString(string(record.Value), storedJSON) {
		t.Errorf("onboarding value polluted by other keys: %s", record.Value)
	}
	rssIsolated, err := repo.FindRSSReader(ctx, orgID, otherUserID)
	if err != nil {
		t.Fatalf("find rss-reader isolated: %v", err)
	}
	if rssIsolated.Found {
		t.Error("rss-reader record.Found = true — orgId/userId 隔离失败")
	}

	// 7. Go-批3B：war-map / newsnow 两个新固定 key 的真实读取与
	//    normalization 抽查。
	warMapJSON := `{"layerVisibility":{"conflicts":false,"militaryBases":false},"viewState":{"lat":120,"zoom":99},"activePreset":"mena","aisMode":"density"}`
	if _, err := db.ExecContext(ctx, insert, "us-it-5", orgID, userID, WarMapKey, warMapJSON, insertedAt); err != nil {
		t.Fatalf("insert war-map: %v", err)
	}
	warRecord, err := repo.FindWarMap(ctx, orgID, userID)
	if err != nil {
		t.Fatalf("find war-map: %v", err)
	}
	if !warRecord.Found {
		t.Fatal("war-map record.Found = false, want true")
	}
	warResponse := BuildWarMapResponse(warRecord)
	if warResponse.UpdatedAt.Settings != "2026-09-03T08:30:15.123Z" {
		t.Errorf("war-map updatedAt.settings = %q, want 2026-09-03T08:30:15.123Z", warResponse.UpdatedAt.Settings)
	}
	if s := warResponse.Settings; s == nil {
		t.Fatal("war-map settings = nil, want object")
	} else if s.LayerVisibility.Conflicts || s.LayerVisibility.Bases ||
		!s.LayerVisibility.Hotspots || s.ViewState.Lat != 90 || s.ViewState.Zoom != 18 ||
		s.ActivePreset != "mena" || s.AisMode != "density" {
		t.Errorf("war-map normalization mismatch: %+v", s)
	}

	newsnowJSON := `{"focusSources":[" src-A ","src-A","bad!"],"sortMode":"smart","hideCrossSourceDuplicates":"yes","columnOrders":{"zz":[" s1 ","s1"]},"sourceAffinity":{"src-Z":{"score":250,"focusCount":3.7}}}`
	if _, err := db.ExecContext(ctx, insert, "us-it-6", orgID, userID, NewsnowKey, newsnowJSON, insertedAt); err != nil {
		t.Fatalf("insert newsnow: %v", err)
	}
	newsRecord, err := repo.FindNewsnow(ctx, orgID, userID)
	if err != nil {
		t.Fatalf("find newsnow: %v", err)
	}
	if !newsRecord.Found {
		t.Fatal("newsnow record.Found = false, want true")
	}
	newsResponse := BuildNewsnowResponse(newsRecord)
	if s := newsResponse.Settings; s == nil {
		t.Fatal("newsnow settings = nil, want object")
	} else if len(s.FocusSources) != 1 || s.FocusSources[0] != "src-A" ||
		s.SortMode != "personalized" || !s.HideCrossSourceDuplicates ||
		len(s.ColumnOrders) != 1 || s.ColumnOrders[0].Key != "zz" ||
		len(s.SourceAffinity) != 1 || s.SourceAffinity[0].Affinity.Score != 100 || s.SourceAffinity[0].Affinity.FocusCount != 4 {
		t.Errorf("newsnow normalization mismatch: %+v", s)
	}

	// 8. Go-批3B：situation-monitor 三 key 聚合——一次查询读三个固定
	//    key；部分记录（只有 monitors）时 layout/settings Found=false
	//    但不报错；全部三 key 写入后聚合完整；三段互不串读。
	situationPartialJSON := `[{"id":"sm-1","name":"Watch","keywords":["a,b"],"createdAt":1757000000000}]`
	if _, err := db.ExecContext(ctx, insert, "us-it-7", orgID, userID, SituationMonitorMonitorsKey, situationPartialJSON, insertedAt); err != nil {
		t.Fatalf("insert situation monitors: %v", err)
	}
	partial, err := repo.FindSituationMonitor(ctx, orgID, userID)
	if err != nil {
		t.Fatalf("find situation-monitor partial: %v", err)
	}
	if !partial.Monitors.Found || partial.Layout.Found || partial.Settings.Found {
		t.Errorf("partial aggregation: monitors=%v layout=%v settings=%v, want true/false/false",
			partial.Monitors.Found, partial.Layout.Found, partial.Settings.Found)
	}
	partialResponse := BuildSituationMonitorResponse(partial)
	if partialResponse.Monitors == nil || len(partialResponse.Monitors) != 1 || partialResponse.Monitors[0].ID != "sm-1" {
		t.Errorf("partial monitors = %+v, want 1 条（id 保留）", partialResponse.Monitors)
	}
	if partialResponse.Layout != nil || partialResponse.Settings != nil {
		t.Errorf("partial response layout/settings = %v/%v, want nil", partialResponse.Layout, partialResponse.Settings)
	}
	if partialResponse.UpdatedAt.Monitors == "" || partialResponse.UpdatedAt.Layout != "" || partialResponse.UpdatedAt.Settings != "" {
		t.Errorf("partial updatedAt = %+v, want 只含 monitors", partialResponse.UpdatedAt)
	}

	// 全三 key 聚合 + 租户隔离。
	if _, err := db.ExecContext(ctx, insert, "us-it-8", orgID, userID, SituationMonitorLayoutKey,
		`{"layouts":{"lg":[{"i":"a","x":-1,"y":2.5,"w":0,"h":3}]}}`, insertedAt); err != nil {
		t.Fatalf("insert situation layout: %v", err)
	}
	if _, err := db.ExecContext(ctx, insert, "us-it-9", orgID, userID, SituationMonitorSettingsKey,
		`{"windowHours":6,"scope":"tagged"}`, insertedAt); err != nil {
		t.Fatalf("insert situation settings: %v", err)
	}
	full, err := repo.FindSituationMonitor(ctx, orgID, userID)
	if err != nil {
		t.Fatalf("find situation-monitor full: %v", err)
	}
	if !full.Monitors.Found || !full.Layout.Found || !full.Settings.Found {
		t.Fatalf("full aggregation: %+v, want 三段全部 Found", full)
	}
	fullResponse := BuildSituationMonitorResponse(full)
	if s := fullResponse.Settings; s == nil || s.WindowHours != 6 || s.Scope != "tagged" {
		t.Errorf("full settings = %+v, want windowHours=6 scope=tagged", s)
	}
	if l := fullResponse.Layout; l == nil || len(l.Layouts["lg"]) != 1 || l.Layouts["lg"][0].X != 0 || l.Layouts["lg"][0].Y != 3 || l.Layouts["lg"][0].W != 1 {
		t.Errorf("full layout = %+v, want lg=[x=0 y=3 w=1]", l)
	}
	isolatedSituation, err := repo.FindSituationMonitor(ctx, otherOrgID, userID)
	if err != nil {
		t.Fatalf("find situation-monitor isolated: %v", err)
	}
	if isolatedSituation.Monitors.Found || isolatedSituation.Layout.Found || isolatedSituation.Settings.Found {
		t.Error("situation-monitor 隔离失败——其他 org 不应有任何记录")
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
