package newssourcescheduler

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/itemsingest"
)

// This file holds the MySQL port of the scheduler. Every query reproduces the
// Prisma statement the NestJS service issues, including the @updatedAt write,
// the status enums and the composite ordering. Business data is carried by the
// named types in model.go; only Prisma JSON columns cross the boundary as
// json.RawMessage.

// inFlightJob is the PipelineJob projection used by the in-flight capacity check.
type inFlightJob struct {
	ID        string
	Status    string
	CreatedAt time.Time
}

// pipelineJobRecord is the retry-latest projection.
type pipelineJobRecord struct {
	ID       string
	Status   string
	Metadata json.RawMessage
}

// crawlTaskRecord is the retry-latest crawl task projection.
type crawlTaskRecord struct {
	ID     string
	Status string
}

// latestJobSnapshot is the NewsSourceOpsSnapshot latestJob projection.
type latestJobSnapshot struct {
	ID          string
	Status      string
	URL         string
	CreatedAt   time.Time
	StartedAt   *time.Time
	CompletedAt *time.Time
	Error       *string
	Metadata    json.RawMessage
}

// latestArticleSnapshot is the latestArticle projection.
type latestArticleSnapshot struct {
	ID         string
	URL        string
	CrawlAt    time.Time
	TitleGuess *string
}

// latestCrawlTaskSnapshot is the latestCrawlTask projection.
type latestCrawlTaskSnapshot struct {
	ID            string
	Status        string
	LastError     *string
	LastRunAt     *time.Time
	LastSuccessAt *time.Time
	LastResultAt  *time.Time
}

// recentJobStat is one PipelineJob row of the 24h statistics.
type recentJobStat struct {
	Status      string
	StartedAt   *time.Time
	CompletedAt *time.Time
}

// dispatchPersist is the per-URL transaction input. The PipelineJob and the
// CrawlTask ids are pre-generated (O2), so the transaction is a single insert
// pair with metadata.crawlTaskId already in place.
type dispatchPersist struct {
	Source         *source
	URL            string
	URLFingerprint *string
	ScheduledFor   time.Time
	DisplayName    string
	Keywords       []string
	TaskConfig     json.RawMessage
	JobMetadata    json.RawMessage
	PipelineJobID  string
	CrawlTaskID    string
	CreatedByID    string
	Now            time.Time
}

// dispatchPersistResult is either a skip (a queued/running task already owns the
// URL) or the created ids.
type dispatchPersistResult struct {
	Skipped       bool
	PipelineJobID string
	CrawlTaskID   string
}

// rssSeedPersist is the RSS seed transaction input: PipelineJob + ItemMeta +
// raw_item outbox row, with the raw item id pre-generated.
type rssSeedPersist struct {
	Source         *source
	URL            string
	URLFingerprint *string
	Priority       int
	ScheduledFor   time.Time
	JobMetadata    json.RawMessage
	ItemMetaID     string
	ItemName       string
	ExternalID     string
	RawItemID      string
	PipelineJobID  string
	Payload        itemsingest.NormalizedNewsPayload
	BullPriority   int64
	Now            time.Time
}

// notificationInsert is one Notification row.
type notificationInsert struct {
	OrgID  string
	Title  string
	Body   string
	Data   json.RawMessage
	UserID *string
	Type   string
}

