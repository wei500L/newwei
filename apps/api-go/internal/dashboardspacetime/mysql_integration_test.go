//go:build integration

// dashboardspacetime 的 MySQL 集成测试：热力图行查询与传播图行查询的 EXPLAIN，
// 以及 fixture 上的租户隔离与过滤语义。
//
// 只在普通 CI 的 api-go-user-settings-integration job 里跑；本地无数据库跳过。
// 断言：两条关键 SQL 都走 (orgId, status, hasLocation, eventAt[, articleId])
// 与 (orgId, eventId, createdAt) 索引，不是全表扫描；行结果尊重 orgId、
// status、hasLocation、事件时间窗口与 eventId 过滤。
package dashboardspacetime

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-sql-driver/mysql"
)

const createIntegrationTables = `
CREATE TABLE IF NOT EXISTS Article (
  id VARCHAR(191) NOT NULL,
  orgId VARCHAR(191) NOT NULL,
  url VARCHAR(512) NOT NULL,
  sourceLabel VARCHAR(191) NULL,
  crawlAt DATETIME(3) NOT NULL,
  PRIMARY KEY (id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`

const createProcessedArticleTable = `
CREATE TABLE IF NOT EXISTS ProcessedArticle (
  id VARCHAR(191) NOT NULL,
  orgId VARCHAR(191) NOT NULL,
  articleId VARCHAR(191) NOT NULL,
  status VARCHAR(191) NOT NULL,
  title VARCHAR(191) NULL,
  cleanedMarkdownRef VARCHAR(191) NULL,
  location VARCHAR(191) NULL,
  eventAt DATETIME(3) NULL,
  hasLocation TINYINT NOT NULL DEFAULT 0,
  publishedAt DATETIME(3) NULL,
  processedAt DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX ProcessedArticle_articleId_key (articleId),
  INDEX ProcessedArticle_orgId_status_hasLocation_eventAt_articleId_idx (orgId, status, hasLocation, eventAt, articleId)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`

const createNewsEventItemTable = `
CREATE TABLE IF NOT EXISTS NewsEventItem (
  id VARCHAR(191) NOT NULL,
  orgId VARCHAR(191) NOT NULL,
  eventId VARCHAR(191) NOT NULL,
  processedArticleId VARCHAR(191) NOT NULL,
  processedItemId VARCHAR(191) NULL,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE INDEX NewsEventItem_orgId_processedArticleId_key (orgId, processedArticleId),
  INDEX NewsEventItem_orgId_eventId_createdAt_idx (orgId, eventId, createdAt)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`

func openIntegrationMySQL(t *testing.T) *sql.DB {
	t.Helper()
	raw := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if raw == "" {
		t.Skip("DATABASE_URL not set — integration test requires a MySQL service")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		t.Fatalf("DATABASE_URL is not a usable mysql URL")
	}
	name := strings.Trim(parsed.Path, "/")
	if name == "" {
		t.Fatalf("DATABASE_URL has no database name")
	}
	cfg := mysql.NewConfig()
	cfg.Net = "tcp"
	cfg.Addr = parsed.Host
	cfg.DBName = name
	if parsed.User != nil {
		cfg.User = parsed.User.Username()
		cfg.Passwd, _ = parsed.User.Password()
	}
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	db, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	return db
}

// inlineQueryArguments replaces every ? with the matching literal so the
// statement can be EXPLAINed without relying on prepared EXPLAIN support.
func inlineQueryArguments(query string, args []any) string {
	var builder strings.Builder
	next := 0
	for _, char := range query {
		if char != '?' || next >= len(args) {
			builder.WriteRune(char)
			continue
		}
		switch value := args[next].(type) {
		case string:
			builder.WriteString("'" + strings.ReplaceAll(value, "'", "''") + "'")
		case time.Time:
			builder.WriteString("'" + value.UTC().Format("2006-01-02 15:04:05.000") + "'")
		case int:
			builder.WriteString(strconv.Itoa(value))
		default:
			panic("unsupported bound value in integration EXPLAIN")
		}
		next++
	}
	return builder.String()
}

