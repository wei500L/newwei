// Package newspipeline is the Go owner of the news pipeline stages behind the
// itemPipeline BullMQ queue.
//
// It ports NewsPipelineStagesService.process and the services it calls:
//
//	normalize -> crawl (fetch article) -> [legacy | staged] -> persist
//
// Legacy mode runs clean -> classify -> dedupe -> persist. Staged mode runs a
// preflight gate, clean, a post-clean quality gate, the three independent
// enrichment stages (entities, sentiment, knowledge graph), classify, dedupe
// and persist; a rejected gate still persists a gate-rejected result with
// skipped stage_meta entries and does not throw.
//
// Failure semantics follow the NestJS worker contract exactly:
//   - normalize/crawl/clean/classify/dedupe/persist failures propagate and let
//     the queue classify them (permanent vs transient). A permanent classifier
//     error becomes an UnrecoverableError in itempipeline.
//   - an individual enrichment stage failure never aborts the pipeline: the
//     stage records failed, entities become [], sentiment becomes null and kg
//     relations become [], and the failure is written to TaskLog.
//   - persist failure after a duplicate mark rolls the Duplicate mark back
//     before rethrowing.
//
// The package never reads another tenant: every MySQL/Mongo query is scoped by
// the job orgId and every content cache / dedupe candidate lookup is scoped to
// one organization.
package newspipeline

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlexecution"
	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
	"github.com/wei500L/newwei/apps/api-go/internal/newsclassifier"
	"github.com/wei500L/newwei/apps/api-go/internal/vectorclient"
)

// Job is PipelineJobContext: the queue identity of one pipeline execution.
type Job struct {
	Queue           string
	JobID           string
	ItemMetaID      string
	RawItemID       string
	OrgID           string
	ProcessedItemID string
	PipelineJobID   *string
	SourceID        *string
}

// RawItem is RawPipelineItem: the read-only RawItem document handed to the
// pipeline.
type RawItem struct {
	ID         string
	ItemMetaID string
	Payload    json.RawMessage
	Source     *string
}

// PrefetchedArticle is the payload.prefetchedArticle branch: the caller already
// fetched the body, so the crawl stage must not make a crawl4ai request.
type PrefetchedArticle struct {
	Title       *string
	Description *string
	Author      *string
	Markdown    *string
	PublishedAt *string
	Metadata    json.RawMessage
}

// NormalizedPayload is NormalizedNewsPayloadSchema's normalized output.
type NormalizedPayload struct {
	URL          string
	Language     *string
	SourceName   *string
	Keywords     []string
	Tags         []string
	SummaryHints []string
	Metadata     json.RawMessage
	CrawlOptions json.RawMessage
	Prefetched   *PrefetchedArticle
	ForceRefresh bool
}

// CrawledArticle is the fetchArticle result (CrawledArticle in TypeScript).
type CrawledArticle struct {
	SourceURL             string
	Markdown              string
	MarkdownWithCitations *string
	ReferencesMarkdown    *string
	RawMarkdown           *string
	FitMarkdown           *string
	Metadata              json.RawMessage
	PublishedAt           *string
	RunID                 *string
	FetchedAt             string
	ContentHash           string
}

// ArticleWithCache reports whether the article came from a stored crawl result
// or the prefetched body (article.fromCache in TypeScript).
type ArticleWithCache struct {
	CrawledArticle
	FromCache bool
}

// ClassificationCandidate is one category_candidates member.
type ClassificationCandidate struct {
	Path           string  `json:"path"`
	Score          float64 `json:"score"`
	LegacyCategory string  `json:"legacy_category"`
	Reason         *string `json:"reason"`
}

// Entity is one entities member.
type Entity struct {
	Name       string  `json:"name"`
	Type       string  `json:"type"`
	Confidence float64 `json:"confidence"`
}