// repository is the MySQL port. A fake implements it in the unit tests.
type repository interface {
	// sources
	LoadSource(ctx context.Context, id string) (*source, error)
	FindDueSources(ctx context.Context, now time.Time, limit int) ([]*source, error)
	DelaySources(ctx context.Context, sourceIDs []string, now, rescheduleAt time.Time) (int, error)
	UpdateSourceRun(ctx context.Context, sourceID string, lastRunAt, nextRunAt time.Time, clearCircuit bool) error
	UpdateSourceManual(ctx context.Context, sourceID, orgID string, rescheduleAt time.Time) error
	UpdateSourceManualRun(ctx context.Context, sourceID, orgID string, lastRunAt, nextRunAt time.Time) error
	RescheduleSourceIfDue(ctx context.Context, sourceID string, now, rescheduleAt time.Time) error
	ResolveCrawlActor(ctx context.Context, orgID string) (*string, error)
	// dispatch transaction
	FindInFlightJobs(ctx context.Context, sourceID string, cutoff time.Time, limit int) ([]inFlightJob, error)
	PersistDispatch(ctx context.Context, input dispatchPersist) (dispatchPersistResult, error)
	MarkPipelineJobFailed(ctx context.Context, pipelineJobID, message string, completedAt time.Time) error
	MarkCrawlTaskQueued(ctx context.Context, crawlTaskID string, now time.Time) error
	MarkCrawlTaskFailed(ctx context.Context, crawlTaskID, message string, now time.Time) error
	// RSS seed path
	PersistRSSSeed(ctx context.Context, input rssSeedPersist) (outboxID string, err error)
	// ops
	LoadLatestPipelineJob(ctx context.Context, orgID, sourceID string) (*pipelineJobRecord, error)
	LoadCrawlTaskStatus(ctx context.Context, orgID, crawlTaskID string) (*string, error)
	ClearInFlightJobs(ctx context.Context, orgID, sourceID string, cutoff time.Time) (int, error)
	FindCrawlTaskIDs(ctx context.Context, orgID, sourceID string, ids []string) ([]string, error)
	FindArticleFingerprintsByFingerprint(ctx context.Context, orgID string, fingerprints []string, since time.Time) ([]fingerprintRecord, error)
	FindArticleFingerprintsByURL(ctx context.Context, orgID string, urls []string, since time.Time) ([]fingerprintRecord, error)
	FindActivePipelineFingerprintsByFingerprint(ctx context.Context, sourceID string, fingerprints []string, cutoff time.Time) ([]fingerprintRecord, error)
	FindActivePipelineFingerprintsByURL(ctx context.Context, sourceID string, urls []string, cutoff time.Time) ([]fingerprintRecord, error)
	PauseCrawlTasks(ctx context.Context, orgID string, taskIDs []string, message string, now time.Time) error
	SetPipelineJobQueued(ctx context.Context, pipelineJobID string, now time.Time) error
	UpdateSourceDeepFailure(ctx context.Context, sourceID string, failureAt, nextRunAt time.Time, circuitOpenUntil *time.Time) error
	SetPipelineJobFailedAfterRetry(ctx context.Context, pipelineJobID, message string, now time.Time) error
	// snapshots
	SyncQueueCounts(ctx context.Context, orgID, sourceID string) (queued, running int, err error)
	LatestJobForSnapshot(ctx context.Context, orgID, sourceID string) (*latestJobSnapshot, error)
	LatestArticleForSnapshot(ctx context.Context, orgID, sourceID string) (*latestArticleSnapshot, error)
	LatestCrawlTaskByID(ctx context.Context, orgID, crawlTaskID string) (*latestCrawlTaskSnapshot, error)
	LatestCrawlTaskForSource(ctx context.Context, orgID, sourceID string) (*latestCrawlTaskSnapshot, error)
	RecentJobStats(ctx context.Context, orgID, sourceID string, since time.Time) ([]recentJobStat, error)
	UpsertOpsSnapshot(ctx context.Context, orgID, sourceID string, latestJob, latestCrawlTask, latestArticle, stats24h json.RawMessage, now time.Time) error
	// notifications
	InsertNotification(ctx context.Context, input notificationInsert) (string, time.Time, error)
	// one-time legacy RSS seed cache TTL migration (rsseedttl.go). These read and
	// write NewsSource.config without an org predicate because the migration is
	// global, exactly like the NestJS prisma.newsSource.findMany scan.
	ListSourceConfigs(ctx context.Context) ([]sourceConfigRow, error)
	LoadSourceConfig(ctx context.Context, sourceID string) ([]byte, bool, error)
	ReplaceSourceConfigIfUnchanged(ctx context.Context, sourceID string, expected, next []byte, now time.Time) (int64, error)
}

// mysqlRepository is the production repository.
type mysqlRepository struct {
	db  *sql.DB
	now func() time.Time
	// writeOutbox is itemsingest.WriteRawItemOutboxTx. It is injected so the
	// raw_item envelope format keeps living in the items-ingest package.
	writeOutbox func(ctx context.Context, tx *sql.Tx, write itemsingest.OutboxWrite) (string, error)
}

func newMySQLRepository(db *sql.DB, writeOutbox func(ctx context.Context, tx *sql.Tx, write itemsingest.OutboxWrite) (string, error)) *mysqlRepository {
	return &mysqlRepository{db: db, now: time.Now, writeOutbox: writeOutbox}
}

// newID is a Prisma-cuid-shaped identifier ("c" + 24 hex characters), the same
// shape the other Go migrations write for client-generated cuid columns.
func newID() (string, error) {
	var buffer [12]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buffer[:]), nil
}

const sourceSelectColumns = "s.id, s.orgId, s.name, s.url, s.siteType, s.language, " +
	"s.crawlTemplateId, s.workflowId, s.workflowVersionId, s.workflowBindingMode, " +
	"s.frequencySeconds, s.priority, s.isActive, s.config, s.lastRunAt, s.nextRunAt, " +
	"s.updatedAt, t.id, t.isActive, t.crawlOptions"

const sourceFromClause = " FROM NewsSource s LEFT JOIN CrawlTemplate t ON t.id = s.crawlTemplateId "

