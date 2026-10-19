package kgingestion

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/knowledgereview"
)

// defaultBackfillDays is DEFAULT_BACKFILL_DAYS: the first run starts thirty
// days before the current wall clock.
const defaultBackfillDays = 30

// Cursor is the ingestion cursor of one organization. HasCursor is false when
// KnowledgeGraphIngestionState.lastProcessedAt is NULL, which selects the
// thirty-day backfill window instead of the keyset predicate.
type Cursor struct {
	HasCursor              bool
	LastProcessedAt        time.Time
	LastProcessedArticleID string
}

// ProcessedArticle is the narrow projection the ingestion needs. Entities and
// KGRelations are the JSON leaves produced by the NestJS news pipeline; the
// ingestion only reads them.
type ProcessedArticle struct {
	ArticleID        string
	ProcessedAt      time.Time
	Title            *string
	Summary          *string
	Language         *string
	Entities         json.RawMessage
	KGRelations      json.RawMessage
	LLMPromptVersion *string
}

// Store owns the ingestion MySQL reads and writes. It does not close the shared
// pool.
type Store struct {
	db  *sql.DB
	now func() time.Time
}

// NewStore builds the ingestion store on the shared MySQL pool.
func NewStore(db *sql.DB, now func() time.Time) *Store {
	if now == nil {
		now = time.Now
	}
	return &Store{db: db, now: now}
}

func (s *Store) clock() time.Time {
	if s != nil && s.now != nil {
		return s.now()
	}
	return time.Now()
}

func (s *Store) timestamp() time.Time {
	return s.clock().UTC().Truncate(time.Millisecond)
}

// ListActiveOrgIDs reproduces ActiveOrgRegistryService.loadActiveOrgs: every
// active organization ordered by id ascending.
func (s *Store) ListActiveOrgIDs(ctx context.Context) ([]string, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("kgingestion: mysql is not configured")
	}
	rows, err := s.db.QueryContext(ctx, "SELECT `id` FROM `Org` WHERE `isActive` = true ORDER BY `id` ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}

// LoadCursor reads or creates KnowledgeGraphIngestionState for one organization.
// The organization lock serializes the create path, and the insert is
// additionally idempotent so a stale lock cannot leave two state rows.
func (s *Store) LoadCursor(ctx context.Context, orgID string) (Cursor, error) {
	if s == nil || s.db == nil {
		return Cursor{}, errors.New("kgingestion: mysql is not configured")
	}
	cursor, found, err := s.selectCursor(ctx, orgID)
	if err != nil || found {
		return cursor, err
	}

	rowID, err := knowledgereview.NewRowID()
	if err != nil {
		return Cursor{}, err
	}
	now := s.timestamp()
	if _, err := s.db.ExecContext(ctx,
		"INSERT IGNORE INTO `KnowledgeGraphIngestionState` (`id`, `orgId`, `createdAt`, `updatedAt`) VALUES (?, ?, ?, ?)",
		rowID, orgID, now, now,
	); err != nil {
		return Cursor{}, err
	}
	cursor, found, err = s.selectCursor(ctx, orgID)
	if err != nil {
		return Cursor{}, err
	}
	if !found {
		return Cursor{}, errors.New("kgingestion: failed to create ingestion state")
	}
	return cursor, nil
}

func (s *Store) selectCursor(ctx context.Context, orgID string) (Cursor, bool, error) {
	var (
		processedAt sql.NullTime
		articleID   sql.NullString
	)
	err := s.db.QueryRowContext(ctx,
		"SELECT `lastProcessedAt`, `lastProcessedArticleId` FROM `KnowledgeGraphIngestionState` WHERE `orgId` = ? LIMIT 1",
		orgID,
	).Scan(&processedAt, &articleID)
	if errors.Is(err, sql.ErrNoRows) {
		return Cursor{}, false, nil
	}
	if err != nil {
		return Cursor{}, false, err
	}
	cursor := Cursor{}
	if processedAt.Valid {
		cursor.HasCursor = true
		cursor.LastProcessedAt = processedAt.Time
		cursor.LastProcessedArticleID = articleID.String
	}
	return cursor, true, nil
}

// ListProcessedArticles reproduces the ingestion batch query: completed
// ProcessedArticle rows for the organization, keyset-paginated on
// (processedAt, articleId) when a cursor exists, otherwise limited to the
// thirty-day backfill window. Both orderings are ascending so a batch always
// resumes where the previous one stopped.
func (s *Store) ListProcessedArticles(ctx context.Context, orgID string, cursor *Cursor, limit int) ([]ProcessedArticle, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("kgingestion: mysql is not configured")
	}
	if limit <= 0 {
		return []ProcessedArticle{}, nil
	}

	var builder strings.Builder
	builder.WriteString("SELECT `articleId`, `processedAt`, `title`, `summary`, `language`, `entities`, `kgRelations`, `llmPromptVersion` ")
	builder.WriteString("FROM `ProcessedArticle` WHERE `status` = 'completed' AND `orgId` = ?")
	args := []any{orgID}
	if cursor != nil && cursor.HasCursor {
		builder.WriteString(" AND (`processedAt` > ? OR (`processedAt` = ? AND `articleId` > ?))")
		args = append(args, cursor.LastProcessedAt, cursor.LastProcessedAt, cursor.LastProcessedArticleID)
	} else {
		since := s.clock().UTC().Add(-defaultBackfillDays * 24 * time.Hour)
		builder.WriteString(" AND `processedAt` >= ?")
		args = append(args, since)
	}
	builder.WriteString(" ORDER BY `processedAt` ASC, `articleId` ASC LIMIT ?")
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, builder.String(), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	articles := make([]ProcessedArticle, 0, limit)
	for rows.Next() {
		var (
			article   ProcessedArticle
			title     sql.NullString
			summary   sql.NullString
			language  sql.NullString
			version   sql.NullString
			entities  []byte
			relations []byte
		)
		if err := rows.Scan(&article.ArticleID, &article.ProcessedAt, &title, &summary, &language,
			&entities, &relations, &version); err != nil {
			return nil, err
		}
		article.Title = nullStringPointer(title)
		article.Summary = nullStringPointer(summary)
		article.Language = nullStringPointer(language)
		article.LLMPromptVersion = nullStringPointer(version)
		article.Entities = json.RawMessage(entities)
		article.KGRelations = json.RawMessage(relations)
		articles = append(articles, article)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return articles, nil
}

// AdvanceCursor moves the organization cursor to the processed article.
func (s *Store) AdvanceCursor(ctx context.Context, orgID string, processedAt time.Time, articleID string) error {
	if s == nil || s.db == nil {
		return errors.New("kgingestion: mysql is not configured")
	}
	_, err := s.db.ExecContext(ctx,
		"UPDATE `KnowledgeGraphIngestionState` SET `lastProcessedAt` = ?, `lastProcessedArticleId` = ?, `updatedAt` = ? WHERE `orgId` = ?",
		processedAt.UTC().Truncate(time.Millisecond), articleID, s.timestamp(), orgID,
	)
	return err
}

func nullStringPointer(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	copied := value.String
	return &copied
}
