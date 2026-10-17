package settingscrawl

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
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
	s        *store
	settings *settingsReader
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

// evidenceReviewQueue reproduces KnowledgeGraphReviewResolver's queue root.
//
// The query adds an orgId predicate to every joined relation. Foreign keys only
// bind primary keys, so without those predicates a historical dirty row could
// pull another organization's entity names, edge properties and article
// titles into this organization's queue. ProcessedArticle is LEFT joined with
// its orgId predicate in the ON clause so an article without a processed row
// still falls back to the Article title guess instead of being dropped.
func (r *reviewReader) evidenceReviewQueue(
	ctx context.Context,
	identity contract.Identity,
	limitArg *int,
	maxConfidenceArg *float64,
	onlyUnreviewedArg *bool,
) ([]KnowledgeGraphEvidenceReviewItemModel, error) {
	settings, err := r.settings.knowledgeGraphSettings(ctx, identity.OrgID)
	if err != nil {
		// getSettings swallows a database failure and reports the disabled
		// fallback, whose enabled=false gate yields an empty queue. Returning
		// the empty list here is the same observable result.
		log.Printf("settingscrawl: knowledge graph settings read failed for org %s: %v", identity.OrgID, err)
		return []KnowledgeGraphEvidenceReviewItemModel{}, nil
	}
	if !settings.Enabled {
		return []KnowledgeGraphEvidenceReviewItemModel{}, nil
	}

	limit := 50
	if limitArg != nil {
		limit = *limitArg
	}
	limit = clampIntRounded(float64(limit), 1, 200)
	take := 50
	if limit*4 > 50 {
		take = limit * 4
	}
	if take > 500 {
		take = 500
	}

	maxConfidence := settings.MinEdgeConfidence
	if maxConfidenceArg != nil {
		maxConfidence = *maxConfidenceArg
	}
	onlyUnreviewed := true
	if onlyUnreviewedArg != nil {
		onlyUnreviewed = *onlyUnreviewedArg
	}

	query := "SELECT e.`id`, e.`confidence`, e.`extractorVersion`, e.`createdAt`, e.`evidence`, " +
		"e.`edgeId`, e.`articleId`, " +
		"ed.`type`, ed.`confidence`, ed.`weight`, ed.`properties`, " +
		"fe.`id`, fe.`canonicalName`, fe.`type`, fe.`properties`, " +
		"te.`id`, te.`canonicalName`, te.`type`, te.`properties`, " +
		"a.`url`, a.`titleGuess`, a.`language`, a.`crawlAt`, " +
		"p.`title`, p.`summary`, p.`language` " +
		"FROM `KnowledgeEdgeEvidence` e " +
		"INNER JOIN `KnowledgeEdge` ed ON ed.`id` = e.`edgeId` AND ed.`orgId` = e.`orgId` " +
		"INNER JOIN `KnowledgeEntity` fe ON fe.`id` = ed.`fromEntityId` AND fe.`orgId` = e.`orgId` " +
		"INNER JOIN `KnowledgeEntity` te ON te.`id` = ed.`toEntityId` AND te.`orgId` = e.`orgId` " +
		"INNER JOIN `Article` a ON a.`id` = e.`articleId` AND a.`orgId` = e.`orgId` " +
		"LEFT JOIN `ProcessedArticle` p ON p.`articleId` = a.`id` AND p.`orgId` = a.`orgId` " +
		"WHERE e.`orgId` = ? AND (e.`confidence` IS NOT NULL AND e.`confidence` <= ?) " +
		"ORDER BY e.`createdAt` DESC LIMIT ?"

	rows, err := r.s.db.QueryContext(ctx, query, identity.OrgID, maxConfidence, take)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]KnowledgeGraphEvidenceReviewItemModel, 0, limit)
	for rows.Next() {
		var (
			id               sql.NullString
			confidence       sql.NullFloat64
			extractorVersion sql.NullString
			createdAt        sql.NullTime
			evidence         []byte
			edgeID           sql.NullString
			articleID        sql.NullString
			edgeType         sql.NullString
			edgeConfidence   sql.NullFloat64
			edgeWeight       sql.NullFloat64
			edgeProperties   []byte
			fromID           sql.NullString
			fromName         sql.NullString
			fromType         sql.NullString
			fromProperties   []byte
			toID             sql.NullString
			toName           sql.NullString
			toType           sql.NullString
			toProperties     []byte
			articleURL       sql.NullString
			articleTitle     sql.NullString
			articleLanguage  sql.NullString
			articleCrawlAt   sql.NullTime
			processedTitle   sql.NullString
			processedSummary sql.NullString
			processedLang    sql.NullString
		)
		if err := rows.Scan(
			&id, &confidence, &extractorVersion, &createdAt, &evidence,
			&edgeID, &articleID,
			&edgeType, &edgeConfidence, &edgeWeight, &edgeProperties,
			&fromID, &fromName, &fromType, &fromProperties,
			&toID, &toName, &toType, &toProperties,
			&articleURL, &articleTitle, &articleLanguage, &articleCrawlAt,
			&processedTitle, &processedSummary, &processedLang,
		); err != nil {
			return nil, err
		}
		if onlyUnreviewed && isReviewedEvidence(evidence) {
			continue
		}
		items = append(items, KnowledgeGraphEvidenceReviewItemModel{
			ID:               id.String,
			Confidence:       nullFloatPtr(confidence),
			ExtractorVersion: nullStringPtr(extractorVersion),
			CreatedAt:        nullTimeValue(createdAt),
			Evidence:         jsonScalar(evidence),
			Edge: KnowledgeGraphReviewEdgeModel{
				ID:         edgeID.String,
				Type:       edgeType.String,
				Confidence: edgeConfidence.Float64,
				Weight:     edgeWeight.Float64,
				Properties: jsonScalar(edgeProperties),
				FromEntity: KnowledgeGraphNodeModel{
					ID:         fromID.String,
					Name:       fromName.String,
					Type:       fromType.String,
					Properties: jsonScalar(fromProperties),
				},
				ToEntity: KnowledgeGraphNodeModel{
					ID:         toID.String,
					Name:       toName.String,
					Type:       toType.String,
					Properties: jsonScalar(toProperties),
				},
			},
			Article: KnowledgeGraphReviewArticleModel{
				ID:       articleID.String,
				URL:      articleURL.String,
				Title:    firstNonNullString(processedTitle, articleTitle),
				Summary:  nullStringPtr(processedSummary),
				Language: firstNonNullString(processedLang, articleLanguage),
				CrawlAt:  nullTimeValue(articleCrawlAt),
			},
		})
		if len(items) >= limit {
			break
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
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