// KGEntityRef is one knowledge-graph entity reference.
type KGEntityRef struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// KGRelation is one kg_relations member. Properties is an open JSON leaf.
type KGRelation struct {
	Subject    KGEntityRef     `json:"subject"`
	Predicate  string          `json:"predicate"`
	Object     KGEntityRef     `json:"object"`
	Confidence float64         `json:"confidence"`
	Properties json.RawMessage `json:"properties,omitempty"`
	Evidence   *string         `json:"evidence,omitempty"`
}

// StageMetaEntry is one stage_meta entry. createStageMetaEntry always writes
// every member (null when absent), which is why none of these fields is
// omitempty.
type StageMetaEntry struct {
	Status           string   `json:"status"`
	Provider         *string  `json:"provider"`
	Reason           *string  `json:"reason"`
	Model            *string  `json:"model"`
	PromptVersion    *string  `json:"prompt_version"`
	PromptTokens     *float64 `json:"prompt_tokens"`
	CompletionTokens *float64 `json:"completion_tokens"`
	TotalTokens      *float64 `json:"total_tokens"`
	CostUSD          *float64 `json:"cost_usd"`
	LatencyMS        *float64 `json:"latency_ms"`
}

// NewStageMetaEntry is createStageMetaEntry: the status and provider are set,
// every other member is null until the caller fills it.
func NewStageMetaEntry(status string, provider *string) *StageMetaEntry {
	return &StageMetaEntry{Status: status, Provider: provider}
}

// NewStageMetaEntryWithReason is createStageMetaEntry with an explicit reason.
func NewStageMetaEntryWithReason(status string, provider *string, reason string) *StageMetaEntry {
	entry := NewStageMetaEntry(status, provider)
	entry.Reason = stringPointer(reason)
	return entry
}

// StageMeta is the stage_meta object. Membership follows the NestJS insertion
// order preflight, clean, quality_gate, entities, sentiment, kg, classify,
// dedupe; a stage that never ran stays absent.
type StageMeta struct {
	Preflight   *StageMetaEntry `json:"preflight,omitempty"`
	Clean       *StageMetaEntry `json:"clean,omitempty"`
	QualityGate *StageMetaEntry `json:"quality_gate,omitempty"`
	Entities    *StageMetaEntry `json:"entities,omitempty"`
	Sentiment   *StageMetaEntry `json:"sentiment,omitempty"`
	KG          *StageMetaEntry `json:"kg,omitempty"`
	Classify    *StageMetaEntry `json:"classify,omitempty"`
	Dedupe      *StageMetaEntry `json:"dedupe,omitempty"`
}

// CleanedNews is CleanedNewsSchema's normalized output in schema field order.
// Unknown members are stripped and array defaults are emitted as [].
type CleanedNews struct {
	Title                 *string                   `json:"title"`
	Subtitle              *string                   `json:"subtitle"`
	Author                *string                   `json:"author"`
	Source                *string                   `json:"source"`
	PublishedAt           *string                   `json:"published_at"`
	Language              *string                   `json:"language"`
	Location              *string                   `json:"location"`
	Category              *string                   `json:"category"`
	ContentType           *string                   `json:"content_type"`
	CategoryPath          *string                   `json:"category_path"`
	CategoryLabels        []string                  `json:"category_labels"`
	CategoryConfidence    *float64                  `json:"category_confidence"`
	CategoryReason        *string                   `json:"category_reason"`
	CategoryMethod        *string                   `json:"category_method"`
	CategoryCandidates    []ClassificationCandidate `json:"category_candidates"`
	Sentiment             *string                   `json:"sentiment"`
	SentimentLabel        *string                   `json:"sentiment_label"`
	Topics                []string                  `json:"topics"`
	Summary               *string                   `json:"summary"`
	KeyPoints             []string                  `json:"key_points"`
	Entities              []Entity                  `json:"entities"`
	KGRelations           []KGRelation              `json:"kg_relations"`
	StageMeta             *StageMeta                `json:"stage_meta,omitempty"`
	CleanedMarkdown       string                    `json:"cleaned_markdown"`
	CleanedMarkdownSource *string                   `json:"cleaned_markdown_source,omitempty"`
	RemovedNoiseTypes     []string                  `json:"removed_noise_types"`
	QualityScore          *float64                  `json:"quality_score"`
	LLMModel              *string                   `json:"llm_model"`
	LLMPromptVersion      *string                   `json:"llm_prompt_version"`
}