// assertIndexBackedPlan checks every access to the given table uses an index and
// that the expected index was considered. EXPLAIN reports the alias when the
// query aliases the table, so callers pass the alias used in their statement.
func assertIndexBackedPlan(t *testing.T, db *sql.DB, ctx context.Context, query string, args []any, tableLabel, wantPossibleKey string) {
	t.Helper()
	plan, err := db.QueryContext(ctx, "EXPLAIN "+inlineQueryArguments(query, args))
	if err != nil {
		t.Fatalf("explain: %v", err)
	}
	defer plan.Close()
	scanned := 0
	for plan.Next() {
		var (
			id, selectType, planTable, partitions, planType, possibleKeys, key, keyLen, ref, extra sql.NullString
			planRows                                                                               sql.NullInt64
			filtered                                                                               sql.NullFloat64
		)
		if err := plan.Scan(&id, &selectType, &planTable, &partitions, &planType, &possibleKeys, &key, &keyLen, &ref, &planRows, &filtered, &extra); err != nil {
			t.Fatalf("scan explain: %v", err)
		}
		if planTable.String != tableLabel {
			continue
		}
		scanned++
		if planType.String == "ALL" || key.String == "" {
			t.Fatalf("%s is not index-backed: type=%q key=%q extra=%q", tableLabel, planType.String, key.String, extra.String)
		}
		if wantPossibleKey != "" && !strings.Contains(possibleKeys.String, wantPossibleKey) {
			t.Fatalf("%s never considers %s: %q", tableLabel, wantPossibleKey, possibleKeys.String)
		}
	}
	if scanned == 0 {
		t.Fatalf("EXPLAIN returned no %s access", tableLabel)
	}
	if err := plan.Err(); err != nil {
		t.Fatalf("explain rows: %v", err)
	}
}