func scanSourceRow(row interface{ Scan(dest ...any) error }) (*source, error) {
	var out source
	var active int
	var language, templateID, workflowID, workflowVersionID, templateRowID, templateOptions sql.NullString
	var templateActive sql.NullBool
	var config []byte
	var lastRunAt, nextRunAt sql.NullTime
	err := row.Scan(
		&out.ID, &out.OrgID, &out.Name, &out.URL, &out.SiteType, &language,
		&templateID, &workflowID, &workflowVersionID, &out.WorkflowBindingMode,
		&out.FrequencySeconds, &out.Priority, &active, &config, &lastRunAt, &nextRunAt,
		&out.UpdatedAt, &templateRowID, &templateActive, &templateOptions,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	out.IsActive = active != 0
	out.Config = append(json.RawMessage(nil), config...)
	out.Language = nullStringPtr(language)
	out.CrawlTemplateID = nullStringPtr(templateID)
	out.WorkflowID = nullStringPtr(workflowID)
	out.WorkflowVersionID = nullStringPtr(workflowVersionID)
	if lastRunAt.Valid {
		value := lastRunAt.Time
		out.LastRunAt = &value
	}
	if nextRunAt.Valid {
		value := nextRunAt.Time
		out.NextRunAt = &value
	}
	if templateRowID.Valid {
		out.CrawlTemplateActive = templateActive.Valid && templateActive.Bool
		if templateOptions.Valid {
			out.CrawlTemplateOptions = json.RawMessage(templateOptions.String)
		}
	}
	return &out, nil
}

func nullStringPtr(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	out := value.String
	return &out
}

func (r *mysqlRepository) LoadSource(ctx context.Context, id string) (*source, error) {
	row := r.db.QueryRowContext(ctx, "SELECT "+sourceSelectColumns+sourceFromClause+" WHERE s.id = ?", id)
	return scanSourceRow(row)
}

func (r *mysqlRepository) FindDueSources(ctx context.Context, now time.Time, limit int) ([]*source, error) {
	rows, err := r.db.QueryContext(ctx,
		"SELECT "+sourceSelectColumns+sourceFromClause+
			" WHERE s.isActive = 1"+
			" AND (s.nextRunAt IS NULL OR s.nextRunAt <= ?)"+
			" AND (s.circuitOpenUntil IS NULL OR s.circuitOpenUntil <= ?)"+
			" ORDER BY s.nextRunAt ASC, s.priority DESC, s.updatedAt ASC LIMIT ?",
		now, now, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]*source, 0, limit)
	for rows.Next() {
		item, err := scanSourceRow(rows)
		if err != nil {
			return nil, err
		}
		if item != nil {
			out = append(out, item)
		}
	}
	return out, rows.Err()
}

