package settingscrawl

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/knowledgegraph"
)

// evidenceReviewStatusDocument is the review sub-document of the evidence JSON
// payload. Only review.status is read by the queue filter.
type evidenceReviewStatusDocument struct {
	Status json.RawMessage `json:"status"`
}

// evidenceDocument is the evidence JSON payload read by the queue filter.
type evidenceDocument struct {
	Review evidenceReviewStatusDocument `json:"review"`
}

// reviewReader serves the knowledge-graph evidence review queue root.
type reviewReader struct {
	s *store
	// settings is the shared knowledge-graph settings reader. The queue uses
	// its reviewPort (defined in review_support.go) so it reads the same
	// Redis -> MySQL document the review mutation reads, instead of going
	// straight to the database and disagreeing with the 60s settings cache.
	settings *settingsReader
}

// settingsView reads the shared review settings view through the narrow port in
// review_support.go.
func (r *reviewReader) settingsView(ctx context.Context, orgID string) knowledgegraph.ReviewSettingsView {
	port := r.settings.reviewPort()
	return port.Read(ctx, orgID)
}

// isReviewedEvidence reproduces readReviewStatus plus the asRecord guards: a row
// counts as reviewed only when evidence is a JSON object whose review is a JSON
// object whose status is a string that trims to one of the three verdict
// literals. Everything else is unreviewed.
func isReviewedEvidence(raw []byte) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return false
	}
	var document evidenceDocument
	if err := json.Unmarshal(trimmed, &document); err != nil {
		return false
	}
	status, ok := settingString(document.Review.Status)
	if !ok {
		return false
	}
	switch evidenceReviewStatus(strings.TrimSpace(status)) {
	case evidenceReviewStatusApproved, evidenceReviewStatusRejected, evidenceReviewStatusCorrected:
		return true
	default:
		return false
	}
}

// reviewQueuePageSize is the size of one scan page, never a total cap. The old
// implementation treated it as the maximum number of candidates to look at,
// which hid the pending rows behind a long prefix of already reviewed rows.
func reviewQueuePageSize(limit int) int {
	page := 50
	if limit*4 > page {
		page = limit * 4
	}
	if page > 500 {
		page = 500
	}
	return page
}

// reviewQueueCursor is the (createdAt DESC, id DESC) keyset position. id breaks
// the tie between evidences created in the same millisecond, which the old
// single-page query left to the storage engine.
type reviewQueueCursor struct {
	createdAt time.Time
	id        string
}

// reviewCandidate is one light scan row: only the cursor columns and the
// evidence JSON the reviewed filter needs, never the joined article or entity
// projection.
type reviewCandidate struct {
	id        string
	createdAt time.Time
	evidence  []byte
}

// reviewCandidatePage loads one page of scan rows strictly after cursor.
type reviewCandidatePage func(ctx context.Context, cursor *reviewQueueCursor, pageSize int) ([]reviewCandidate, error)

// selectReviewCandidateIDs walks the keyset pages until it has selected limit
// unreviewed candidates or the source is exhausted. The cursor advances for
// every scanned row, so a page full of reviewed rows never stalls the walk and
// the scan is not capped by a fixed overfetch.
func selectReviewCandidateIDs(
	ctx context.Context,
	fetch reviewCandidatePage,
	limit int,
	onlyUnreviewed bool,
	pageSize int,
) ([]string, error) {
	selected := make([]string, 0, limit)
	var cursor *reviewQueueCursor
	for len(selected) < limit {
		page, err := fetch(ctx, cursor, pageSize)
		if err != nil {
			return nil, err
		}
		if len(page) == 0 {
			break
		}
		for _, row := range page {
			row := row
			cursor = &reviewQueueCursor{createdAt: row.createdAt, id: row.id}
			if onlyUnreviewed && isReviewedEvidence(row.evidence) {
				continue
			}
			selected = append(selected, row.id)
			if len(selected) >= limit {
				break
			}
		}
	}
	return selected, nil
}

