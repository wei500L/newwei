//go:build integration

// Persist-transaction integration test for the duplicate-status move (S4). It
// runs against the real MySQL the CI api-go-user-settings-integration job
// provides and drives pipelineMySQLStore.persist directly, so it can assert the
// atomicity the unit tests cannot: a committed duplicate persist flips ItemMeta
// to duplicate, while a failed persist rolls the mark back.
//
// The test name contains TestFullPipelineChainIntegration so the existing CI
// step (-run 'TestFullPipelineChainIntegration') executes it.
package newspipeline

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"

	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

func TestFullPipelineChainIntegrationPersistDuplicateAtomicity(t *testing.T) {
	db := openPersistAtomicityMySQL(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)
	store := &pipelineMySQLStore{db: db, now: func() time.Time { return now }}

	dup := "507f1f77bcf86cd799439012"
	newInput := func(metaID, contentHash, sourceURL string, payload []byte) pipelineStoreInput {
		sourceID := "source-1"
		publishedAt := "2026-01-02T03:04:05.000Z"
		title := "Title"
		return pipelineStoreInput{
			Job: Job{
				OrgID:           "org-1",
				ItemMetaID:      metaID,
				ProcessedItemID: "507f1f77bcf86cd799439011",
				SourceID:        &sourceID,
			},
			Raw:     RawItem{ID: "raw-1", ItemMetaID: metaID},
			Payload: NormalizedPayload{URL: sourceURL},
			Article: CrawledArticle{
				SourceURL:   sourceURL,
				Metadata:    []byte(`{}`),
				PublishedAt: &publishedAt,
			},
			Cleaned:         CleanedNews{Title: &title},
			ContentHash:     contentHash,
			ProcessedItemID: "507f1f77bcf86cd799439011",
			OutboxPayload:   payload,
			DuplicateOf:     &dup,
		}
	}

	// Committed persist with a duplicate result flips ItemMeta to duplicate.
	if _, err := db.Exec(`INSERT INTO ItemMeta (id,orgId,externalId,name,status,mongoRef,version,sortAt,createdAt,updatedAt)
		VALUES (?,?,?,?,?,?,?,?,?,?)`, "meta-dup", "org-1", "ext-dup", "Title", string(itemsreading.ItemStatusPending), "", 1, now, now, now); err != nil {
		t.Fatalf("insert dup meta: %v", err)
	}
	if _, err := store.persist(ctx, newInput("meta-dup", "hash-dup", "https://example.com/dup", []byte(`{"type":"processed_item","document":{}}`))); err != nil {
		t.Fatalf("persist duplicate: %v", err)
	}
	if got := itemMetaStatusForTest(t, db, "meta-dup"); got != string(itemsreading.ItemStatusDuplicate) {
		t.Fatalf("ItemMeta.status = %q, want duplicate after committed persist", got)
	}

	// A failing persist (invalid outbox JSON) rolls the duplicate mark back.
	if _, err := db.Exec(`INSERT INTO ItemMeta (id,orgId,externalId,name,status,mongoRef,version,sortAt,createdAt,updatedAt)
		VALUES (?,?,?,?,?,?,?,?,?,?)`, "meta-fail", "org-1", "ext-fail", "Title", string(itemsreading.ItemStatusPending), "", 1, now, now, now); err != nil {
		t.Fatalf("insert fail meta: %v", err)
	}
	if _, err := store.persist(ctx, newInput("meta-fail", "hash-fail", "https://example.com/fail", []byte("not-json"))); err == nil {
		t.Fatal("expected the invalid outbox payload to fail the persist transaction")
	}
	if got := itemMetaStatusForTest(t, db, "meta-fail"); got != string(itemsreading.ItemStatusPending) {
		t.Fatalf("ItemMeta.status = %q, want pending after rolled-back persist", got)
	}
}

func itemMetaStatusForTest(t *testing.T, db *sql.DB, id string) string {
	t.Helper()
	var status string
	if err := db.QueryRow("SELECT status FROM ItemMeta WHERE id = ?", id).Scan(&status); err != nil {
		t.Fatalf("read item meta %s: %v", id, err)
	}
	return status
}