func (r *mysqlRepository) DelaySources(ctx context.Context, sourceIDs []string, now, rescheduleAt time.Time) (int, error) {
	if len(sourceIDs) == 0 {
		return 0, nil
	}
	placeholders := make([]string, len(sourceIDs))
	args := make([]any, 0, len(sourceIDs)+3)
	args = append(args, rescheduleAt, now)
	for index, id := range sourceIDs {
		placeholders[index] = "?"
		args = append(args, id)
	}
	args = append(args, now)
	result, err := r.db.ExecContext(ctx,
		"UPDATE NewsSource SET nextRunAt = ?, updatedAt = ? WHERE id IN ("+strings.Join(placeholders, ",")+")"+
			" AND (nextRunAt IS NULL OR nextRunAt <= ?)", args...)
	if err != nil {
		return 0, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	return int(affected), nil
}

func (r *mysqlRepository) UpdateSourceRun(ctx context.Context, sourceID string, lastRunAt, nextRunAt time.Time, clearCircuit bool) error {
	now := r.now().UTC().Truncate(time.Millisecond)
	if clearCircuit {
		_, err := r.db.ExecContext(ctx,
			"UPDATE NewsSource SET lastRunAt = ?, nextRunAt = ?, circuitOpenUntil = NULL, updatedAt = ? WHERE id = ?",
			lastRunAt, nextRunAt, now, sourceID)
		return err
	}
	_, err := r.db.ExecContext(ctx,
		"UPDATE NewsSource SET lastRunAt = ?, nextRunAt = ?, updatedAt = ? WHERE id = ?",
		lastRunAt, nextRunAt, now, sourceID)
	return err
}

func (r *mysqlRepository) UpdateSourceManual(ctx context.Context, sourceID, orgID string, rescheduleAt time.Time) error {
	now := r.now().UTC().Truncate(time.Millisecond)
	_, err := r.db.ExecContext(ctx,
		"UPDATE NewsSource SET isActive = 1, circuitOpenUntil = NULL, nextRunAt = ?, updatedAt = ? WHERE id = ? AND orgId = ?",
		rescheduleAt, now, sourceID, orgID)
	return err
}

func (r *mysqlRepository) UpdateSourceManualRun(ctx context.Context, sourceID, orgID string, lastRunAt, nextRunAt time.Time) error {
	now := r.now().UTC().Truncate(time.Millisecond)
	_, err := r.db.ExecContext(ctx,
		"UPDATE NewsSource SET isActive = 1, circuitOpenUntil = NULL, lastRunAt = ?, nextRunAt = ?, updatedAt = ? WHERE id = ? AND orgId = ?",
		lastRunAt, nextRunAt, now, sourceID, orgID)
	return err
}

func (r *mysqlRepository) RescheduleSourceIfDue(ctx context.Context, sourceID string, now, rescheduleAt time.Time) error {
	_, err := r.db.ExecContext(ctx,
		"UPDATE NewsSource SET nextRunAt = ?, updatedAt = ? WHERE id = ? AND (nextRunAt IS NULL OR nextRunAt <= ?)",
		rescheduleAt, r.now().UTC().Truncate(time.Millisecond), sourceID, now)
	return err
}

func (r *mysqlRepository) ResolveCrawlActor(ctx context.Context, orgID string) (*string, error) {
	var userID string
	err := r.db.QueryRowContext(ctx,
		"SELECT userId FROM Membership WHERE orgId = ? ORDER BY createdAt ASC LIMIT 1", orgID).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if userID == "" {
		return nil, nil
	}
	return &userID, nil
}

func (r *mysqlRepository) FindInFlightJobs(ctx context.Context, sourceID string, cutoff time.Time, limit int) ([]inFlightJob, error) {
	rows, err := r.db.QueryContext(ctx,
		"SELECT id, status, createdAt FROM PipelineJob WHERE sourceId = ?"+
			" AND status IN ('pending','queued','running','delayed')"+
			" AND createdAt >= ? ORDER BY createdAt DESC LIMIT ?", sourceID, cutoff, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]inFlightJob, 0, limit)
	for rows.Next() {
		var item inFlightJob
		if err := rows.Scan(&item.ID, &item.Status, &item.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (r *mysqlRepository) PersistDispatch(ctx context.Context, input dispatchPersist) (dispatchPersistResult, error) {
	var result dispatchPersistResult
	err := withTransaction(ctx, r.db, func(tx *sql.Tx) error {
		var existingID string
		var existingStatus string
		lookupErr := tx.QueryRowContext(ctx,
			"SELECT id, status FROM CrawlTask WHERE orgId = ? AND newsSourceId = ? AND targetUrl = ? LIMIT 1",
			input.Source.OrgID, input.Source.ID, input.URL).Scan(&existingID, &existingStatus)
		if lookupErr != nil && !errors.Is(lookupErr, sql.ErrNoRows) {
			return lookupErr
		}
		existingFound := lookupErr == nil
		if existingFound && (existingStatus == "queued" || existingStatus == "running") {
			result = dispatchPersistResult{Skipped: true}
			return nil
		}

		if _, err := tx.ExecContext(ctx,
			"INSERT INTO PipelineJob (id, orgId, sourceId, url, urlFingerprint, priority, status, queueName, scheduledFor, metadata, createdAt, updatedAt)"+
				" VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)",
			input.PipelineJobID, input.Source.OrgID, input.Source.ID, input.URL,
			nullableStringValue(input.URLFingerprint), input.Source.Priority, defaultItemQueueName,
			input.ScheduledFor, string(input.JobMetadata), input.Now, input.Now); err != nil {
			return err
		}

		if existingFound && existingID != "" {
			if _, err := tx.ExecContext(ctx,
				"UPDATE CrawlTask SET newsSourceId = ?, displayName = ?, status = 'pending', concurrency = 1,"+
					" keywords = ?, config = ?, lastError = NULL, updatedAt = ? WHERE id = ?",
				input.Source.ID, input.DisplayName, string(mustJSON(input.Keywords)),
				string(input.TaskConfig), input.Now, existingID); err != nil {
				return err
			}
			result = dispatchPersistResult{PipelineJobID: input.PipelineJobID, CrawlTaskID: existingID}
			return nil
		}

		if _, err := tx.ExecContext(ctx,
			"INSERT INTO CrawlTask (id, orgId, createdById, newsSourceId, targetUrl, displayName, status, concurrency, keywords, config, createdAt, updatedAt)"+
				" VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?)",
			input.CrawlTaskID, input.Source.OrgID, input.CreatedByID, input.Source.ID, input.URL,
			input.DisplayName, string(mustJSON(input.Keywords)), string(input.TaskConfig),
			input.Now, input.Now); err != nil {
			return err
		}
		result = dispatchPersistResult{PipelineJobID: input.PipelineJobID, CrawlTaskID: input.CrawlTaskID}
		return nil
	})
	return result, err
}

func (r *mysqlRepository) MarkPipelineJobFailed(ctx context.Context, pipelineJobID, message string, completedAt time.Time) error {
	_, err := r.db.ExecContext(ctx,
		"UPDATE PipelineJob SET status = 'failed', error = ?, completedAt = ?, updatedAt = ? WHERE id = ?",
		message, completedAt, r.now().UTC().Truncate(time.Millisecond), pipelineJobID)
	return err
}

func (r *mysqlRepository) MarkCrawlTaskQueued(ctx context.Context, crawlTaskID string, now time.Time) error {
	_, err := r.db.ExecContext(ctx,
		"UPDATE CrawlTask SET status = 'queued', updatedAt = ? WHERE id = ? AND status = 'pending'",
		now, crawlTaskID)
	return err
}

func (r *mysqlRepository) MarkCrawlTaskFailed(ctx context.Context, crawlTaskID, message string, now time.Time) error {
	_, err := r.db.ExecContext(ctx,
		"UPDATE CrawlTask SET status = 'failed', lastError = ?, updatedAt = ? WHERE id = ?",
		message, now, crawlTaskID)
	return err
}

func (r *mysqlRepository) PersistRSSSeed(ctx context.Context, input rssSeedPersist) (string, error) {
	var outboxID string
	var err error
	err = withTransaction(ctx, r.db, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO PipelineJob (id, orgId, sourceId, url, urlFingerprint, priority, status, queueName, scheduledFor, metadata, createdAt, updatedAt)"+
				" VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)",
			input.PipelineJobID, input.Source.OrgID, input.Source.ID, input.URL,
			nullableStringValue(input.URLFingerprint), input.Priority, defaultItemQueueName,
			input.ScheduledFor, string(input.JobMetadata), input.Now, input.Now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO ItemMeta (id, orgId, externalId, name, status, mongoRef, version, sortAt, createdAt, updatedAt)"+
				" VALUES (?, ?, ?, ?, 'pending', ?, 1, ?, ?, ?)",
			input.ItemMetaID, input.Source.OrgID, input.ExternalID, input.ItemName,
			input.RawItemID, input.Now, input.Now, input.Now); err != nil {
			return err
		}
		priority := input.BullPriority
		pipelineJobID := input.PipelineJobID
		sourceID := input.Source.ID
		outboxID, err = r.writeOutbox(ctx, tx, itemsingest.OutboxWrite{
			OrgID:         input.Source.OrgID,
			ItemMetaID:    input.ItemMetaID,
			RawItemID:     input.RawItemID,
			Source:        "news-source-rss",
			Payload:       input.Payload,
			PipelineJobID: &pipelineJobID,
			SourceID:      &sourceID,
			Priority:      &priority,
		})
		return err
	})
	return outboxID, err
}

func (r *mysqlRepository) LoadLatestPipelineJob(ctx context.Context, orgID, sourceID string) (*pipelineJobRecord, error) {
	var record pipelineJobRecord
	var metadata []byte
	err := r.db.QueryRowContext(ctx,
		"SELECT id, status, metadata FROM PipelineJob WHERE orgId = ? AND sourceId = ? ORDER BY createdAt DESC LIMIT 1",
		orgID, sourceID).Scan(&record.ID, &record.Status, &metadata)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record.Metadata = append(json.RawMessage(nil), metadata...)
	return &record, nil
}

func (r *mysqlRepository) LoadCrawlTaskStatus(ctx context.Context, orgID, crawlTaskID string) (*string, error) {
	var status string
	err := r.db.QueryRowContext(ctx,
		"SELECT status FROM CrawlTask WHERE orgId = ? AND id = ? LIMIT 1", orgID, crawlTaskID).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &status, nil
}

func (r *mysqlRepository) ClearInFlightJobs(ctx context.Context, orgID, sourceID string, cutoff time.Time) (int, error) {
	now := r.now().UTC().Truncate(time.Millisecond)
	result, err := r.db.ExecContext(ctx,
		"UPDATE PipelineJob SET status = 'failed', error = 'Cleared by admin', completedAt = ?, updatedAt = ?"+
			" WHERE orgId = ? AND sourceId = ? AND status IN ('pending','queued','running','delayed') AND createdAt >= ?",
		now, now, orgID, sourceID, cutoff)
	if err != nil {
		return 0, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	return int(affected), nil
}

func (r *mysqlRepository) FindCrawlTaskIDs(ctx context.Context, orgID, sourceID string, ids []string) ([]string, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	placeholders := make([]string, len(ids))
	args := make([]any, 0, len(ids)+2)
	args = append(args, orgID)
	for index, id := range ids {
		placeholders[index] = "?"
		args = append(args, id)
	}
	args = append(args, sourceID)
	rows, err := r.db.QueryContext(ctx,
		"SELECT id FROM CrawlTask WHERE orgId = ? AND id IN ("+strings.Join(placeholders, ",")+") AND newsSourceId = ?",
		args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// fingerprintQuery runs one indexed fingerprint/url lookup and scans the two
// projected columns.
func (r *mysqlRepository) fingerprintQuery(ctx context.Context, query string, args ...any) ([]fingerprintRecord, error) {
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []fingerprintRecord{}
	for rows.Next() {
		var fingerprint sql.NullString
		var url string
		if err := rows.Scan(&fingerprint, &url); err != nil {
			return nil, err
		}
		record := fingerprintRecord{URL: url}
		if fingerprint.Valid && fingerprint.String != "" {
			value := fingerprint.String
			record.URLFingerprint = &value
		}
		out = append(out, record)
	}
	return out, rows.Err()
}

// placeholders returns n "?" markers and the matching args.
func inClause(values []string) (string, []any) {
	placeholders := make([]string, len(values))
	args := make([]any, len(values))
	for index, value := range values {
		placeholders[index] = "?"
		args[index] = value
	}
	return strings.Join(placeholders, ","), args
}

func (r *mysqlRepository) FindArticleFingerprintsByFingerprint(ctx context.Context, orgID string, fingerprints []string, since time.Time) ([]fingerprintRecord, error) {
	if len(fingerprints) == 0 {
		return nil, nil
	}
	clause, args := inClause(fingerprints)
	query := "SELECT urlFingerprint, url FROM Article WHERE orgId = ? AND crawlAt >= ? AND urlFingerprint IN (" + clause + ")"
	return r.fingerprintQuery(ctx, query, append([]any{orgID, since}, args...)...)
}

func (r *mysqlRepository) FindArticleFingerprintsByURL(ctx context.Context, orgID string, urls []string, since time.Time) ([]fingerprintRecord, error) {
	if len(urls) == 0 {
		return nil, nil
	}
	clause, args := inClause(urls)
	query := "SELECT urlFingerprint, url FROM Article WHERE orgId = ? AND crawlAt >= ? AND url IN (" + clause + ")"
	return r.fingerprintQuery(ctx, query, append([]any{orgID, since}, args...)...)
}

func (r *mysqlRepository) FindActivePipelineFingerprintsByFingerprint(ctx context.Context, sourceID string, fingerprints []string, cutoff time.Time) ([]fingerprintRecord, error) {
	if len(fingerprints) == 0 {
		return nil, nil
	}
	clause, args := inClause(fingerprints)
	query := "SELECT urlFingerprint, url FROM PipelineJob WHERE sourceId = ?" +
		" AND status IN ('pending','queued','running','delayed') AND createdAt >= ?" +
		" AND urlFingerprint IN (" + clause + ")"
	return r.fingerprintQuery(ctx, query, append([]any{sourceID, cutoff}, args...)...)
}

func (r *mysqlRepository) FindActivePipelineFingerprintsByURL(ctx context.Context, sourceID string, urls []string, cutoff time.Time) ([]fingerprintRecord, error) {
	if len(urls) == 0 {
		return nil, nil
	}
	clause, args := inClause(urls)
	query := "SELECT urlFingerprint, url FROM PipelineJob WHERE sourceId = ?" +
		" AND status IN ('pending','queued','running','delayed') AND createdAt >= ?" +
		" AND url IN (" + clause + ")"
	return r.fingerprintQuery(ctx, query, append([]any{sourceID, cutoff}, args...)...)
}

func (r *mysqlRepository) PauseCrawlTasks(ctx context.Context, orgID string, taskIDs []string, message string, now time.Time) error {
	if len(taskIDs) == 0 {
		return nil
	}
	placeholders := make([]string, len(taskIDs))
	args := make([]any, 0, len(taskIDs)+3)
	args = append(args, "paused", message, now)
	for index, id := range taskIDs {
		placeholders[index] = "?"
		args = append(args, id)
	}
	args = append(args, orgID)
	_, err := r.db.ExecContext(ctx,
		"UPDATE CrawlTask SET status = ?, lastError = ?, updatedAt = ? WHERE id IN ("+strings.Join(placeholders, ",")+") AND orgId = ?",
		args...)
	return err
}

func (r *mysqlRepository) UpdateSourceDeepFailure(ctx context.Context, sourceID string, failureAt, nextRunAt time.Time, circuitOpenUntil *time.Time) error {
	now := r.now().UTC().Truncate(time.Millisecond)
	_, err := r.db.ExecContext(ctx,
		"UPDATE NewsSource SET lastFailureAt = ?, nextRunAt = ?, circuitOpenUntil = ?, updatedAt = ? WHERE id = ? AND isActive = 1",
		failureAt, nextRunAt, nullableTimeValue(circuitOpenUntil), now, sourceID)
	return err
}

func (r *mysqlRepository) SetPipelineJobQueued(ctx context.Context, pipelineJobID string, now time.Time) error {
	_, err := r.db.ExecContext(ctx,
		"UPDATE PipelineJob SET status = 'queued', startedAt = NULL, completedAt = NULL, error = NULL, updatedAt = ? WHERE id = ?",
		now, pipelineJobID)
	return err
}

func (r *mysqlRepository) SetPipelineJobFailedAfterRetry(ctx context.Context, pipelineJobID, message string, now time.Time) error {
	_, err := r.db.ExecContext(ctx,
		"UPDATE PipelineJob SET status = 'failed', error = ?, completedAt = ?, updatedAt = ? WHERE id = ?",
		message, now, now, pipelineJobID)
	return err
}

func (r *mysqlRepository) SyncQueueCounts(ctx context.Context, orgID, sourceID string) (int, int, error) {
	rows, err := r.db.QueryContext(ctx,
		"SELECT status, COUNT(*) FROM CrawlTask WHERE orgId = ? AND newsSourceId = ? AND status IN ('queued','running') GROUP BY status",
		orgID, sourceID)
	if err != nil {
		return 0, 0, err
	}
	defer rows.Close()
	queued := 0
	running := 0
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			return 0, 0, err
		}
		switch status {
		case "queued":
			queued = count
		case "running":
			running = count
		}
	}
	return queued, running, rows.Err()
}

func (r *mysqlRepository) LatestJobForSnapshot(ctx context.Context, orgID, sourceID string) (*latestJobSnapshot, error) {
	var record latestJobSnapshot
	var startedAt, completedAt sql.NullTime
	var message sql.NullString
	var metadata []byte
	err := r.db.QueryRowContext(ctx,
		"SELECT id, status, url, createdAt, startedAt, completedAt, error, metadata FROM PipelineJob"+
			" WHERE orgId = ? AND sourceId = ? ORDER BY createdAt DESC, id DESC LIMIT 1",
		orgID, sourceID).Scan(&record.ID, &record.Status, &record.URL, &record.CreatedAt,
		&startedAt, &completedAt, &message, &metadata)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if startedAt.Valid {
		value := startedAt.Time
		record.StartedAt = &value
	}
	if completedAt.Valid {
		value := completedAt.Time
		record.CompletedAt = &value
	}
	if message.Valid {
		value := message.String
		record.Error = &value
	}
	record.Metadata = append(json.RawMessage(nil), metadata...)
	return &record, nil
}

func (r *mysqlRepository) LatestArticleForSnapshot(ctx context.Context, orgID, sourceID string) (*latestArticleSnapshot, error) {
	var record latestArticleSnapshot
	var title sql.NullString
	err := r.db.QueryRowContext(ctx,
		"SELECT id, url, crawlAt, titleGuess FROM Article WHERE orgId = ? AND sourceId = ? ORDER BY crawlAt DESC, id DESC LIMIT 1",
		orgID, sourceID).Scan(&record.ID, &record.URL, &record.CrawlAt, &title)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if title.Valid {
		value := title.String
		record.TitleGuess = &value
	}
	return &record, nil
}

const latestCrawlTaskColumns = "id, status, lastError, lastRunAt, lastSuccessAt, lastResultAt"

func scanLatestCrawlTask(row interface{ Scan(dest ...any) error }) (*latestCrawlTaskSnapshot, error) {
	var record latestCrawlTaskSnapshot
	var message sql.NullString
	var lastRunAt, lastSuccessAt, lastResultAt sql.NullTime
	err := row.Scan(&record.ID, &record.Status, &message, &lastRunAt, &lastSuccessAt, &lastResultAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if message.Valid {
		value := message.String
		record.LastError = &value
	}
	if lastRunAt.Valid {
		value := lastRunAt.Time
		record.LastRunAt = &value
	}
	if lastSuccessAt.Valid {
		value := lastSuccessAt.Time
		record.LastSuccessAt = &value
	}
	if lastResultAt.Valid {
		value := lastResultAt.Time
		record.LastResultAt = &value
	}
	return &record, nil
}

func (r *mysqlRepository) LatestCrawlTaskByID(ctx context.Context, orgID, crawlTaskID string) (*latestCrawlTaskSnapshot, error) {
	row := r.db.QueryRowContext(ctx,
		"SELECT "+latestCrawlTaskColumns+" FROM CrawlTask WHERE id = ? AND orgId = ? LIMIT 1", crawlTaskID, orgID)
	return scanLatestCrawlTask(row)
}

func (r *mysqlRepository) LatestCrawlTaskForSource(ctx context.Context, orgID, sourceID string) (*latestCrawlTaskSnapshot, error) {
	row := r.db.QueryRowContext(ctx,
		"SELECT "+latestCrawlTaskColumns+" FROM CrawlTask WHERE orgId = ? AND newsSourceId = ?"+
			" ORDER BY updatedAt DESC, id DESC LIMIT 1", orgID, sourceID)
	return scanLatestCrawlTask(row)
}

func (r *mysqlRepository) RecentJobStats(ctx context.Context, orgID, sourceID string, since time.Time) ([]recentJobStat, error) {
	rows, err := r.db.QueryContext(ctx,
		"SELECT status, startedAt, completedAt FROM PipelineJob WHERE orgId = ? AND sourceId = ? AND createdAt >= ?",
		orgID, sourceID, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []recentJobStat{}
	for rows.Next() {
		var item recentJobStat
		var startedAt, completedAt sql.NullTime
		if err := rows.Scan(&item.Status, &startedAt, &completedAt); err != nil {
			return nil, err
		}
		if startedAt.Valid {
			value := startedAt.Time
			item.StartedAt = &value
		}
		if completedAt.Valid {
			value := completedAt.Time
			item.CompletedAt = &value
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (r *mysqlRepository) UpsertOpsSnapshot(ctx context.Context, orgID, sourceID string, latestJob, latestCrawlTask, latestArticle, stats24h json.RawMessage, now time.Time) error {
	snapshotID, err := newID()
	if err != nil {
		return err
	}
	_, err = r.db.ExecContext(ctx,
		"INSERT INTO NewsSourceOpsSnapshot (id, orgId, sourceId, latestJob, latestCrawlTask, latestArticle, stats24h, createdAt, updatedAt)"+
			" VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"+
			" ON DUPLICATE KEY UPDATE orgId = VALUES(orgId), latestJob = VALUES(latestJob),"+
			" latestCrawlTask = VALUES(latestCrawlTask), latestArticle = VALUES(latestArticle),"+
			" stats24h = VALUES(stats24h), updatedAt = VALUES(updatedAt)",
		snapshotID, orgID, sourceID,
		nullableJSON(latestJob), nullableJSON(latestCrawlTask), nullableJSON(latestArticle),
		nullableJSON(stats24h), now, now)
	return err
}

func (r *mysqlRepository) InsertNotification(ctx context.Context, input notificationInsert) (string, time.Time, error) {
	id, err := newID()
	if err != nil {
		return "", time.Time{}, err
	}
	now := r.now().UTC().Truncate(time.Millisecond)
	_, err = r.db.ExecContext(ctx,
		"INSERT INTO Notification (id, orgId, userId, type, title, body, data, createdAt, updatedAt)"+
			" VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		id, input.OrgID, nullableStringValue(input.UserID), input.Type, input.Title,
		nullableString(input.Body), nullableJSON(input.Data), now, now)
	if err != nil {
		return "", time.Time{}, err
	}
	return id, now, nil
}

// ListSourceConfigs is prisma.newsSource.findMany({select:{id,config}}): every
// source of every organization, unordered like the Prisma statement.
func (r *mysqlRepository) ListSourceConfigs(ctx context.Context) ([]sourceConfigRow, error) {
	rows, err := r.db.QueryContext(ctx, "SELECT id, config FROM NewsSource")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]sourceConfigRow, 0, 64)
	for rows.Next() {
		var row sourceConfigRow
		if err := rows.Scan(&row.ID, &row.Config); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// LoadSourceConfig re-reads one config after a lost optimistic update.
func (r *mysqlRepository) LoadSourceConfig(ctx context.Context, sourceID string) ([]byte, bool, error) {
	var config []byte
	err := r.db.QueryRowContext(ctx, "SELECT config FROM NewsSource WHERE id = ?", sourceID).Scan(&config)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return append([]byte(nil), config...), true, nil
}

// ReplaceSourceConfigIfUnchanged is prisma.newsSource.updateMany({where:{id,
// config:{equals: expected}}, data:{config, updatedAt}}). The CAST keeps the
// comparison structural (MySQL compares JSON objects key-order independently),
// so a concurrent edit that only reorders keys still counts as a lost race.
func (r *mysqlRepository) ReplaceSourceConfigIfUnchanged(ctx context.Context, sourceID string, expected, next []byte, now time.Time) (int64, error) {
	result, err := r.db.ExecContext(ctx,
		"UPDATE NewsSource SET config = CAST(? AS JSON), updatedAt = ? WHERE id = ? AND config = CAST(? AS JSON)",
		string(next), now.UTC().Truncate(time.Millisecond), sourceID, string(expected))
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// withTransaction runs fn inside a transaction, rolling back on error.
func withTransaction(ctx context.Context, db *sql.DB, fn func(tx *sql.Tx) error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nullableStringValue(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableTimeValue(value *time.Time) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableJSON(value json.RawMessage) any {
	trimmed := strings.TrimSpace(string(value))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	return trimmed
}

// mustJSON marshals a value that cannot fail for the supported inputs.
func mustJSON(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage("null")
	}
	return encoded
}