// LLMMetadata is the processed item llm sub-document. Every member is always
// present; a missing value is null.
type LLMMetadata struct {
	Model            *string  `json:"model"`
	PromptVersion    *string  `json:"promptVersion"`
	PromptTokens     *float64 `json:"promptTokens"`
	CompletionTokens *float64 `json:"completionTokens"`
	TotalTokens      *float64 `json:"totalTokens"`
	CostUSD          *float64 `json:"costUsd"`
	LatencyMS        *float64 `json:"latencyMs"`
}

// EmptyLLMMetadata is emptyLlmMetadata.
func EmptyLLMMetadata() LLMMetadata { return LLMMetadata{} }

// DedupeResult is SummaryDedupeResult.
type DedupeResult struct {
	SummaryEmbedding      []float64
	SummaryEmbeddingModel *string
	DuplicateOf           *string
	DuplicateSimilarity   *float64
	ThresholdUsed         *float64
}

// ArticleRepairMetadata is the articleMetadataPatch.llmRepair block.
type ArticleRepairMetadata struct {
	Applied          bool
	MissingFields    []string
	RepairedFields   []string
	Model            *string
	PromptTokens     *float64
	CompletionTokens *float64
	TotalTokens      *float64
	CostUSD          *float64
	LatencyMS        *float64
	Error            *string
}

// CleanResult is cleanArticle's return value.
type CleanResult struct {
	Cleaned              CleanedNews
	LLM                  LLMMetadata
	ContentHash          string
	ProcessedArticleID   *string
	ContentDuplicateOf   *string
	ArticleMetadataPatch json.RawMessage
}

// PersistInput is persistProcessedResult's input.
type PersistInput struct {
	Job                   Job
	Raw                   RawItem
	Payload               NormalizedPayload
	Article               CrawledArticle
	Cleaned               CleanedNews
	LLM                   LLMMetadata
	ContentHash           string
	ProcessedArticleID    *string
	ArticleMetadataPatch  json.RawMessage
	ProcessedItemID       string
	SummaryEmbedding      []float64
	SummaryEmbeddingModel *string
	DuplicateOf           *string
	DuplicateSimilarity   *float64
}

// PersistResult is the stored ProcessedItem plus the created outbox row id.
type PersistResult struct {
	ProcessedItemID string
	OutboxID        string
	// Document is the ProcessedItem JSON the BullMQ job returns and the
	// "complete" TaskLog report uses (at least the _id member).
	Document json.RawMessage
}

// ProcessResult is the pipeline process() result.
type ProcessResult = PersistResult

// PipelineMode is NewsExtractionPipelineMode.
type PipelineMode string

// Pipeline modes.
const (
	PipelineModeLegacy PipelineMode = "legacy"
	PipelineModeStaged PipelineMode = "staged"
)

// PreflightGate is NewsExtractionPreflightGateSettings.
type PreflightGate struct {
	Enabled            bool
	MinWordCount       int
	MinQualityScore    float64
	RejectBotChallenge bool
	RejectListLike     bool
}

// PostCleanGate is NewsExtractionPostCleanGateSettings.
type PostCleanGate struct {
	Enabled         bool
	MinQualityScore float64
	MinCleanedChars int
	RequireSummary  bool
}

// ExtractionCapabilities is NewsExtractionCapabilitiesSettings.
type ExtractionCapabilities struct {
	Entities  bool
	Sentiment bool
	KG        bool
}

// ExtractionProviders is NewsExtractionProvidersSettings. Only "llm" is
// supported, exactly like the TypeScript enums.
type ExtractionProviders struct {
	Clean     string
	Entities  string
	Sentiment string
	KG        string
}

