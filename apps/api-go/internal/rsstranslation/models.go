package rsstranslation

// This file holds the strongly typed request/response contract of the
// translateRssItems mutation. The GraphQL adapter owns SDL validation and
// maps these values one to one onto the registered models.

// Provider is the GraphQL RssTranslationProvider enum member.
type Provider string

const (
	// ProviderDeepLx is the DeepLX primary/fallback provider.
	ProviderDeepLx Provider = "deeplx"
	// ProviderLLM is the LLM gateway provider.
	ProviderLLM Provider = "llm"
)

// Field is the GraphQL RssTranslationField enum member.
type Field string

const (
	// FieldTitle translates the stored title (or headline).
	FieldTitle Field = "title"
	// FieldSummary translates the stored summary (or abstract).
	FieldSummary Field = "summary"
	// FieldKeyPoints translates the stored key_points list.
	FieldKeyPoints Field = "key_points"
	// FieldCleanedMarkdown translates the stored cleaned_markdown document.
	FieldCleanedMarkdown Field = "cleaned_markdown"
)

// DefaultFieldSet is the field projection when the caller omits fields, sends
// null, or sends an empty list. An explicit empty list is not "translate
// nothing": it uses this set, exactly like the NestJS normalizeFields.
var DefaultFieldSet = []Field{FieldTitle, FieldSummary, FieldKeyPoints}

// TranslateInput is the validated mutation input. The adapter has already
// applied the SDL/class-validator constraints; the service still re-applies the
// item id normalization and the 50 item limit.
type TranslateInput struct {
	ItemIDs        []string
	Provider       Provider
	TargetLanguage string
	Fields         []Field
}

// ItemTranslation is one projected item. A nil field is projected as GraphQL
// null: a field that was not requested or whose source value is missing is
// never replaced with an empty string or an empty list.
type ItemTranslation struct {
	ItemID          string
	Title           *string
	Summary         *string
	KeyPoints       *[]string
	CleanedMarkdown *string
}

// TranslateResult is the mutation payload. Translations may be an empty list;
// its order follows the normalized itemIds order.
type TranslateResult struct {
	Provider       Provider
	TargetLanguage string
	Translations   []ItemTranslation
}

// RequestError is a client-visible failure that mirrors a NestJS
// BadRequestException: the GraphQL adapter maps it onto contract.Failure. Any
// other error becomes the masked internal server error.
type RequestError struct {
	Message string
	Status  int
}

func (e *RequestError) Error() string { return e.Message }

// metricsAccumulator mirrors RssTranslationMetricsAccumulator. The counters are
// incremented at the same three levels as NestJS: one request per mutation
// call, one item per normalized item id, and one cache/translation event per
// deduplicated text inside one translateTextList call.
type metricsAccumulator struct {
	requestCount     int
	itemCount        int
	textCount        int
	cacheHitCount    int
	cacheMissCount   int
	translatedCount  int
	failureCount     int
	skipTooLongCount int
}

func newMetricsAccumulator(itemCount int) *metricsAccumulator {
	return &metricsAccumulator{requestCount: 1, itemCount: itemCount}
}

// translateOptions is the per-request state threaded through the field
// translation helpers.
type translateOptions struct {
	orgID          string
	provider       Provider
	targetLanguage string
	llmModel       *string
	llmConcurrency int
	metrics        *metricsAccumulator
}

// DeepLX translation runtime, resolved per request from the shared cache.
const (
	defaultDeepLxTimeoutMs     = 15_000
	defaultDeepLxMaxRetries    = 2
	defaultLLMConcurrency      = 2
	maxLLMConcurrency          = 20
	translationRetryBackoffMs  = 300
	rssCachePrefix             = "rss:translation:v1"
	rssCacheTTLSeconds         = 60 * 60 * 24 * 7
	deepLxInnerCachePrefix     = "situation-monitor:translation:v3:zh-cn:multi:"
	deepLxInnerCacheTTLSeconds = 60 * 60 * 24 * 30
)
