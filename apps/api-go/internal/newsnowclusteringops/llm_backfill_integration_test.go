//go:build integration

// Integration tests of the NewsEvent/NewsEventItem writes of the LLM backfill.
// They run against the MySQL service of the existing api-go integration job and
// skip when DATABASE_URL is absent.
package newsnowclusteringops

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

const createNewsEventTable = "CREATE TABLE IF NOT EXISTS NewsEvent (" +
	"id VARCHAR(191) NOT NULL," +
	"orgId VARCHAR(191) NOT NULL," +
	"status ENUM('active','archived') NOT NULL DEFAULT 'active'," +
	"language VARCHAR(191) NULL," +
	"primaryTopic VARCHAR(191) NULL," +
	"primaryEntity VARCHAR(191) NULL," +
	"title VARCHAR(191) NULL," +
	"summary VARCHAR(191) NULL," +
	"startAt DATETIME(3) NOT NULL," +
	"lastAt DATETIME(3) NOT NULL," +
	"representativeProcessedArticleId VARCHAR(191) NULL," +
	"representativeProcessedItemId VARCHAR(191) NULL," +
	"metadata JSON NULL," +
	"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
	"updatedAt DATETIME(3) NOT NULL," +
	"PRIMARY KEY (id)" +
	") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

const createNewsEventItemTable = "CREATE TABLE IF NOT EXISTS NewsEventItem (" +
	"id VARCHAR(191) NOT NULL," +
	"orgId VARCHAR(191) NOT NULL," +
	"eventId VARCHAR(191) NOT NULL," +
	"processedArticleId VARCHAR(191) NOT NULL," +
	"processedItemId VARCHAR(191) NULL," +
	"similarity DOUBLE NULL," +
	"assignedBy ENUM('vector','overlap','manual') NOT NULL DEFAULT 'overlap'," +
	"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
	"UNIQUE INDEX NewsEventItem_orgId_processedArticleId_key (orgId, processedArticleId)," +
	"PRIMARY KEY (id)" +
	") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

func integrationDB(t *testing.T) *sql.DB {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set — integration test requires a MySQL service")
	}
	db, err := usersettings.OpenMySQLFromURL(databaseURL)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	if _, err := db.Exec(createNewsEventTable); err != nil {
		t.Fatalf("create NewsEvent: %v", err)
	}
	if _, err := db.Exec(createNewsEventItemTable); err != nil {
		t.Fatalf("create NewsEventItem: %v", err)
	}
	return db
}

func signalFor(articleID string, timestamp time.Time, topic, entity string) newsSignal {
	signal := newsSignal{
		ProcessedArticleID: articleID,
		Timestamp:          timestamp,
		Title:              stringPtr("title " + articleID),
		Summary:            stringPtr("summary " + articleID),
		Topics:             []string{topic},
	}
	if entity != "" {
		signal.Entities = []clusteringFailureEntityDoc{{Name: entity}}
	}
	return signal
}

func TestIntegrationAssignSignalToNewEventIsIdempotent(t *testing.T) {
	db := integrationDB(t)
	defer db.Close()
	ctx := context.Background()
	orgID := "org-integration-assign-new"
	defer func() {
		db.ExecContext(ctx, "DELETE FROM NewsEventItem WHERE orgId = ?", orgID)
		db.ExecContext(ctx, "DELETE FROM NewsEvent WHERE orgId = ?", orgID)
	}()
	service := NewService(ServiceConfig{}, db, nil, nil, nil)
	now := time.Now().UTC().Truncate(time.Millisecond)
	signal := signalFor("article-new-1", now.Add(-time.Hour), "politics", "")

	first, err := service.assignSignalToNewEvent(ctx, orgID, signal)
	if err != nil {
		t.Fatalf("first assign: %v", err)
	}
	if !first.Created || first.EventID == "" {
		t.Fatalf("first result = %+v", first)
	}

	var eventCount, itemCount int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM NewsEvent WHERE orgId = ?", orgID).Scan(&eventCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM NewsEventItem WHERE orgId = ?", orgID).Scan(&itemCount); err != nil {
		t.Fatal(err)
	}
	if eventCount != 1 || itemCount != 1 {
		t.Fatalf("events=%d items=%d", eventCount, itemCount)
	}

	var assignedBy string
	var similarity sql.NullFloat64
	var title string
	if err := db.QueryRowContext(ctx,
		"SELECT i.assignedBy, i.similarity, e.title FROM NewsEventItem i JOIN NewsEvent e ON e.id = i.eventId"+
			" WHERE i.orgId = ? AND i.processedArticleId = ?", orgID, signal.ProcessedArticleID).
		Scan(&assignedBy, &similarity, &title); err != nil {
		t.Fatal(err)
	}
	if assignedBy != "manual" || similarity.Valid {
		t.Fatalf("assignedBy=%q similarity=%v", assignedBy, similarity)
	}
	if title != "title article-new-1" {
		t.Fatalf("title = %q", title)
	}

	second, err := service.assignSignalToNewEvent(ctx, orgID, signal)
	if err != nil {
		t.Fatalf("second assign: %v", err)
	}
	if second.Created || second.EventID != first.EventID {
		t.Fatalf("second result = %+v, want event %s", second, first.EventID)
	}
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM NewsEventItem WHERE orgId = ?", orgID).Scan(&itemCount); err != nil {
		t.Fatal(err)
	}
	if itemCount != 1 {
		t.Fatalf("duplicate item count = %d", itemCount)
	}
}

