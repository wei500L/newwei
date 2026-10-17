package crawlfrontierruns

import (
	"database/sql"
	"time"
)

// nodeRecord is the CrawlFrontierNode column projection in Prisma schema
// order. It is embedded in GET /nodes/:id so the node columns lead the
// response.
type nodeRecord struct {
	ID              string     `json:"id"`
	RunID           string     `json:"runId"`
	ParentNodeID    *string    `json:"parentNodeId"`
	OrgID           string     `json:"orgId"`
	URL             string     `json:"url"`
	CanonicalURL    *string    `json:"canonicalUrl"`
	URLFingerprint  *string    `json:"urlFingerprint"`
	PageType        PageType   `json:"pageType"`
	Depth           int        `json:"depth"`
	QueueClass      QueueClass `json:"queueClass"`
	Status          NodeStatus `json:"status"`
	Score           *float64   `json:"score"`
	FreshnessScore  *float64   `json:"freshnessScore"`
	Attempts        int        `json:"attempts"`
	QueuedAt        *nestTime  `json:"queuedAt"`
	CrawledAt       *nestTime  `json:"crawledAt"`
	CrawlResultID   *string    `json:"crawlResultId"`
	RejectionReason *string    `json:"rejectionReason"`
	LastError       *string    `json:"lastError"`
	Metadata        RawJSON    `json:"metadata"`
	DiscoveredAt    *nestTime  `json:"discoveredAt"`
	CreatedAt       *nestTime  `json:"createdAt"`
	UpdatedAt       *nestTime  `json:"updatedAt"`
}

// nodeColumns is the CrawlFrontierNode projection in Prisma schema order.
const nodeColumns = "id, runId, parentNodeId, orgId, url, canonicalUrl, urlFingerprint, pageType, depth, queueClass, status, score, freshnessScore, attempts, queuedAt, crawledAt, crawlResultId, rejectionReason, lastError, metadata, discoveredAt, createdAt, updatedAt"

// scanNodeRecord scans one node row. The caller owns the *sql.Rows cursor.
func scanNodeRecord(rows *sql.Rows) (nodeRecord, error) {
	var record nodeRecord
	var parentNodeID, canonicalURL, urlFingerprint, crawlResultID, rejectionReason, lastError sql.NullString
	var score, freshnessScore sql.NullFloat64
	var queuedAt, crawledAt sql.NullTime
	var metadata []byte
	var discoveredAt, createdAt, updatedAt time.Time
	err := rows.Scan(
		&record.ID, &record.RunID, &parentNodeID, &record.OrgID, &record.URL, &canonicalURL,
		&urlFingerprint, &record.PageType, &record.Depth, &record.QueueClass, &record.Status,
		&score, &freshnessScore, &record.Attempts, &queuedAt, &crawledAt, &crawlResultID,
		&rejectionReason, &lastError, &metadata, &discoveredAt, &createdAt, &updatedAt,
	)
	if err != nil {
		return nodeRecord{}, err
	}
	record.ParentNodeID = nullStringPtr(parentNodeID)
	record.CanonicalURL = nullStringPtr(canonicalURL)
	record.URLFingerprint = nullStringPtr(urlFingerprint)
	record.Score = nullFloatPtr(score)
	record.FreshnessScore = nullFloatPtr(freshnessScore)
	record.QueuedAt = nestFromNullTime(queuedAt)
	record.CrawledAt = nestFromNullTime(crawledAt)
	record.CrawlResultID = nullStringPtr(crawlResultID)
	record.RejectionReason = nullStringPtr(rejectionReason)
	record.LastError = nullStringPtr(lastError)
	record.Metadata = objectJSONOrNull(metadata)
	record.DiscoveredAt = nestFromTime(discoveredAt)
	record.CreatedAt = nestFromTime(createdAt)
	record.UpdatedAt = nestFromTime(updatedAt)
	return record, nil
}

// nullFloatPtr converts a nullable float column to a JSON null/number pointer.
func nullFloatPtr(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	out := value.Float64
	return &out
}

// nodeRunProfile is the profile subset embedded in GET /nodes/:id.
type nodeRunProfile struct {
	ID            string        `json:"id"`
	Name          string        `json:"name"`
	MatchHost     string        `json:"matchHost"`
	ExecutionMode ExecutionMode `json:"executionMode"`
	IsActive      bool          `json:"isActive"`
}

// nodeRunRef is the run subset embedded in GET /nodes/:id. It replaces the
// raw relation that mapNode would otherwise expand.
type nodeRunRef struct {
	ID            string          `json:"id"`
	SeedURL       string          `json:"seedUrl"`
	Status        RunStatus       `json:"status"`
	ExecutionMode ExecutionMode   `json:"executionMode"`
	Profile       *nodeRunProfile `json:"profile"`
}

// crawlResultDocument is the crawl result subset embedded in GET /nodes/:id.
type crawlResultDocument struct {
	ID          string    `json:"id"`
	SourceURL   string    `json:"sourceUrl"`
	FetchedAt   *nestTime `json:"fetchedAt"`
	MarkdownRef string    `json:"markdownRef"`
	ContentHash string    `json:"contentHash"`
	Metadata    RawJSON   `json:"metadata"`
}

// articleDocument is the article subset embedded in GET /nodes/:id.
type articleDocument struct {
	ID          string    `json:"id"`
	URL         string    `json:"url"`
	TitleGuess  *string   `json:"titleGuess"`
	SourceLabel *string   `json:"sourceLabel"`
	Language    *string   `json:"language"`
	CrawlAt     *nestTime `json:"crawlAt"`
	Metadata    RawJSON   `json:"metadata"`
	LLMRepair   RawJSON   `json:"llmRepair"`
}

// processedArticleDocument is the ProcessedArticle projection embedded in
// GET /nodes/:id. JSON columns are passed through verbatim and NULL columns
// serialize as JSON null.
type processedArticleDocument struct {
	ID                string    `json:"id"`
	Status            string    `json:"status"`
	Title             *string   `json:"title"`
	Subtitle          *string   `json:"subtitle"`
	Author            *string   `json:"author"`
	Source            *string   `json:"source"`
	PublishedAt       *nestTime `json:"publishedAt"`
	Category          *string   `json:"category"`
	QualityScore      *float64  `json:"qualityScore"`
	LLMModel          *string   `json:"llmModel"`
	LLMPromptVersion  *string   `json:"llmPromptVersion"`
	Language          *string   `json:"language"`
	Location          *string   `json:"location"`
	ProcessedAt       *nestTime `json:"processedAt"`
	RemovedNoiseTypes RawJSON   `json:"removedNoiseTypes"`
	Topics            RawJSON   `json:"topics"`
	KeyPoints         RawJSON   `json:"keyPoints"`
	Entities          RawJSON   `json:"entities"`
	KGRelations       RawJSON   `json:"kgRelations"`
}

// nodeDetail is GET /nodes/:id: node columns, run, crawl result, article,
// processed article and the three summaries.
type nodeDetail struct {
	nodeRecord
	Run               nodeRunRef                `json:"run"`
	CrawlResult       *crawlResultDocument      `json:"crawlResult"`
	Article           *articleDocument          `json:"article"`
	ProcessedArticle  *processedArticleDocument `json:"processedArticle"`
	RepairSummary     *nodeRepairSummary        `json:"repairSummary"`
	ExtractionSummary extractionSummary         `json:"extractionSummary"`
	LLMLogFilters     llmLogFilters             `json:"llmLogFilters"`
}

// isDocument marks nodeDetail as a JSON payload.
func (nodeDetail) isDocument() {}
