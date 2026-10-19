// Package archivereading serves the archive digest, calendar, detail and
// headlines search-export reads. It owns the MySQL/Mongo read models, cached
// classification freshness, display eligibility, semantic search and the
// BullMQ preparation producer port. It never generates classifications or
// consumes preparation jobs; the NestJS ArchivePreparationProcessor remains the
// only worker owner.
package archivereading

import "time"

// Region is the archive region enum.
type Region string

// Calendar region values.
const (
	RegionAPAC       Region = "APAC"
	RegionMiddleEast Region = "MIDDLE_EAST"
	RegionAmericas   Region = "AMERICAS"
	RegionEurope     Region = "EUROPE"
	RegionAfrica     Region = "AFRICA"
	RegionOther      Region = "OTHER"
)

// ParseRegion validates an archive region value.
func ParseRegion(value string) (Region, bool) {
	switch Region(value) {
	case RegionAPAC, RegionMiddleEast, RegionAmericas, RegionEurope, RegionAfrica, RegionOther:
		return Region(value), true
	default:
		return "", false
	}
}

// Vertical is the archive vertical enum.
type Vertical string

// Vertical values in fixed product order.
const (
	VerticalEastSea         Vertical = "EAST_SEA"
	VerticalSouthSea        Vertical = "SOUTH_SEA"
	VerticalWestFront       Vertical = "WEST_FRONT"
	VerticalForeignAffairs  Vertical = "FOREIGN_AFFAIRS"
	VerticalDomesticAffairs Vertical = "DOMESTIC_AFFAIRS"
)

// VerticalOrder is the fixed five-group order used by every projection.
var VerticalOrder = []Vertical{
	VerticalEastSea,
	VerticalSouthSea,
	VerticalWestFront,
	VerticalForeignAffairs,
	VerticalDomesticAffairs,
}

// ParseVertical validates an archive vertical value.
func ParseVertical(value string) (Vertical, bool) {
	switch Vertical(value) {
	case VerticalEastSea, VerticalSouthSea, VerticalWestFront, VerticalForeignAffairs, VerticalDomesticAffairs:
		return Vertical(value), true
	default:
		return "", false
	}
}

// VerticalDisplayName maps each vertical to its fixed Chinese display name.
var VerticalDisplayName = map[Vertical]string{
	VerticalEastSea:         "【东海】",
	VerticalSouthSea:        "【南海】",
	VerticalWestFront:       "【西面】",
	VerticalForeignAffairs:  "【外务】",
	VerticalDomesticAffairs: "【内务】",
}

// Weight is the archive weight enum.
type Weight string

// Weight values.
const (
	WeightOne   Weight = "ONE"
	WeightTwo   Weight = "TWO"
	WeightThree Weight = "THREE"
	WeightFour  Weight = "FOUR"
	WeightFive  Weight = "FIVE"
)

// WeightValue maps a weight enum to its 1..5 value.
func WeightValue(weight Weight) int {
	switch weight {
	case WeightOne:
		return 1
	case WeightTwo:
		return 2
	case WeightThree:
		return 3
	case WeightFour:
		return 4
	case WeightFive:
		return 5
	default:
		return 0
	}
}

// AllWeights is the five-value default set.
func AllWeights() []Weight {
	return []Weight{WeightFive, WeightFour, WeightThree, WeightTwo, WeightOne}
}

// MatchOrigin is the lexical/semantic recall origin.
type MatchOrigin string

// Match origin values.
const (
	MatchOriginLexical  MatchOrigin = "LEXICAL"
	MatchOriginSemantic MatchOrigin = "SEMANTIC"
	MatchOriginHybrid   MatchOrigin = "HYBRID"
)

// PreparationState is the archive preparation state enum.
type PreparationState string

// Preparation states.
const (
	PreparationIdle       PreparationState = "IDLE"
	PreparationQueued     PreparationState = "QUEUED"
	PreparationProcessing PreparationState = "PROCESSING"
	PreparationPartial    PreparationState = "PARTIAL"
	PreparationReady      PreparationState = "READY"
	PreparationFailed     PreparationState = "FAILED"
)

