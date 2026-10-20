//go:build integration

// News-source preview in-flight query integration test (build tag integration).
//
// It verifies O5: countActivePipelineJobs returns the same bounded count as the
// original findMany + take + length, and findActivePipelineJobs keeps the latest
// createdAt row per URL.
package crawlstrategyruns

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

func integrationDatabaseURL(t *testing.T) string {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set — integration test requires a MySQL service")
	}
	return url
}

func setupPipelineJobs(t *testing.T) *sql.DB {
	t.Helper()
	db, err := usersettings.OpenMySQLFromURL(integrationDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("DROP TABLE IF EXISTS PipelineJob"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE TABLE IF NOT EXISTS PipelineJob (" +
		"id VARCHAR(191) NOT NULL PRIMARY KEY, sourceId VARCHAR(191) NULL, url TEXT NOT NULL," +
		"status VARCHAR(32) NOT NULL, createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)" +
		") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("DELETE FROM PipelineJob WHERE 1 = 1"); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestCountActivePipelineJobsIntegration(t *testing.T) {
	db := setupPipelineJobs(t)
	service := NewPreviewService(db, nil, nil, nil, 21_600_000)
	ctx := context.Background()
	now := time.Now().UTC()
	rows := []struct {
		id     string
		url    string
		status string
		at     time.Time
	}{
		{"j1", "https://example.com/a", "pending", now.Add(-time.Hour)},
		{"j2", "https://example.com/a", "running", now.Add(-30 * time.Minute)},
		{"j3", "https://example.com/b", "queued", now.Add(-15 * time.Minute)},
		{"j4", "https://example.com/c", "completed", now.Add(-10 * time.Minute)},
		{"j5", "https://example.com/d", "delayed", now.Add(-5 * time.Minute)},
	}
	for _, row := range rows {
		if _, err := db.Exec("INSERT INTO PipelineJob (id, sourceId, url, status, createdAt) VALUES (?, ?, ?, ?, ?)",
			row.id, "source-1", row.url, row.status, row.at); err != nil {
			t.Fatal(err)
		}
	}
	cutoff := now.Add(-2 * time.Hour)

	// LIMIT 2 mirrors findMany(take: 2).length = 2.
	count, err := service.countActivePipelineJobs(ctx, "source-1", cutoff, 2)
	if err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("bounded count = %d", count)
	}
	// The cap is 50, so the full active set (4) is returned.
	count, err = service.countActivePipelineJobs(ctx, "source-1", cutoff, 500)
	if err != nil {
		t.Fatal(err)
	}
	if count != 4 {
		t.Fatalf("full count = %d", count)
	}

	active, err := service.findActivePipelineJobs(ctx, "source-1", []string{"https://example.com/a", "https://example.com/c"}, cutoff)
	if err != nil {
		t.Fatal(err)
	}
	if active["https://example.com/a"] == nil || *active["https://example.com/a"] != "running" {
		t.Fatalf("latest status = %+v", active)
	}
	if active["https://example.com/c"] != nil {
		t.Fatalf("completed jobs must not be active: %+v", active)
	}
}