// ExtractionSettings is NewsExtractionSettings.
type ExtractionSettings struct {
	PipelineMode  PipelineMode
	PreflightGate PreflightGate
	PostCleanGate PostCleanGate
	Capabilities  ExtractionCapabilities
	Providers     ExtractionProviders
}

// ScopedThreshold is NewsDedupeScopedThreshold.
type ScopedThreshold struct {
	SourceID     *string
	Language     *string
	CategoryPath *string
	Threshold    float64
}

// DedupeSettings is NewsDedupeSettings.
type DedupeSettings struct {
	DefaultThreshold       float64
	ScopedThresholds       []ScopedThreshold
	UseEmbeddings          bool
	LLMJudgeInstructions   *string
	LLMJudgeModel          *string
	LLMJudgeConcurrency    int
	LLMJudgeMaxComparisons int
	LLMJudgeCandidateChars int
	LLMJudgePromptVersion  string
	LLMJudgeSystemPrompt   string
	LLMJudgeUserPrompt     string
}

// ClassificationSettings is NewsClassificationSettings.
type ClassificationSettings struct {
	Enabled         bool
	StrictFail      bool
	EnableLlm       bool
	EnableEmbedding bool
	EnableRerank    bool
	LLMModel        *string
	MinConfidence   float64
	EmbeddingTopK   int
	RerankTopN      int
	CacheTTLSeconds int
	TaxonomyVersion string
	Taxonomy        []TaxonomyNode
}

// TaxonomyNode is NewsClassificationTaxonomyNode.
type TaxonomyNode struct {
	Path           string
	DisplayName    string
	Description    string
	LegacyCategory string
	Keywords       []string
	Synonyms       []string
}

// QualitySettings is ClassificationQualitySettings.
type QualitySettings struct {
	LowConfidenceThreshold    float64
	LLMP95LatencyWarnMS       int
	EmbeddingP95LatencyWarnMS int
	RerankP95LatencyWarnMS    int
	GateRejectRateWarn        float64
	GatePenalizedRateWarn     float64
	ReportMinPairCount        int
	ReportMinPairErrorRate    float64
	CacheTTLSeconds           int
}

// PromptConfig is NewsPromptConfig.
type PromptConfig struct {
	Version                       string
	SystemPromptTemplate          string
	DenoisePromptTemplate         string
	UserPromptTemplate            string
	EntitySystemPromptTemplate    string
	EntityUserPromptTemplate      string
	SentimentSystemPromptTemplate string
	SentimentUserPromptTemplate   string
	KGSystemPromptTemplate        string
	KGUserPromptTemplate          string
}

// RuntimeConfig is PipelineRuntimeConfig (the merged env + config-file
// pipeline block).
type RuntimeConfig struct {
	ConfigPath                string
	CacheTTLSeconds           int
	MaxInputChars             int
	SummaryMaxTokens          int
	RateLimitWindowSeconds    int
	AllowMediaEmbedding       bool
	DetectLanguage            bool
	SummaryDedupEnabled       bool
	SummaryDedupThreshold     float64
	SummaryDedupLookbackHours int
	SummaryDedupMaxCandidates int
	SummaryDedupMinChars      int
	OutboxDeliveryConcurrency int
}

// LiteLLMConfig is LiteLlmConfig: the config-file and env LiteLLM defaults.
type LiteLLMConfig struct {
	Model          string
	EmbeddingModel string
	RerankModel    string
	APIURL         string
	APIKey         string
	TimeoutMS      int
	Temperature    float64
	TopP           float64
	MaxTokens      int
	RetryAttempts  int
	FallbackModels []string
	Stream         bool
	ResponseFormat string
}

// Crawl4AIConfig is Crawl4aiPipelineConfig.
type Crawl4AIConfig struct {
	UserAgent             string
	MaxConcurrent         int
	TimeoutMS             int
	KeywordMatchThreshold float64
	Markdown              json.RawMessage
	CleanMarkdown         json.RawMessage
	CrawlerDefaults       json.RawMessage
	VirtualScroll         json.RawMessage
}

