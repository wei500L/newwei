//go:build integration

package itemsingest

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

func openItemsIngestTestDB(t *testing.T) *sql.DB {
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
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("ping mysql: %v", err)
	}
	statements := []string{
		`CREATE TABLE IF NOT EXISTS ItemMeta (
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
			updatedAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			UNIQUE KEY ItemMeta_org_externalId (orgId, externalId)
		) ENGINE=InnoDB`,
		`CREATE TABLE IF NOT EXISTS MongoOutbox (
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
		`CREATE TABLE IF NOT EXISTS PipelineJob (
			id varchar(40) NOT NULL PRIMARY KEY,
			orgId varchar(40) NOT NULL,
			status varchar(20) NOT NULL DEFAULT 'pending',
			error text NULL,
			completedAt datetime(3) NULL,
			updatedAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
		) ENGINE=InnoDB`,
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("create table: %v", err)
		}
	}
	if _, err := db.ExecContext(ctx, "DELETE FROM MongoOutbox"); err != nil {
		t.Fatalf("clean outbox: %v", err)
	}
	if _, err := db.ExecContext(ctx, "DELETE FROM ItemMeta"); err != nil {
		t.Fatalf("clean items: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestItemsIngestMySQLIntegration(t *testing.T) {
	db := openItemsIngestTestDB(t)
	ctx := context.Background()
	st := newStore(db)
	now := time.Now().UTC().Truncate(time.Millisecond)

	meta := itemMetaForTest("org-1", "external-1", "pending", "")
	if err := insertTestMeta(ctx, db, meta); err != nil {
		t.Fatalf("insert meta: %v", err)
	}

	// First CAS binds raw; the second CAS loses without overwriting the winner.
	var firstWon bool
	if err := (&Service{db: db, store: st}).inTx(ctx, func(tx *sql.Tx) error {
		won, err := claimEmptyRefTx(ctx, tx, "org-1", meta.ID, "507f1f77bcf86cd799439011")
		firstWon = won
		return err
	}); err != nil {
		t.Fatalf("first claim: %v", err)
	}
	if !firstWon {
		t.Fatalf("first CAS lost")
	}
	var secondWon bool
	if err := (&Service{db: db, store: st}).inTx(ctx, func(tx *sql.Tx) error {
		won, err := claimEmptyRefTx(ctx, tx, "org-1", meta.ID, "507f1f77bcf86cd799439012")
		secondWon = won
		return err
	}); err != nil {
		t.Fatalf("second claim: %v", err)
	}
	if secondWon {
		t.Fatalf("second CAS overwrote the winner")
	}
	reloaded, err := st.findItemMetaByID(ctx, "org-1", meta.ID)
	if err != nil || reloaded == nil {
		t.Fatalf("reload: %v %v", reloaded, err)
	}
	if reloaded.MongoRef != "507f1f77bcf86cd799439011" {
		t.Fatalf("mongoRef = %q", reloaded.MongoRef)
	}

	// The outbox row and the ItemMeta update share one transaction.
	outboxMeta := itemMetaForTest("org-1", "external-2", "pending", "")
	if err := insertTestMeta(ctx, db, outboxMeta); err != nil {
		t.Fatalf("insert outbox meta: %v", err)
	}
	payload, err := NormalizeNewsPayload([]byte(`{"url":"https://example.com/a","tags":[" x "],"forceRefresh":true}`))
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	var outboxID string
	if err := (&Service{db: db, store: st}).inTx(ctx, func(tx *sql.Tx) error {
		won, err := claimEmptyRefTx(ctx, tx, "org-1", outboxMeta.ID, "507f1f77bcf86cd799439013")
		if err != nil || !won {
			return fmt.Errorf("claim: won=%v err=%v", won, err)
		}
		outboxID, err = insertOutboxTx(ctx, tx, OutboxPayload{
			Type:       "raw_item",
			OrgID:      "org-1",
			ItemMetaID: outboxMeta.ID,
			RawItemID:  "507f1f77bcf86cd799439013",
			Source:     "api",
			Payload:    payload,
		})
		return err
	}); err != nil {
		t.Fatalf("transaction: %v", err)
	}
	entry, err := st.getOutboxEntry(ctx, outboxID)
	if err != nil || entry == nil {
		t.Fatalf("get outbox: %v %v", entry, err)
	}
	parsed, err := parseOutboxPayload(entry.Payload, "org-1")
	if err != nil {
		t.Fatalf("parse outbox: %v", err)
	}
	if parsed.OrgID != "org-1" || parsed.ItemMetaID != outboxMeta.ID || !parsed.Payload.ForceRefresh {
		t.Fatalf("outbox payload = %+v", parsed)
	}

	// deliverPendingForItemMeta must not let fifty older rows of another item
	// hide the target's row.
	target := itemMetaForTest("org-1", "external-target", "pending", "")
	if err := insertTestMeta(ctx, db, target); err != nil {
		t.Fatalf("insert target: %v", err)
	}
	for index := 0; index < 51; index++ {
		other := OutboxPayload{
			Type:       "raw_item",
			OrgID:      "org-1",
			ItemMetaID: "other-item",
			RawItemID:  fmt.Sprintf("507f1f77bcf86cd79944%04d", index),
			Source:     "api",
			Payload:    payload,
		}
		if err := (&Service{db: db, store: st}).inTx(ctx, func(tx *sql.Tx) error {
			_, err := insertOutboxTx(ctx, tx, other)
			return err
		}); err != nil {
			t.Fatalf("insert other outbox: %v", err)
		}
	}
	targetOutbox, err := insertOutboxForTest(ctx, db, st, OutboxPayload{
		Type:       "raw_item",
		OrgID:      "org-1",
		ItemMetaID: target.ID,
		RawItemID:  "507f1f77bcf86cd799439099",
		Source:     "api",
		Payload:    payload,
	})
	if err != nil {
		t.Fatalf("insert target outbox: %v", err)
	}
	entries, err := st.listOutboxForItemMeta(ctx, "org-1", target.ID)
	if err != nil {
		t.Fatalf("list target outbox: %v", err)
	}
	if len(entries) != 1 || entries[0].ID != targetOutbox {
		t.Fatalf("target outbox list = %+v", entries)
	}

	// Dead compensation only touches an ItemMeta that still references the
	// failed raw id.
	deadMeta := itemMetaForTest("org-1", "external-dead", "pending", "507f1f77bcf86cd799439021")
	if err := insertTestMeta(ctx, db, deadMeta); err != nil {
		t.Fatalf("insert dead meta: %v", err)
	}
	deadPayload := &OutboxPayload{
		Type:       "raw_item",
		OrgID:      "org-1",
		ItemMetaID: deadMeta.ID,
		RawItemID:  "507f1f77bcf86cd799439021",
		Source:     "api",
		Payload:    payload,
	}
	deadID, err := insertOutboxForTest(ctx, db, st, *deadPayload)
	if err != nil {
		t.Fatalf("insert dead outbox: %v", err)
	}
	if err := st.markOutboxDead(ctx, deadID, 10, "boom", deadPayload); err != nil {
		t.Fatalf("mark dead: %v", err)
	}
	deadReloaded, _ := st.findItemMetaByID(ctx, "org-1", deadMeta.ID)
	if deadReloaded == nil || deadReloaded.Status != "failed" {
		t.Fatalf("dead meta status = %+v", deadReloaded)
	}

	// A newer raw reference must never be polluted by an old dead row.
	replacedMeta := itemMetaForTest("org-1", "external-replaced", "pending", "507f1f77bcf86cd799439031")
	if err := insertTestMeta(ctx, db, replacedMeta); err != nil {
		t.Fatalf("insert replaced meta: %v", err)
	}
	oldPayload := &OutboxPayload{
		Type:       "raw_item",
		OrgID:      "org-1",
		ItemMetaID: replacedMeta.ID,
		RawItemID:  "507f1f77bcf86cd799439031",
		Source:     "api",
		Payload:    payload,
	}
	oldID, err := insertOutboxForTest(ctx, db, st, *oldPayload)
	if err != nil {
		t.Fatalf("insert old outbox: %v", err)
	}
	if _, err := db.ExecContext(ctx, "UPDATE ItemMeta SET mongoRef = ?, updatedAt = ? WHERE id = ?",
		"507f1f77bcf86cd799439032", now, replacedMeta.ID); err != nil {
		t.Fatalf("replace ref: %v", err)
	}
	if err := st.markOutboxDead(ctx, oldID, 10, "old", oldPayload); err != nil {
		t.Fatalf("mark old dead: %v", err)
	}
	replaced, _ := st.findItemMetaByID(ctx, "org-1", replacedMeta.ID)
	if replaced == nil || replaced.Status != "pending" || replaced.MongoRef != "507f1f77bcf86cd799439032" {
		t.Fatalf("new reference polluted: %+v", replaced)
	}
}

func itemMetaForTest(orgID, externalID, status, mongoRef string) itemsreading.ItemMetaRow {
	now := itemsreading.NewISOTime(time.Now().UTC().Truncate(time.Millisecond))
	return itemsreading.ItemMetaRow{
		ID:         newRowID(),
		OrgID:      orgID,
		ExternalID: externalID,
		Name:       externalID,
		Status:     status,
		MongoRef:   mongoRef,
		Version:    1,
		SortAt:     now,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
}

func insertTestMeta(ctx context.Context, db *sql.DB, meta itemsreading.ItemMetaRow) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := insertItemMetaTx(ctx, tx, meta); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

func insertOutboxForTest(ctx context.Context, db *sql.DB, st *store, payload OutboxPayload) (string, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	id, err := insertOutboxTx(ctx, tx, payload)
	if err != nil {
		_ = tx.Rollback()
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	_ = st
	return id, nil
}
