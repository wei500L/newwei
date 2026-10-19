//go:build integration

// dashboardcharts 的 MySQL 集成测试：首末点批量查询的 EXPLAIN 与结果。
//
// 只在普通 CI 的 api-go-user-settings-integration job 里跑（该 job 提供 MySQL
// service 并注入 DATABASE_URL）；本地没有数据库时跳过，不影响 `go test ./...`。
//
// 断言的是这一批真正关心的两件事：
//   - UNION ALL 的每个分支仍按 (itemId, sourceField, recordedAt) 索引定位，
//     type 不是 ALL，key 不是 NULL（即没有退化成全表扫描）；
//   - 在 fixture 上首点/末点的取值与时间正确，窗口外的点不参与，缺数据的
//     序列不出现在结果里（对齐原来两次单点查询的 nil 语义）。
package dashboardcharts

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

const createEconomicDataPointTable = "CREATE TABLE IF NOT EXISTS EconomicDataPoint (" +
	"id VARCHAR(191) NOT NULL," +
	"itemId VARCHAR(191) NOT NULL," +
	"recordedAt DATETIME(3) NOT NULL," +
	"dataType VARCHAR(191) NOT NULL," +
	"value DECIMAL(38,12) NOT NULL," +
	"unit VARCHAR(191) NULL," +
	"sourceField VARCHAR(191) NOT NULL," +
	"sourceMeta JSON NULL," +
	"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
	"PRIMARY KEY (id)," +
	"UNIQUE INDEX `EconomicDataPoint_itemId_recordedAt_sourceField_key` (itemId, recordedAt, sourceField)," +
	"INDEX `EconomicDataPoint_itemId_recordedAt_idx` (itemId, recordedAt)," +
	"INDEX `EconomicDataPoint_itemId_sourceField_recordedAt_idx` (itemId, sourceField, recordedAt)" +
	") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

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

func TestSectorEndpointsMySQLIntegration(t *testing.T) {
	db := openIntegrationMySQL(t)
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if _, err := db.ExecContext(ctx, createEconomicDataPointTable); err != nil {
		t.Fatalf("create table: %v", err)
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM EconomicDataPoint WHERE itemId IN (?, ?, ?)`, "it-alpha", "it-beta", "it-empty"); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	rows := []struct {
		id, itemID, field, value string
		unit                     sql.NullString
		at                       time.Time
	}{
		{id: "p1", itemID: "it-alpha", field: "close", value: "100.5", at: time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)},
		{id: "p2", itemID: "it-alpha", field: "close", value: "104.25", at: time.Date(2026, 3, 2, 0, 0, 0, 0, time.UTC)},
		{id: "p3", itemID: "it-alpha", field: "close", value: "99.75", unit: sql.NullString{String: "pts", Valid: true}, at: time.Date(2026, 3, 3, 0, 0, 0, 0, time.UTC)},
		// Outside the requested window; must not become the first/last sample.
		{id: "p4", itemID: "it-alpha", field: "close", value: "1", at: time.Date(2026, 2, 20, 0, 0, 0, 0, time.UTC)},
		{id: "p5", itemID: "it-beta", field: "volume", value: "7", at: time.Date(2026, 3, 4, 0, 0, 0, 0, time.UTC)},
	}
	for _, row := range rows {
		if _, err := db.ExecContext(ctx,
			"INSERT INTO EconomicDataPoint (id, itemId, recordedAt, dataType, value, unit, sourceField) VALUES (?, ?, ?, 'number', ?, ?, ?)",
			row.id, row.itemID, row.at, row.value, row.unit, row.field); err != nil {
			t.Fatalf("insert %s: %v", row.id, err)
		}
	}

	start := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 3, 31, 23, 59, 59, 999000000, time.UTC)
	keys := []seriesKey{
		{ItemID: "it-alpha", Field: "close"},
		{ItemID: "it-beta", Field: "volume"},
		{ItemID: "it-empty", Field: "close"},
	}

	query, args := sectorEndpointQuery(keys, start, end)
	// EXPLAIN with the same statement and bound values inlined: the plan for a
	// constant is the plan for a bound parameter here (equality lookups only).
	plan, err := db.QueryContext(ctx, "EXPLAIN "+inlineQueryArguments(query, args))
	if err != nil {
		t.Fatalf("explain: %v", err)
	}
	scanned := 0
	for plan.Next() {
		var (
			id, selectType, table, partitions, planType, possibleKeys, key, keyLen, ref, extra sql.NullString
			planRows                                                                           sql.NullInt64
			filtered                                                                           sql.NullFloat64
		)
		if err := plan.Scan(&id, &selectType, &table, &partitions, &planType, &possibleKeys, &key, &keyLen, &ref, &planRows, &filtered, &extra); err != nil {
			plan.Close()
			t.Fatalf("scan explain: %v", err)
		}
		if table.String != "EconomicDataPoint" {
			continue
		}
		scanned++
		if planType.String == "ALL" || key.String == "" {
			plan.Close()
			t.Fatalf("branch is not index-backed: type=%q key=%q extra=%q", planType.String, key.String, extra.String)
		}
		// The optimizer may pick either ordered range index on a tiny table, but
		// the (itemId, sourceField, recordedAt) index must be a candidate —
		// otherwise the inequality on recordedAt would not be usable as a range.
		if !strings.Contains(possibleKeys.String, "EconomicDataPoint_itemId_sourceField_recordedAt_idx") {
			plan.Close()
			t.Fatalf("branch never considers the itemId/sourceField/recordedAt index: %q", possibleKeys.String)
		}
	}
	plan.Close()
	if scanned == 0 {
		t.Fatal("EXPLAIN returned no EconomicDataPoint branch")
	}
	if err := plan.Err(); err != nil {
		t.Fatalf("explain rows: %v", err)
	}

	store := &MySQLStore{db: db}
	loaded, err := store.SectorEndpoints(ctx, keys, start, end)
	if err != nil {
		t.Fatalf("endpoints: %v", err)
	}
	alpha, ok := loaded[seriesKey{ItemID: "it-alpha", Field: "close"}]
	if !ok {
		t.Fatal("it-alpha/close missing from the endpoint result")
	}
	if alpha.First.Value != 100.5 || !alpha.First.RecordedAt.Equal(time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("first sample = %+v", alpha.First)
	}
	if alpha.Last.Value != 99.75 || !alpha.Last.RecordedAt.Equal(time.Date(2026, 3, 3, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("last sample = %+v", alpha.Last)
	}
	if alpha.Last.Unit.String != "pts" || !alpha.Last.Unit.Valid {
		t.Fatalf("last unit = %+v", alpha.Last.Unit)
	}
	beta, ok := loaded[seriesKey{ItemID: "it-beta", Field: "volume"}]
	if !ok || beta.First.Value != 7 || beta.Last.Value != 7 {
		t.Fatalf("beta endpoints = %+v", beta)
	}
	if _, ok := loaded[seriesKey{ItemID: "it-empty", Field: "close"}]; ok {
		t.Fatal("a series without rows must be absent, like the previous nil lookup")
	}
}