// NewsPipelineConfig is NewsPipelineConfig (litellm + crawl4ai + pipeline).
type NewsPipelineConfig struct {
	LiteLLM  LiteLLMConfig
	Crawl4AI Crawl4AIConfig
	Pipeline RuntimeConfig
}

// StageContext is NewsStageContext: the job identity handed to the LLM stages.
type StageContext struct {
	OrgID string
	JobID string
}

// CleanLLMInput is the clean stage prompt input.
type CleanLLMInput struct {
	SystemPrompt        string
	DenoisePrompt       string
	UserPrompt          string
	CompletionTimeoutMS int
}

// EnrichmentInput is EnrichmentPromptInput.
type EnrichmentInput struct {
	Title    *string
	Summary  *string
	Markdown string
	Language *string
}

// DedupeInput is evaluateSummaryDedupe's input.
type DedupeInput struct {
	Job                Job
	Payload            NormalizedPayload
	Cleaned            CleanedNews
	ContentDuplicateOf *string
}

// SettingsProvider is the org-scoped settings surface (SettingsReader).
type SettingsProvider interface {
	Extraction(ctx context.Context, orgID string) ExtractionSettings
	Dedupe(ctx context.Context, orgID string) DedupeSettings
	PromptConfig(ctx context.Context) PromptConfig
}

// Models is the LiteLLM surface the pipeline calls. *litellmcompat.Client
// satisfies it; tests use a fake.
type Models interface {
	Completion(ctx context.Context, req litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error)
	Embedding(ctx context.Context, req litellmcompat.EmbeddingRequest) (litellmcompat.EmbeddingResponse, error)
	Rerank(ctx context.Context, req litellmcompat.RerankRequest) (litellmcompat.RerankResponse, error)
	RuntimeEmbeddingModel(ctx context.Context) (litellmcompat.RuntimeModel, error)
	RuntimeRerankModel(ctx context.Context) (litellmcompat.RuntimeModel, error)
	CompletionTimeoutMS(ctx context.Context) (int, error)
}

// CrawlExecutor is the in-process crawl execution port (crawlexecution.Service).
type CrawlExecutor interface {
	RunTask(ctx context.Context, orgID, taskID string) (crawlexecution.Summary, error)
}

// OutboxDispatcher is the #116 immediate processed_item delivery (bounded
// concurrency, failures compensated by the #116 scanner).
type OutboxDispatcher interface {
	DeliverNow(ctx context.Context, outboxID string) bool
}

// SnapshotRefresher is NewsSourceOpsSnapshotService.refreshSnapshotForSource.
type SnapshotRefresher interface {
	RefreshNewsSourceSnapshot(ctx context.Context, orgID, sourceID string) error
}

// Classifier is the imported news classifier surface. *newsclassifier.Session
// satisfies it. applyToCleanedNews is used through
// newsclassifier.ParseStoredCleanedNews(...).ApplyToCleanedNews(result), so the
// classifier owns the open-field-preserving result rewrite.
type Classifier interface {
	Classify(ctx context.Context, orgID string, cleaned newsclassifier.CleanedNews, options newsclassifier.Options) (newsclassifier.Result, error)
}

// Options wires the pipeline service. DB and Mongo are required; Crawl,
// Models, Vector and Outbox are required for the branches that use them.
type Options struct {
	DB         *sql.DB
	Mongo      *mongo.Database
	Redis      *redis.Client
	Config     NewsPipelineConfig
	Models     Models
	Crawl      CrawlExecutor
	Vector     vectorclient.Searcher
	Outbox     OutboxDispatcher
	Snapshots  SnapshotRefresher
	Classifier Classifier
	Now        func() time.Time
	Random     func() float64
	Logger     func(format string, args ...any)
}

func stringPointer(value string) *string {
	copy := value
	return &copy
}

func floatPointer(value float64) *float64 {
	copy := value
	return &copy
}

func intPointer(value int) *int {
	copy := value
	return &copy
}
