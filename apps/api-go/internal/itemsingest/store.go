package itemsingest

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlreadtelemetry"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

// itemMetaColumns matches scanItemMeta.
const itemMetaColumns = "`id`, `orgId`, `externalId`, `name`, `status`, `mongoRef`, `version`, `publishedAt`, `sortAt`, `createdAt`, `updatedAt`"

// store is the MySQL access layer of the write chain. Every statement that can
// touch a tenant carries orgId.
type store struct {
	db *sql.DB
}

func newStore(db *sql.DB) *store { return &store{db: db} }

func (s *store) findItemMetaByExternalID(ctx context.Context, orgID, externalID string) (*itemsreading.ItemMetaRow, error) {
	row := s.db.QueryRowContext(ctx,
		"SELECT "+itemMetaColumns+" FROM ItemMeta WHERE orgId = ? AND externalId = ? LIMIT 1",
		orgID, externalID)
	return scanItemMeta(row)
}

func (s *store) findItemMetaByID(ctx context.Context, orgID, id string) (*itemsreading.ItemMetaRow, error) {
	row := s.db.QueryRowContext(ctx,
		"SELECT "+itemMetaColumns+" FROM ItemMeta WHERE id = ? AND orgId = ? LIMIT 1",
		id, orgID)
	return scanItemMeta(row)
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanItemMeta(scanner rowScanner) (*itemsreading.ItemMetaRow, error) {
	var row itemsreading.ItemMetaRow
	var publishedAt sql.NullTime
	var sortAt, createdAt, updatedAt time.Time
	err := scanner.Scan(
		&row.ID, &row.OrgID, &row.ExternalID, &row.Name, &row.Status, &row.MongoRef,
		&row.Version, &publishedAt, &sortAt, &createdAt, &updatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if publishedAt.Valid {
		value := itemsreading.NewISOTime(publishedAt.Time)
		row.PublishedAt = &value
	}
	row.SortAt = itemsreading.NewISOTime(sortAt)
	row.CreatedAt = itemsreading.NewISOTime(createdAt)
	row.UpdatedAt = itemsreading.NewISOTime(updatedAt)
	return &row, nil
}

// insertItemMeta writes the explicit create values. sortAt/createdAt/updatedAt
// are written by the caller because MySQL has no Prisma-side defaults here.
func insertItemMetaTx(ctx context.Context, tx *sql.Tx, row itemsreading.ItemMetaRow) error {
	_, err := tx.ExecContext(ctx,
		"INSERT INTO ItemMeta (`id`,`orgId`,`externalId`,`name`,`status`,`mongoRef`,`version`,`publishedAt`,`sortAt`,`createdAt`,`updatedAt`) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
		row.ID, row.OrgID, row.ExternalID, row.Name, row.Status, row.MongoRef, row.Version,
		nullableTime(row.PublishedAt), row.SortAt.Time, row.CreatedAt.Time, row.UpdatedAt.Time)
	return err
}

func nullableTime(value *itemsreading.ISOTime) any {
	if value == nil {
		return nil
	}
	return value.Time
}

// insertOutboxTx writes the raw_item envelope. The payload is JSON-encoded here
// with typed members; orgId inside the payload is the row orgId.
func insertOutboxTx(ctx context.Context, tx *sql.Tx, payload OutboxPayload) (string, error) {
	id := newRowID()
	encoded, err := json.Marshal(outboxEnvelope{
		Type:          payload.Type,
		OrgID:         payload.OrgID,
		ItemMetaID:    payload.ItemMetaID,
		RawItemID:     payload.RawItemID,
		Source:        payload.Source,
		Payload:       payload.Payload,
		PipelineJobID: payload.PipelineJobID,
		SourceID:      payload.SourceID,
		Priority:      payload.Priority,
	})
	if err != nil {
		return "", err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	_, err = tx.ExecContext(ctx,
		"INSERT INTO MongoOutbox (`id`,`orgId`,`type`,`payload`,`status`,`attempts`,`lastError`,`availableAt`,`lockedAt`,`createdAt`,`updatedAt`) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
		id, payload.OrgID, "raw_item", string(encoded), "pending", 0, nil, now, nil, now, now)
	if err != nil {
		return "", err
	}
	return id, nil
}

// outboxEnvelope is the JSON written into MongoOutbox.payload.
type outboxEnvelope struct {
	Type          string                `json:"type"`
	OrgID         string                `json:"orgId"`
	ItemMetaID    string                `json:"itemMetaId"`
	RawItemID     string                `json:"rawItemId"`
	Source        string                `json:"source"`
	Payload       NormalizedNewsPayload `json:"payload"`
	PipelineJobID *string               `json:"pipelineJobId,omitempty"`
	SourceID      *string               `json:"sourceId,omitempty"`
	Priority      *int64                `json:"priority,omitempty"`
}

func isUniqueViolation(err error) bool {
	var mysqlErr *mysql.MySQLError
	if errors.As(err, &mysqlErr) {
		return mysqlErr.Number == 1062
	}
	return false
}

// claimEmptyRefTx binds a pre-allocated raw id to an ItemMeta whose mongoRef is
// still empty. Zero rows means another writer won; the caller must not delete
// the winner's raw document.
func claimEmptyRefTx(ctx context.Context, tx *sql.Tx, orgID, itemMetaID, rawItemID string) (bool, error) {
	result, err := tx.ExecContext(ctx,
		"UPDATE ItemMeta SET mongoRef = ?, updatedAt = ? WHERE id = ? AND orgId = ? AND mongoRef = ''",
		rawItemID, time.Now().UTC().Truncate(time.Millisecond), itemMetaID, orgID)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return affected > 0, nil
}

// updateItemMetaTx applies the name/status/mongoRef change and returns the
// post-update row. A nil rawItemID keeps the existing reference.
func updateItemMetaTx(ctx context.Context, tx *sql.Tx, existing itemsreading.ItemMetaRow, name, status string, rawItemID *string, now time.Time) (itemsreading.ItemMetaRow, error) {
	mongoRef := existing.MongoRef
	if rawItemID != nil {
		mongoRef = *rawItemID
	}
	_, err := tx.ExecContext(ctx,
		"UPDATE ItemMeta SET name = ?, status = ?, mongoRef = ?, updatedAt = ? WHERE id = ? AND orgId = ?",
		name, status, mongoRef, now, existing.ID, existing.OrgID)
	if err != nil {
		return itemsreading.ItemMetaRow{}, err
	}
	updated := existing
	updated.Name = name
	updated.Status = status
	updated.MongoRef = mongoRef
	updated.UpdatedAt = itemsreading.NewISOTime(now)
	return updated, nil
}

func (s *store) getOutboxEntry(ctx context.Context, id string) (*OutboxEntry, error) {
	var entry OutboxEntry
	var payload []byte
	var attempts sql.NullInt64
	err := s.db.QueryRowContext(ctx,
		"SELECT id, orgId, payload, status, attempts, createdAt FROM MongoOutbox WHERE id = ? AND type = 'raw_item'",
		id,
	).Scan(&entry.ID, &entry.OrgID, &payload, &entry.Status, &attempts, &entry.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	entry.Payload = payload
	entry.Attempts = int(attempts.Int64)
	return &entry, nil
}

// claimOutboxTx implements the raw_item conditional claim. pending/failed need
// availableAt <= now; processing only qualifies after the five-minute stale
// window. A zero-row update returns false without forcing a future retry.
func (s *store) claimOutboxTx(ctx context.Context, tx *sql.Tx, entry OutboxEntry) (*OutboxEntry, error) {
	now := time.Now().UTC().Truncate(time.Millisecond)
	var result sql.Result
	var err error
	if entry.Status == "processing" {
		result, err = tx.ExecContext(ctx,
			"UPDATE MongoOutbox SET status = 'processing', lockedAt = ?, attempts = attempts + 1, lastError = NULL, updatedAt = ? WHERE id = ? AND type = 'raw_item' AND status = 'processing' AND lockedAt < ?",
			now, now, entry.ID, now.Add(-outboxStaleLockWindow))
	} else {
		result, err = tx.ExecContext(ctx,
			"UPDATE MongoOutbox SET status = 'processing', lockedAt = ?, attempts = attempts + 1, lastError = NULL, updatedAt = ? WHERE id = ? AND type = 'raw_item' AND status IN ('pending','failed') AND availableAt <= ?",
			now, now, entry.ID, now)
	}
	if err != nil {
		return nil, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if affected == 0 {
		return nil, nil
	}
	row := tx.QueryRowContext(ctx,
		"SELECT id, orgId, payload, status, attempts, createdAt FROM MongoOutbox WHERE id = ?",
		entry.ID)
	var claimed OutboxEntry
	var payload []byte
	var attempts sql.NullInt64
	if err := row.Scan(&claimed.ID, &claimed.OrgID, &payload, &claimed.Status, &attempts, &claimed.CreatedAt); err != nil {
		return nil, err
	}
	claimed.Payload = payload
	claimed.Attempts = int(attempts.Int64)
	return &claimed, nil
}

func (s *store) deleteOutbox(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM MongoOutbox WHERE id = ? AND type = 'raw_item'", id)
	return err
}

func (s *store) markOutboxFailure(ctx context.Context, id string, attempts int, message string, availableAt time.Time) error {
	_, err := s.db.ExecContext(ctx,
		"UPDATE MongoOutbox SET status = 'failed', lastError = ?, availableAt = ?, lockedAt = NULL, updatedAt = ? WHERE id = ? AND type = 'raw_item'",
		message, availableAt, time.Now().UTC().Truncate(time.Millisecond), id)
	return err
}

// markOutboxDead writes the dead state and runs the reference-scoped
// compensation: ItemMeta only when it still points at this raw id, PipelineJob
// only when the payload carried a pipelineJobId.
func (s *store) markOutboxDead(ctx context.Context, id string, attempts int, message string, payload *OutboxPayload) error {
	now := time.Now().UTC().Truncate(time.Millisecond)
	_, err := s.db.ExecContext(ctx,
		"UPDATE MongoOutbox SET status = 'dead', lastError = ?, availableAt = ?, lockedAt = NULL, attempts = ?, updatedAt = ? WHERE id = ? AND type = 'raw_item'",
		message, now, attempts, now, id)
	if err != nil {
		return err
	}
	if payload == nil {
		return nil
	}
	_, _ = s.db.ExecContext(ctx,
		"UPDATE ItemMeta SET status = 'failed', updatedAt = ? WHERE id = ? AND orgId = ? AND mongoRef = ?",
		now, payload.ItemMetaID, payload.OrgID, payload.RawItemID)
	if payload.PipelineJobID != nil {
		_, _ = s.db.ExecContext(ctx,
			"UPDATE PipelineJob SET status = 'failed', error = ?, completedAt = ?, updatedAt = ? WHERE id = ? AND orgId = ?",
			message, now, now, *payload.PipelineJobID, payload.OrgID)
	}
	return nil
}

// listOutboxForItemMeta now filters on the JSON payload's itemMetaId before the
// 50-row cut, so an unrelated item can no longer hide this item's entries.
func (s *store) listOutboxForItemMeta(ctx context.Context, orgID, itemMetaID string) ([]OutboxEntry, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT id, orgId, payload, status, attempts, createdAt FROM MongoOutbox WHERE orgId = ? AND type = 'raw_item' AND status IN ('pending','failed','processing') AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.itemMetaId')) = ? ORDER BY createdAt ASC, id ASC LIMIT 50",
		orgID, itemMetaID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanOutboxEntries(rows)
}

// listRetryEntries ports the three-status scan: each group takes at most 50,
// then the merged set keeps the first 50 by (createdAt, id).
func (s *store) listRetryEntries(ctx context.Context) ([]OutboxEntry, error) {
	now := time.Now().UTC().Truncate(time.Millisecond)
	groups := make([][]OutboxEntry, 0, 3)
	queries := []struct {
		where string
		args  []any
	}{
		{"status = 'pending' AND availableAt <= ?", []any{now}},
		{"status = 'failed' AND availableAt <= ?", []any{now}},
		{"status = 'processing' AND lockedAt < ?", []any{now.Add(-outboxStaleLockWindow)}},
	}
	for _, query := range queries {
		rows, err := s.db.QueryContext(ctx,
			"SELECT id, orgId, payload, status, attempts, createdAt FROM MongoOutbox WHERE type = 'raw_item' AND "+query.where+" ORDER BY createdAt ASC, id ASC LIMIT 50",
			query.args...)
		if err != nil {
			return nil, err
		}
		entries, err := scanOutboxEntries(rows)
		rows.Close()
		if err != nil {
			return nil, err
		}
		groups = append(groups, entries)
	}
	return mergeRetryEntries(groups, 50), nil
}

func scanOutboxEntries(rows *sql.Rows) ([]OutboxEntry, error) {
	out := make([]OutboxEntry, 0, 50)
	for rows.Next() {
		var entry OutboxEntry
		var payload []byte
		var attempts sql.NullInt64
		if err := rows.Scan(&entry.ID, &entry.OrgID, &payload, &entry.Status, &attempts, &entry.CreatedAt); err != nil {
			return nil, err
		}
		entry.Payload = payload
		entry.Attempts = int(attempts.Int64)
		out = append(out, entry)
	}
	return out, rows.Err()
}

func mergeRetryEntries(groups [][]OutboxEntry, take int) []OutboxEntry {
	merged := make(map[string]OutboxEntry)
	for _, group := range groups {
		for _, entry := range group {
			if _, exists := merged[entry.ID]; !exists {
				merged[entry.ID] = entry
			}
		}
	}
	out := make([]OutboxEntry, 0, len(merged))
	for _, entry := range merged {
		out = append(out, entry)
	}
	sortOutboxEntries(out)
	if len(out) > take {
		out = out[:take]
	}
	return out
}

func sortOutboxEntries(entries []OutboxEntry) {
	sort.Slice(entries, func(left, right int) bool {
		if !entries[left].CreatedAt.Equal(entries[right].CreatedAt) {
			return entries[left].CreatedAt.Before(entries[right].CreatedAt)
		}
		return entries[left].ID < entries[right].ID
	})
}

// crawlResultsByIDs loads the ingest projection for the requested ids, scoped
// by the task organization.
func (s *store) crawlResultsByIDs(ctx context.Context, orgID string, ids []string) ([]CrawlResultRow, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	placeholders := make([]string, 0, len(ids))
	args := make([]any, 0, len(ids)+1)
	for _, id := range ids {
		placeholders = append(placeholders, "?")
		args = append(args, id)
	}
	args = append(args, orgID)
	rows, err := s.db.QueryContext(ctx,
		"SELECT r.id, r.taskId, r.sourceUrl, r.fetchedAt, r.contentHash, r.metadata, t.id, t.displayName, t.targetUrl, t.keywords, t.config "+
			"FROM CrawlResult r JOIN CrawlTask t ON t.id = r.taskId WHERE r.id IN ("+strings.Join(placeholders, ",")+") AND t.orgId = ?",
		args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanCrawlResultRows(rows)
}

// crawlResultsPage reads one org-authorized task page. afterID follows Prisma's
// row-cursor semantics: the cursor row is resolved by its unique id (regardless
// of task) and the page starts strictly after its (fetchedAt, id) position.
func (s *store) crawlResultsPage(ctx context.Context, taskID string, afterID string, take int) ([]CrawlResultRow, error) {
	query := "SELECT r.id, r.taskId, r.sourceUrl, r.fetchedAt, r.contentHash, r.metadata, t.id, t.displayName, t.targetUrl, t.keywords, t.config " +
		"FROM CrawlResult r JOIN CrawlTask t ON t.id = r.taskId WHERE r.taskId = ?"
	args := []any{taskID}
	if afterID != "" {
		var fetchedAt time.Time
		err := s.db.QueryRowContext(ctx, "SELECT fetchedAt FROM CrawlResult WHERE id = ?", afterID).Scan(&fetchedAt)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrCursorNotFound
		}
		if err != nil {
			return nil, err
		}
		query += " AND (r.fetchedAt < ? OR (r.fetchedAt = ? AND r.id < ?))"
		args = append(args, fetchedAt, fetchedAt, afterID)
	}
	query += " ORDER BY r.fetchedAt DESC, r.id DESC LIMIT ?"
	args = append(args, take+1)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanCrawlResultRows(rows)
}

func scanCrawlResultRows(rows *sql.Rows) ([]CrawlResultRow, error) {
	out := make([]CrawlResultRow, 0, 32)
	for rows.Next() {
		var row CrawlResultRow
		var metadata, keywords, config []byte
		if err := rows.Scan(
			&row.ID, &row.TaskID, &row.SourceURL, &row.FetchedAt, &row.ContentHash, &metadata,
			&row.Task.ID, &row.Task.DisplayName, &row.Task.TargetURL, &keywords, &config,
		); err != nil {
			return nil, err
		}
		row.Metadata = metadata
		row.Task.Keywords = keywords
		row.Task.Config = config
		out = append(out, row)
	}
	return out, rows.Err()
}

func (s *store) crawlTaskExists(ctx context.Context, orgID, taskID string) (bool, error) {
	var probe int
	err := s.db.QueryRowContext(ctx, "SELECT 1 FROM CrawlTask WHERE id = ? AND orgId = ? LIMIT 1", taskID, orgID).Scan(&probe)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// loadCrawlTaskView reuses the existing toView projection and result count.
func (s *store) loadCrawlTaskView(ctx context.Context, orgID, taskID string) (*crawlreadtelemetry.CrawlTaskView, error) {
	rows, err := s.db.QueryContext(ctx,
		crawlreadtelemetry.CrawlTaskViewSelectSQL+" WHERE t.id = ? AND t.orgId = ? LIMIT 1",
		taskID, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	views, err := crawlreadtelemetry.ScanCrawlTaskViews(rows)
	if err != nil {
		return nil, err
	}
	if len(views) == 0 {
		return nil, nil
	}
	return &views[0], nil
}

func (s *store) updateCrawlTaskConfig(ctx context.Context, orgID, taskID string, config []byte) error {
	now := time.Now().UTC().Truncate(time.Millisecond)
	var value any
	if config != nil {
		value = string(config)
	}
	_, err := s.db.ExecContext(ctx,
		"UPDATE CrawlTask SET config = ?, updatedAt = ? WHERE id = ? AND orgId = ?",
		value, now, taskID, orgID)
	return err
}

// insertMissingCrawlResultMetas mirrors createMany({skipDuplicates:true}).
func (s *store) insertMissingCrawlResultMetas(ctx context.Context, rows []itemsreading.ItemMetaRow) error {
	if len(rows) == 0 {
		return nil
	}
	var builder strings.Builder
	builder.WriteString("INSERT IGNORE INTO ItemMeta (`id`,`orgId`,`externalId`,`name`,`status`,`mongoRef`,`version`,`publishedAt`,`sortAt`,`createdAt`,`updatedAt`) VALUES ")
	args := make([]any, 0, len(rows)*11)
	for index, row := range rows {
		if index > 0 {
			builder.WriteString(",")
		}
		builder.WriteString("(?,?,?,?,?,?,?,?,?,?,?)")
		args = append(args, row.ID, row.OrgID, row.ExternalID, row.Name, row.Status, row.MongoRef,
			row.Version, nil, row.SortAt.Time, row.CreatedAt.Time, row.UpdatedAt.Time)
	}
	_, err := s.db.ExecContext(ctx, builder.String(), args...)
	return err
}

func (s *store) itemMetasByExternalIDs(ctx context.Context, orgID string, externalIDs []string) ([]itemsreading.ItemMetaRow, error) {
	if len(externalIDs) == 0 {
		return nil, nil
	}
	placeholders := make([]string, 0, len(externalIDs))
	args := make([]any, 0, len(externalIDs)+1)
	for _, externalID := range externalIDs {
		placeholders = append(placeholders, "?")
		args = append(args, externalID)
	}
	args = append(args, orgID)
	rows, err := s.db.QueryContext(ctx,
		"SELECT "+itemMetaColumns+" FROM ItemMeta WHERE externalId IN ("+strings.Join(placeholders, ",")+") AND orgId = ?",
		args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]itemsreading.ItemMetaRow, 0, len(externalIDs))
	for rows.Next() {
		row, err := scanItemMeta(rows)
		if err != nil {
			return nil, err
		}
		if row != nil {
			out = append(out, *row)
		}
	}
	return out, rows.Err()
}

// bindEmptyRef is the non-transactional crawl-import CAS.
func (s *store) bindEmptyRef(ctx context.Context, orgID, itemMetaID, rawItemID string) (bool, error) {
	result, err := s.db.ExecContext(ctx,
		"UPDATE ItemMeta SET mongoRef = ?, updatedAt = ? WHERE id = ? AND orgId = ? AND mongoRef = ''",
		rawItemID, time.Now().UTC().Truncate(time.Millisecond), itemMetaID, orgID)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return affected > 0, nil
}

// cleanupEmptyMetas deletes only metas created by this process that are still
// unbound and belong to the organization.
func (s *store) cleanupEmptyMetas(ctx context.Context, orgID string, itemMetaIDs []string) error {
	if len(itemMetaIDs) == 0 {
		return nil
	}
	placeholders := make([]string, 0, len(itemMetaIDs))
	args := make([]any, 0, len(itemMetaIDs)+1)
	for _, id := range itemMetaIDs {
		placeholders = append(placeholders, "?")
		args = append(args, id)
	}
	args = append(args, orgID)
	_, err := s.db.ExecContext(ctx,
		"DELETE FROM ItemMeta WHERE id IN ("+strings.Join(placeholders, ",")+") AND orgId = ? AND mongoRef = ''",
		args...)
	return err
}

func (s *store) insertAuditLog(ctx context.Context, orgID, userID, resource, action string, metadata []byte) error {
	now := time.Now().UTC().Truncate(time.Millisecond)
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO AuditLog (`id`,`orgId`,`actorId`,`resource`,`action`,`metadata`,`ipAddress`,`createdAt`) VALUES (?,?,?,?,?,?,?,?)",
		newRowID(), orgID, userID, resource, action, metadata, nil, now)
	if err == nil {
		return nil
	}
	payload := auditOutboxPayload{
		OrgID:     orgID,
		ActorID:   &userID,
		Resource:  resource,
		Action:    action,
		Metadata:  json.RawMessage(metadata),
		IPAddress: nil,
		CreatedAt: itemsreading.FormatISOTime(now),
	}
	encoded, marshalErr := json.Marshal(payload)
	if marshalErr != nil {
		return err
	}
	_, outboxErr := s.db.ExecContext(ctx,
		"INSERT INTO AuditLogOutbox (`id`,`orgId`,`payload`,`status`,`attempts`,`availableAt`,`createdAt`,`updatedAt`) VALUES (?,?,?,?,?,?,?,?)",
		newRowID(), orgID, string(encoded), "pending", 0, now, now, now)
	if outboxErr != nil {
		return fmt.Errorf("audit log failed: %v; outbox failed: %w", err, outboxErr)
	}
	return nil
}

type auditOutboxPayload struct {
	OrgID     string          `json:"orgId"`
	ActorID   *string         `json:"actorId"`
	Resource  string          `json:"resource"`
	Action    string          `json:"action"`
	Metadata  json.RawMessage `json:"metadata,omitempty"`
	IPAddress *string         `json:"ipAddress"`
	CreatedAt string          `json:"createdAt"`
}