// evidenceReviewQueue reproduces KnowledgeGraphReviewResolver's queue root.
//
// The query adds an orgId predicate to every joined relation. Foreign keys only
// bind primary keys, so without those predicates a historical dirty row could
// pull another organization's entity names, edge properties and article
// titles into this organization's queue. ProcessedArticle is LEFT joined with
// its orgId predicate in the ON clause so an article without a processed row
// still falls back to the Article title guess instead of being dropped.
//
// Selection is a light keyset scan; the joined projection is loaded once for
// the selected ids only, so skipped reviewed rows never materialize an article
// or an entity.
func (r *reviewReader) evidenceReviewQueue(
	ctx context.Context,
	identity contract.Identity,
	limitArg *int,
	maxConfidenceArg *float64,
	onlyUnreviewedArg *bool,
) ([]KnowledgeGraphEvidenceReviewItemModel, error) {
	settings := r.settingsView(ctx, identity.OrgID)
	if !settings.Enabled {
		return []KnowledgeGraphEvidenceReviewItemModel{}, nil
	}

	limit := 50
	if limitArg != nil {
		limit = *limitArg
	}
	limit = clampIntRounded(float64(limit), 1, 200)

	maxConfidence := settings.MinEdgeConfidence
	if maxConfidenceArg != nil {
		maxConfidence = *maxConfidenceArg
	}
	onlyUnreviewed := true
	if onlyUnreviewedArg != nil {
		onlyUnreviewed = *onlyUnreviewedArg
	}

	ids, err := selectReviewCandidateIDs(ctx, func(ctx context.Context, cursor *reviewQueueCursor, pageSize int) ([]reviewCandidate, error) {
		return r.scanReviewCandidates(ctx, identity.OrgID, maxConfidence, cursor, pageSize)
	}, limit, onlyUnreviewed, reviewQueuePageSize(limit))
	if err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return []KnowledgeGraphEvidenceReviewItemModel{}, nil
	}
	return r.projectReviewItems(ctx, identity.OrgID, ids)
}