func TestSpacetimeMySQLIntegration(t *testing.T) {
	db := openIntegrationMySQL(t)
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	for _, statement := range []string{"DROP TABLE IF EXISTS ProcessedArticle", createIntegrationTables, createProcessedArticleTable, createNewsEventItemTable} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("create table: %v", err)
		}
	}
	for _, statement := range []string{
		`DELETE FROM NewsEventItem WHERE orgId IN (?, ?)`,
		`DELETE FROM ProcessedArticle WHERE orgId IN (?, ?)`,
		`DELETE FROM Article WHERE orgId IN (?, ?)`,
	} {
		if _, err := db.ExecContext(ctx, statement, "it-org-a", "it-org-b"); err != nil {
			t.Fatalf("cleanup: %v", err)
		}
	}

	at := func(day int) time.Time { return time.Date(2026, 3, day, 12, 0, 0, 0, time.UTC) }
	insert := func(statement string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(ctx, statement, args...); err != nil {
			t.Fatalf("insert: %v", err)
		}
	}
	insert(`INSERT INTO Article (id, orgId, url, sourceLabel, crawlAt) VALUES (?, ?, ?, ?, ?)`,
		"it-art-a", "it-org-a", "https://a.example/item", "a.example", at(1))
	insert(`INSERT INTO Article (id, orgId, url, sourceLabel, crawlAt) VALUES (?, ?, ?, ?, ?)`,
		"it-art-b", "it-org-b", "https://b.example/item", "b.example", at(1))
	insert(`INSERT INTO ProcessedArticle (id, orgId, articleId, status, title, cleanedMarkdownRef, location, eventAt, hasLocation, publishedAt, processedAt)
VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, 1, ?, ?)`,
		"it-pa-a1", "it-org-a", "it-art-a", "Kyiv strike", "0123456789abcdef01234567", "Kyiv, Ukraine", at(2), at(2), at(2))
	insert(`INSERT INTO ProcessedArticle (id, orgId, articleId, status, title, cleanedMarkdownRef, location, eventAt, hasLocation, publishedAt, processedAt)
VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, 1, ?, ?)`,
		"it-pa-b1", "it-org-b", "it-art-b", "Other tenant", "0123456789abcdef01234568", "Lviv, Ukraine", at(2), at(2), at(2))

	start := at(1)
	end := at(9)
	query, args := heatmapRowsQuery("it-org-a", start, end, "")
	assertIndexBackedPlan(t, db, ctx, query, args, "pa",
		"ProcessedArticle_orgId_status_hasLocation_eventAt_articleId_idx")

	store := &mysqlArticles{db: db}
	rows, err := store.Geo(ctx, "it-org-a", start, end, "")
	if err != nil {
		t.Fatalf("geo: %v", err)
	}
	if len(rows) != 1 || rows[0].ID != "it-pa-a1" {
		t.Fatalf("geo rows leaked across orgs or missed the fixture: %+v", rows)
	}
	if rows[0].Location != "Kyiv, Ukraine" || rows[0].URL == nil || *rows[0].URL != "https://a.example/item" {
		t.Fatalf("geo row = %+v", rows[0])
	}

	// hasLocation=0 rows stay out of the heatmap feed.
	insert(`INSERT INTO Article (id, orgId, url, crawlAt) VALUES (?, ?, ?, ?)`,
		"it-art-a2", "it-org-a", "https://a.example/plain", at(3))
	insert(`INSERT INTO ProcessedArticle (id, orgId, articleId, status, title, location, eventAt, hasLocation, processedAt)
VALUES (?, ?, ?, 'completed', ?, ?, ?, 0, ?)`,
		"it-pa-a2", "it-org-a", "it-art-a2", "No location", "", at(3), at(3))
	rows, err = store.Geo(ctx, "it-org-a", start, end, "")
	if err != nil {
		t.Fatalf("geo after plain row: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("hasLocation=0 rows must be excluded: %+v", rows)
	}

	// The event filter restricts the same feed to one event.
	insert(`INSERT INTO NewsEventItem (id, orgId, eventId, processedArticleId, processedItemId, createdAt)
VALUES (?, ?, ?, ?, ?, ?)`, "it-nei-1", "it-org-a", "it-event-1", "it-pa-a1", "0123456789abcdef01234567", at(2))
	rows, err = store.Geo(ctx, "it-org-a", start, end, "it-event-1")
	if err != nil {
		t.Fatalf("geo by event: %v", err)
	}
	if len(rows) != 1 || rows[0].ID != "it-pa-a1" {
		t.Fatalf("event filter rows = %+v", rows)
	}
	rows, err = store.Geo(ctx, "it-org-a", start, end, "it-event-other")
	if err != nil {
		t.Fatalf("geo by other event: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("event filter matched another event: %+v", rows)
	}

	propQuery, propArgs := propagationQuery("it-org-a", "it-event-1", start, end)
	assertIndexBackedPlan(t, db, ctx, propQuery, propArgs, "nei",
		"NewsEventItem_orgId_eventId_createdAt_idx")
	propagation, err := store.Propagation(ctx, "it-org-a", "it-event-1", start, end)
	if err != nil {
		t.Fatalf("propagation: %v", err)
	}
	if len(propagation) != 1 || propagation[0].ArticleID != "it-pa-a1" || propagation[0].ProcessedItemID != "0123456789abcdef01234567" {
		t.Fatalf("propagation rows = %+v", propagation)
	}
	otherTenant, err := store.Propagation(ctx, "it-org-b", "it-event-1", start, end)
	if err != nil {
		t.Fatalf("propagation for other org: %v", err)
	}
	if len(otherTenant) != 0 {
		t.Fatalf("propagation leaked across orgs: %+v", otherTenant)
	}

	// Window boundaries are inclusive on both ends.
	outside, err := store.Geo(ctx, "it-org-a", at(9), at(10), "")
	if err != nil {
		t.Fatalf("geo outside window: %v", err)
	}
	if len(outside) != 0 {
		t.Fatalf("rows outside the window = %+v", outside)
	}
}