// DecisionReason is the cached classification decision reason.
type DecisionReason string

// Decision reason values.
const (
	DecisionFusedWinner              DecisionReason = "FUSED_WINNER"
	DecisionStrongRuleOverride       DecisionReason = "STRONG_RULE_OVERRIDE"
	DecisionLowSemanticConfidence    DecisionReason = "RULE_FALLBACK_LOW_SEMANTIC_CONFIDENCE"
	DecisionDefaultForeignAffairs    DecisionReason = "DEFAULT_FOREIGN_AFFAIRS_FALLBACK"
	DecisionStaleCachedResult        DecisionReason = "STALE_CACHED_RESULT"
	DecisionReasonI18nFusedWinner                   = "pages.eventsArchive.detail.classificationReason.fusedWinner"
	DecisionReasonI18nStrongOverride                = "pages.eventsArchive.detail.classificationReason.strongRuleOverride"
	DecisionReasonI18nLowSemantic                   = "pages.eventsArchive.detail.classificationReason.ruleFallbackLowSemanticConfidence"
	DecisionReasonI18nDefault                       = "pages.eventsArchive.detail.classificationReason.defaultForeignAffairsFallback"
	DecisionReasonI18nStaleCached                   = "pages.eventsArchive.detail.classificationReason.staleCachedResult"
)

// DecisionI18n maps a decision reason to its I18n key.
var DecisionI18n = map[DecisionReason]string{
	DecisionFusedWinner:           DecisionReasonI18nFusedWinner,
	DecisionStrongRuleOverride:    DecisionReasonI18nStrongOverride,
	DecisionLowSemanticConfidence: DecisionReasonI18nLowSemantic,
	DecisionDefaultForeignAffairs: DecisionReasonI18nDefault,
	DecisionStaleCachedResult:     DecisionReasonI18nStaleCached,
}

// StaleReason is one cached-classification freshness failure.
type StaleReason string

// Stale reason values.
const (
	StaleTaxonomyVersion StaleReason = "taxonomy-version-changed"
	StalePipelineVersion StaleReason = "pipeline-version-changed"
	StaleEmbeddingModel  StaleReason = "embedding-model-changed"
	StaleRerankModel     StaleReason = "rerank-model-changed"
)

// StaleI18n maps a stale reason to its I18n key.
var StaleI18n = map[StaleReason]string{
	StaleTaxonomyVersion: "pages.eventsArchive.detail.classificationStaleReason.taxonomyVersionChanged",
	StalePipelineVersion: "pages.eventsArchive.detail.classificationStaleReason.pipelineVersionChanged",
	StaleEmbeddingModel:  "pages.eventsArchive.detail.classificationStaleReason.embeddingModelChanged",
	StaleRerankModel:     "pages.eventsArchive.detail.classificationStaleReason.rerankModelChanged",
}

// CursorInput is one per-vertical digest cursor.
type CursorInput struct {
	Vertical Vertical
	Cursor   *string
}

// DigestInput is the normalized archiveDigest input.
type DigestInput struct {
	AnchorDate time.Time
	Region     Region
	Search     string
	Weights    []Weight
	PageSize   int
	Cursors    []CursorInput
}

// CalendarInput is the normalized archiveCalendar input.
type CalendarInput struct {
	Month    string
	Region   *Region
	Vertical *Vertical
}

// PreparationProjection is the GraphQL preparation object.
type PreparationProjection struct {
	State        PreparationState
	ReadyCount   int
	MissingCount int
	UpdatedAt    time.Time
	ErrorMessage *string
}

// DigestItem is one projected archive event item.
type DigestItem struct {
	ProcessedArticleID string
	EventID            *string
	Title              *string
	Summary            *string
	CountryLabel       *string
	Region             Region
	Vertical           Vertical
	Weight             int
	QualityScore       *float64
	PublishedAt        *time.Time
	SortAt             time.Time
	SourceLabel        *string
	SourceURL          *string
	EntityTags         []string
	KeywordHighlights  []string
	MatchOrigin        *MatchOrigin
	RelevanceScore     *float64
	RerankScore        *float64
}