func TestIntegrationAssignSignalToSpecificEventWidensWindow(t *testing.T) {
	db := integrationDB(t)
	defer db.Close()
	ctx := context.Background()
	orgID := "org-integration-assign-specific"
	defer func() {
		db.ExecContext(ctx, "DELETE FROM NewsEventItem WHERE orgId = ?", orgID)
		db.ExecContext(ctx, "DELETE FROM NewsEvent WHERE orgId = ?", orgID)
	}()
	service := NewService(ServiceConfig{}, db, nil, nil, nil)
	base := time.Now().UTC().Truncate(time.Millisecond).Add(-24 * time.Hour)

	first, err := service.assignSignalToNewEvent(ctx, orgID, signalFor("article-specific-1", base, "tech", ""))
	if err != nil {
		t.Fatalf("create event: %v", err)
	}
	similarity := 0.93
	later := signalFor("article-specific-2", base.Add(2*time.Hour), "tech", "")
	assigned, err := service.assignSignalToSpecificEvent(ctx, orgID, first.EventID, later, &similarity)
	if err != nil {
		t.Fatalf("assign specific: %v", err)
	}
	if !assigned.Created || assigned.EventID != first.EventID {
		t.Fatalf("assigned = %+v", assigned)
	}
	var startAt, lastAt time.Time
	if err := db.QueryRowContext(ctx, "SELECT startAt, lastAt FROM NewsEvent WHERE id = ?", first.EventID).Scan(&startAt, &lastAt); err != nil {
		t.Fatal(err)
	}
	if !startAt.Equal(base) || !lastAt.Equal(base.Add(2*time.Hour)) {
		t.Fatalf("window = %s .. %s", startAt, lastAt)
	}
	var stored float64
	var assignedBy string
	if err := db.QueryRowContext(ctx,
		"SELECT similarity, assignedBy FROM NewsEventItem WHERE orgId = ? AND processedArticleId = ?",
		orgID, later.ProcessedArticleID).Scan(&stored, &assignedBy); err != nil {
		t.Fatal(err)
	}
	if stored != similarity || assignedBy != "manual" {
		t.Fatalf("similarity=%v assignedBy=%q", stored, assignedBy)
	}

	// A duplicate article must not be attached twice. The NestJS pre-check
	// returns the event that already holds the article (created=false); the
	// requested target is only returned by the in-transaction P2002 branch,
	// which a non-racing call never reaches.
	other, err := service.assignSignalToNewEvent(ctx, orgID, signalFor("article-specific-3", base, "finance", ""))
	if err != nil {
		t.Fatalf("create other event: %v", err)
	}
	duplicate, err := service.assignSignalToSpecificEvent(ctx, orgID, other.EventID, later, &similarity)
	if err != nil {
		t.Fatalf("duplicate assign: %v", err)
	}
	if duplicate.Created || duplicate.EventID != first.EventID {
		t.Fatalf("duplicate = %+v", duplicate)
	}
	var storedEventID string
	if err := db.QueryRowContext(ctx,
		"SELECT eventId FROM NewsEventItem WHERE orgId = ? AND processedArticleId = ?",
		orgID, later.ProcessedArticleID).Scan(&storedEventID); err != nil {
		t.Fatal(err)
	}
	if storedEventID != first.EventID {
		t.Fatalf("stored event = %q, want %q", storedEventID, first.EventID)
	}
}

func TestIntegrationAssignSignalRejectsUnknownEvent(t *testing.T) {
	db := integrationDB(t)
	defer db.Close()
	ctx := context.Background()
	service := NewService(ServiceConfig{}, db, nil, nil, nil)
	_, err := service.assignSignalToSpecificEvent(ctx, "org-integration-unknown", "missing-event",
		signalFor("article-unknown", time.Now().UTC(), "tech", ""), nil)
	if err == nil {
		t.Fatal("expected an error for a missing event")
	}
	if !errors.Is(err, errNoNewsEvent) {
		// Production fails the insert on the NewsEvent foreign key before this
		// point; the test table has no FK, so the window read is the first
		// failure and reports errNoNewsEvent. Both are errors, never a silent
		// success.
		t.Fatalf("error = %v", err)
	}
}