// scanReviewCandidates reads one org-scoped page of light rows ordered by
// (createdAt DESC, id DESC). The joins only prove the row is still reachable
// inside the organization; their columns are never projected here.
func (r *reviewReader) scanReviewCandidates(
	ctx context.Context,
	orgID string,
	maxConfidence float64,
	cursor *reviewQueueCursor,
	pageSize int,
) ([]reviewCandidate, error) {
	query := "SELECT e.`id`, e.`createdAt`, e.`evidence` " +
		"FROM `KnowledgeEdgeEvidence` e " +
		"INNER JOIN `KnowledgeEdge` ed ON ed.`id` = e.`edgeId` AND ed.`orgId` = e.`orgId` " +
		"INNER JOIN `KnowledgeEntity` fe ON fe.`id` = ed.`fromEntityId` AND fe.`orgId` = e.`orgId` " +
		"INNER JOIN `KnowledgeEntity` te ON te.`id` = ed.`toEntityId` AND te.`orgId` = e.`orgId` " +
		"INNER JOIN `Article` a ON a.`id` = e.`articleId` AND a.`orgId` = e.`orgId` " +
		"WHERE e.`orgId` = ? AND (e.`confidence` IS NOT NULL AND e.`confidence` <= ?)"

	args := []any{orgID, maxConfidence}
	if cursor != nil {
		query += " AND (e.`createdAt` < ? OR (e.`createdAt` = ? AND e.`id` < ?))"
		args = append(args, cursor.createdAt, cursor.createdAt, cursor.id)
	}
	query += " ORDER BY e.`createdAt` DESC, e.`id` DESC LIMIT ?"
	args = append(args, pageSize)

	rows, err := r.s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	page := make([]reviewCandidate, 0, pageSize)
	for rows.Next() {
		var (
			id        sql.NullString
			createdAt sql.NullTime
			evidence  []byte
		)
		if err := rows.Scan(&id, &createdAt, &evidence); err != nil {
			return nil, err
		}
		page = append(page, reviewCandidate{id: id.String, createdAt: nullTimeValue(createdAt), evidence: evidence})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return page, nil
}

// reviewItemSelectColumns and reviewItemJoins are the single projection used by
// both the queue root and the post-write reload.
const reviewItemSelectColumns = "e.`id`, e.`confidence`, e.`extractorVersion`, e.`createdAt`, e.`evidence`, " +
	"e.`edgeId`, e.`articleId`, " +
	"ed.`type`, ed.`confidence`, ed.`weight`, ed.`properties`, " +
	"fe.`id`, fe.`canonicalName`, fe.`type`, fe.`properties`, " +
	"te.`id`, te.`canonicalName`, te.`type`, te.`properties`, " +
	"a.`url`, a.`titleGuess`, a.`language`, a.`crawlAt`, " +
	"p.`title`, p.`summary`, p.`language` "

const reviewItemJoins = "FROM `KnowledgeEdgeEvidence` e " +
	"INNER JOIN `KnowledgeEdge` ed ON ed.`id` = e.`edgeId` AND ed.`orgId` = e.`orgId` " +
	"INNER JOIN `KnowledgeEntity` fe ON fe.`id` = ed.`fromEntityId` AND fe.`orgId` = e.`orgId` " +
	"INNER JOIN `KnowledgeEntity` te ON te.`id` = ed.`toEntityId` AND te.`orgId` = e.`orgId` " +
	"INNER JOIN `Article` a ON a.`id` = e.`articleId` AND a.`orgId` = e.`orgId` " +
	"LEFT JOIN `ProcessedArticle` p ON p.`articleId` = a.`id` AND p.`orgId` = a.`orgId` "

// projectReviewItems loads the joined projection for the selected ids in one
// batch and returns the models in the exact order the scan selected them.
func (r *reviewReader) projectReviewItems(
	ctx context.Context,
	orgID string,
	orderedIDs []string,
) ([]KnowledgeGraphEvidenceReviewItemModel, error) {
	if len(orderedIDs) == 0 {
		return []KnowledgeGraphEvidenceReviewItemModel{}, nil
	}

	query := "SELECT " + reviewItemSelectColumns + reviewItemJoins +
		"WHERE e.`orgId` = ? AND e.`id` IN (" + questionMarks(len(orderedIDs)) + ")"
	args := make([]any, 0, len(orderedIDs)+1)
	args = append(args, orgID)
	for _, id := range orderedIDs {
		args = append(args, id)
	}

	rows, err := r.s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	byID := make(map[string]KnowledgeGraphEvidenceReviewItemModel, len(orderedIDs))
	for rows.Next() {
		row, scanErr := scanReviewEvidenceRow(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		byID[row.ID] = row.model()
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	items := make([]KnowledgeGraphEvidenceReviewItemModel, 0, len(orderedIDs))
	for _, id := range orderedIDs {
		if item, ok := byID[id]; ok {
			items = append(items, item)
		}
	}
	return items, nil
}

// loadReviewItem reads exactly one review item inside the organization. A nil
// model means the row no longer exists after the write.
func (r *reviewReader) loadReviewItem(
	ctx context.Context,
	orgID string,
	evidenceID string,
) (*KnowledgeGraphEvidenceReviewItemModel, error) {
	items, err := r.projectReviewItems(ctx, orgID, []string{evidenceID})
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, nil
	}
	item := items[0]
	return &item, nil
}

// reviewEvidenceRow is one scanned review projection row.
type reviewEvidenceRow struct {
	ID               string
	Confidence       sql.NullFloat64
	ExtractorVersion sql.NullString
	CreatedAt        sql.NullTime
	Evidence         []byte
	EdgeID           sql.NullString
	ArticleID        sql.NullString
	EdgeType         sql.NullString
	EdgeConfidence   sql.NullFloat64
	EdgeWeight       sql.NullFloat64
	EdgeProperties   []byte
	FromID           sql.NullString
	FromName         sql.NullString
	FromType         sql.NullString
	FromProperties   []byte
	ToID             sql.NullString
	ToName           sql.NullString
	ToType           sql.NullString
	ToProperties     []byte
	ArticleURL       sql.NullString
	ArticleTitle     sql.NullString
	ArticleLanguage  sql.NullString
	ArticleCrawlAt   sql.NullTime
	ProcessedTitle   sql.NullString
	ProcessedSummary sql.NullString
	ProcessedLang    sql.NullString
}

// scanReviewEvidenceRow scans the 26 projection columns in
// reviewItemSelectColumns order.
func scanReviewEvidenceRow(rows *sql.Rows) (reviewEvidenceRow, error) {
	var row reviewEvidenceRow
	err := rows.Scan(
		&row.ID, &row.Confidence, &row.ExtractorVersion, &row.CreatedAt, &row.Evidence,
		&row.EdgeID, &row.ArticleID,
		&row.EdgeType, &row.EdgeConfidence, &row.EdgeWeight, &row.EdgeProperties,
		&row.FromID, &row.FromName, &row.FromType, &row.FromProperties,
		&row.ToID, &row.ToName, &row.ToType, &row.ToProperties,
		&row.ArticleURL, &row.ArticleTitle, &row.ArticleLanguage, &row.ArticleCrawlAt,
		&row.ProcessedTitle, &row.ProcessedSummary, &row.ProcessedLang,
	)
	return row, err
}

// model converts a scanned row into the GraphQL model.
func (row reviewEvidenceRow) model() KnowledgeGraphEvidenceReviewItemModel {
	return KnowledgeGraphEvidenceReviewItemModel{
		ID:               row.ID,
		Confidence:       nullFloatPtr(row.Confidence),
		ExtractorVersion: nullStringPtr(row.ExtractorVersion),
		CreatedAt:        nullTimeValue(row.CreatedAt),
		Evidence:         jsonScalar(row.Evidence),
		Edge: KnowledgeGraphReviewEdgeModel{
			ID:         row.EdgeID.String,
			Type:       row.EdgeType.String,
			Confidence: row.EdgeConfidence.Float64,
			Weight:     row.EdgeWeight.Float64,
			Properties: jsonScalar(row.EdgeProperties),
			FromEntity: KnowledgeGraphNodeModel{
				ID:         row.FromID.String,
				Name:       row.FromName.String,
				Type:       row.FromType.String,
				Properties: jsonScalar(row.FromProperties),
			},
			ToEntity: KnowledgeGraphNodeModel{
				ID:         row.ToID.String,
				Name:       row.ToName.String,
				Type:       row.ToType.String,
				Properties: jsonScalar(row.ToProperties),
			},
		},
		Article: KnowledgeGraphReviewArticleModel{
			ID:       row.ArticleID.String,
			URL:      row.ArticleURL.String,
			Title:    firstNonNullString(row.ProcessedTitle, row.ArticleTitle),
			Summary:  nullStringPtr(row.ProcessedSummary),
			Language: firstNonNullString(row.ProcessedLang, row.ArticleLanguage),
			CrawlAt:  nullTimeValue(row.ArticleCrawlAt),
		},
	}
}

// questionMarks renders "?,?,?" for an IN list.
func questionMarks(count int) string {
	if count <= 0 {
		return ""
	}
	return strings.Repeat("?,", count-1) + "?"
}

// firstNonNullString reproduces the JavaScript nullish-coalescing chain: an
// empty string is a real value and therefore does not fall through.
func firstNonNullString(values ...sql.NullString) *string {
	for _, value := range values {
		if value.Valid {
			text := value.String
			return &text
		}
	}
	return nil
}

// nullStringPtr converts a nullable SQL string into a nullable Go string.
func nullStringPtr(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	text := value.String
	return &text
}

// nullFloatPtr converts a nullable SQL number into a nullable Go float.
func nullFloatPtr(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	number := value.Float64
	return &number
}

// nullTimeValue returns the timestamp, or the zero time when the column is
// NULL. Both consumers are non-null in the SDL, so a NULL column cannot project
// as GraphQL null without failing the non-null field.
func nullTimeValue(value sql.NullTime) time.Time {
	if !value.Valid {
		return time.Time{}
	}
	return value.Time
}