// PageInfo is the per-vertical cursor page info.
type PageInfo struct {
	HasMore    bool
	NextCursor *string
}

// VerticalGroup is one digest group.
type VerticalGroup struct {
	Vertical    Vertical
	DisplayName string
	TotalCount  int
	Items       []DigestItem
	PageInfo    PageInfo
}

// DigestResult is the archiveDigest payload.
type DigestResult struct {
	AnchorDate  time.Time
	Region      Region
	TotalCount  int
	Groups      []VerticalGroup
	Preparation PreparationProjection
}

// CalendarDay is one non-zero calendar bucket.
type CalendarDay struct {
	Date  string
	Count int
}

// TimelineEntry is one archive detail timeline row.
type TimelineEntry struct {
	ID          string
	BucketStart time.Time
	Title       *string
	Summary     *string
}

// RelatedArticle is one archive detail related article.
type RelatedArticle struct {
	ProcessedArticleID string
	Title              *string
	Summary            *string
	PublishedAt        *time.Time
	SourceLabel        *string
	SourceURL          *string
}

// ScoreEntry is one five-vertical classification score row.
type ScoreEntry struct {
	Vertical       Vertical
	RuleScore      float64
	EmbeddingScore float64
	RerankScore    float64
	FusedScore     float64
}

// ClassificationDetail is the nullable detail classification block.
type ClassificationDetail struct {
	Region                Region
	Vertical              Vertical
	TaxonomyVersion       string
	PipelineVersion       string
	EmbeddingModel        string
	RerankModel           string
	DecisionReason        DecisionReason
	DecisionReasonI18nKey string
	IsStale               bool
	StaleReasons          []StaleReason
	StaleReasonI18nKeys   []string
	RuleSignals           []string
	ScoreEntries          []ScoreEntry
}

// DetailResult is the archiveDetail payload.
type DetailResult struct {
	ProcessedArticleID string
	EventID            *string
	Title              *string
	Summary            *string
	FullEntities       []string
	SourceURL          *string
	SourceLabel        *string
	Classification     *ClassificationDetail
	Timeline           []TimelineEntry
	RelatedArticles    []RelatedArticle
}

// Error is the typed archive failure carrying the public appCode.
type Error struct {
	AppCode    string
	Status     int
	Message    string
	Diagnostic string
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if e.Diagnostic != "" {
		return e.Diagnostic
	}
	return e.Message
}

// Archive appCodes.
const (
	AppCodeMonthInvalid              = "ARCHIVE_MONTH_INVALID"
	AppCodeEmbeddingUnavailable      = "ARCHIVE_EMBEDDING_UNAVAILABLE"
	AppCodeEmbeddingFailed           = "ARCHIVE_EMBEDDING_FAILED"
	AppCodeEmbeddingInvalidResponse  = "ARCHIVE_EMBEDDING_INVALID_RESPONSE"
	AppCodeVectorUnavailable         = "ARCHIVE_VECTOR_UNAVAILABLE"
	AppCodeRerankFailed              = "ARCHIVE_RERANK_FAILED"
	AppCodeRerankInvalidResponse     = "ARCHIVE_RERANK_INVALID_RESPONSE"
	appCodeClassificationPersistFail = "ARCHIVE_CLASSIFICATION_PERSIST_FAILED"
)

func serviceUnavailable(appCode, message, diagnostic string) *Error {
	return &Error{AppCode: appCode, Status: 503, Message: "Internal server error", Diagnostic: diagnostic}
}

// monthError is the exact 400 the calendar route keeps in every transport.
func monthError() *Error {
	return &Error{
		AppCode: AppCodeMonthInvalid,
		Status:  400,
		Message: "archiveCalendar month must be in YYYY-MM format.",
	}
}