func openPersistAtomicityMySQL(t *testing.T) *sql.DB {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL is not set")
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	password, _ := parsed.User.Password()
	dsn := fmt.Sprintf("%s:%s@tcp(%s)/%s?parseTime=true&loc=UTC&charset=utf8mb4",
		parsed.User.Username(), password, parsed.Host, strings.TrimPrefix(parsed.Path, "/"))
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("ping mysql: %v", err)
	}
	statements := []string{
		"DROP TABLE IF EXISTS ItemMeta",
		"DROP TABLE IF EXISTS Article",
		"DROP TABLE IF EXISTS ProcessedArticle",
		"DROP TABLE IF EXISTS ProcessedArticleTermHourly",
		"DROP TABLE IF EXISTS MongoOutbox",
		`CREATE TABLE ItemMeta (
			id varchar(40) NOT NULL PRIMARY KEY,
			orgId varchar(40) NOT NULL,
			externalId varchar(255) NOT NULL,
			name varchar(255) NOT NULL,
			status varchar(32) NOT NULL DEFAULT 'draft',
			mongoRef varchar(40) NOT NULL DEFAULT '',
			version int NOT NULL DEFAULT 1,
			publishedAt datetime(3) NULL,
			sortAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			createdAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			updatedAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
		) ENGINE=InnoDB`,
		`CREATE TABLE Article (
			id varchar(40) NOT NULL PRIMARY KEY,
			orgId varchar(40) NOT NULL,
			sourceId varchar(40) NULL,
			url varchar(512) NOT NULL,
			urlFingerprint varchar(64) NULL,
			sourceLabel varchar(255) NULL,
			language varchar(32) NULL,
			titleGuess varchar(512) NULL,
			crawlAt datetime(3) NOT NULL,
			contentHash varchar(64) NOT NULL,
			markdownRef varchar(191) NULL,
			version int NOT NULL DEFAULT 1,
			metadata json NULL,
			createdAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			updatedAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			UNIQUE KEY Article_org_url (orgId, url),
			UNIQUE KEY Article_org_contentHash (orgId, contentHash)
		) ENGINE=InnoDB`,
		`CREATE TABLE ProcessedArticle (
			id varchar(40) NOT NULL PRIMARY KEY,
			orgId varchar(40) NOT NULL,
			articleId varchar(40) NOT NULL,
			status varchar(20) NOT NULL DEFAULT 'completed',
			title varchar(512) NULL,
			subtitle varchar(512) NULL,
			author varchar(255) NULL,
			source varchar(255) NULL,
			publishedAt datetime(3) NULL,
			category varchar(120) NULL,
			topics json NULL,
			summary text NULL,
			keyPoints json NULL,
			entities json NULL,
			kgRelations json NULL,
			cleanedMarkdownRef varchar(191) NULL,
			removedNoiseTypes json NULL,
			qualityScore double NULL,
			llmModel varchar(191) NULL,
			llmPromptVersion varchar(191) NULL,
			language varchar(32) NULL,
			location varchar(255) NULL,
			promptTokens int NULL,
			completionTokens int NULL,
			totalTokens int NULL,
			costUsd double NULL,
			latencyMs int NULL,
			eventAt datetime(3) NULL,
			hasLocation tinyint(1) NOT NULL DEFAULT 0,
			createdAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			processedAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			updatedAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			UNIQUE KEY ProcessedArticle_articleId (articleId)
		) ENGINE=InnoDB`,
		`CREATE TABLE ProcessedArticleTermHourly (
			id varchar(40) NOT NULL PRIMARY KEY,
			orgId varchar(40) NOT NULL,
			processedArticleId varchar(40) NOT NULL,
			bucketStart datetime(3) NOT NULL,
			term varchar(191) NOT NULL,
			source varchar(32) NOT NULL,
			articleCount int NOT NULL DEFAULT 1,
			createdAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			updatedAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
		) ENGINE=InnoDB`,
		`CREATE TABLE MongoOutbox (
			id varchar(40) NOT NULL PRIMARY KEY,
			orgId varchar(40) NOT NULL,
			type varchar(32) NOT NULL DEFAULT 'processed_item',
			payload json NOT NULL,
			status varchar(20) NOT NULL DEFAULT 'pending',
			attempts int NOT NULL DEFAULT 0,
			lastError text NULL,
			availableAt datetime(3) NOT NULL,
			lockedAt datetime(3) NULL,
			createdAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			updatedAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
		) ENGINE=InnoDB`,
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("schema statement failed: %v", err)
		}
	}
	t.Cleanup(func() {
		for _, table := range []string{"MongoOutbox", "ProcessedArticleTermHourly", "ProcessedArticle", "Article", "ItemMeta"} {
			_, _ = db.Exec("DROP TABLE IF EXISTS `" + table + "`")
		}
		_ = db.Close()
	})
	return db
}
