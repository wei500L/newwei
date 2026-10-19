package crawl4ai

import (
	"encoding/json"
	"net/http"
)

// Options is the client configuration. It mirrors EnvService.crawl4aiConfig
// (apps/api/src/modules/config/config.service.ts): the base URL, the API key
// forwarded as the `x-api-key` header, the HTTP timeout ceiling, the health
// check TTL and the outbound SSRF proxy.
type Options struct {
	// BaseURL is CRAWL4AI_BASE_URL without a trailing slash. Empty means the
	// client is not configured; Crawl then fails like an unreachable service.
	BaseURL string
	// APIKey is CRAWL4AI_API_KEY, sent as `x-api-key` when non-empty.
	APIKey string
	// TimeoutMs is CRAWL4AI_TIMEOUT_MS: the transport timeout ceiling.
	TimeoutMs int
	// HealthCheckTTLMs is CRAWL4AI_HEALTH_CHECK_TTL_MS.
	HealthCheckTTLMs int
	// SSRFProxyURL is CRAWL4AI_SSRF_PROXY_URL; when set it is forwarded as
	// browser_config.params.proxy for every request, exactly like
	// resolveBrowserProxy.
	SSRFProxyURL string
	// HTTPClient overrides the transport (tests). Nil builds the default.
	HTTPClient *http.Client
	// Now overrides the clock (tests). Nil uses time.Now.
	Now func() int64
}

// Configured reports whether a base URL is present. The discovery chain treats
// an unconfigured client as unavailable: deep discovery returns
// SEED_DEEP_CRAWL4AI_UNAVAILABLE and list discovery falls back to raw HTML.
func (o Options) Configured() bool { return o.BaseURL != "" }

// CrawlRequest is one /crawl call. URL is the single primary target; the
// discovery chain never sends additional URLs.
type CrawlRequest struct {
	URL string
	// Keywords are forwarded as the top-level `keywords` array.
	Keywords []string
	// Options are the normalized crawl options (see CrawlOptions).
	Options CrawlOptions
	// RequestTimeoutMs overrides the settings timeout for this call.
	RequestTimeoutMs int
}

// VirtualScroll is the CrawlVirtualScrollConfig subset.
type VirtualScroll struct {
	ContainerSelector string
	ScrollCount       int
	// ScrollBy is "page_height", "full_page" or a pixel preset such as "800".
	ScrollBy string
	// WaitAfterScrollMs is converted to seconds with two decimals.
	WaitAfterScrollMs *int
}

// LinkPreview is the CrawlLinkPreviewConfig subset used by deep discovery.
type LinkPreview struct {
	IncludeInternal bool
	IncludeExternal bool
	MaxLinks        *int
	Concurrency     *int
	TimeoutSeconds  *float64
	Query           *string
	ScoreThreshold  *float64
	Verbose         *bool
	IncludePatterns []string
	ExcludePatterns []string
}

// MarkdownStrategy is a pass-through markdown generator type plus raw params.
// The discovery chain never sets it; it is forwarded byte-for-byte when a saved
// workflow node config carries one.
type MarkdownStrategy struct {
	Type   string
	Params json.RawMessage
}

// MarkdownFilter is CrawlMarkdownFilter. Type is "pruning" or "bm25".
type MarkdownFilter struct {
	Type            string
	Threshold       *float64
	ThresholdType   *string
	MinWordThresh   *int
	UserQuery       *string
	BM25Threshold   *float64
	BM25Language    *string
	OnlyMainContent bool
}

// CleanMarkdown is CrawlCleanMarkdownOptions.
type CleanMarkdown struct {
	CSSSelector           *string
	TargetElements        []string
	ExcludedTags          []string
	RemoveOverlayElements *bool
	WordCountThreshold    *int
}

// CrawlOptions is the typed subset of CrawlTaskOptions the payload builder
// reads. Pointer fields distinguish "absent" (nil, omitted from the payload)
// from an explicit false/zero, which the source sends as-is.
//
// Not ported: quality-profile- and media-derived defaults (markdown/clean
// markdown defaults, media capture, user agent generator, cookies, geolocation,
// table extraction, multi-URL configurations). The discovery chain reads only
// `url`, `success` and `links` from every result, so markdown-output parameters
// cannot change discovery candidates; multi-URL configurations and custom
// proxies stay rejected before the request is built (see AssertNoUnsupportedProxy).
type CrawlOptions struct {
	CacheMode *string
	Prefetch  *bool
	// ScoreLinks maps to crawler_config.params.score_links.
	ScoreLinks *bool

	ScanFullPage            *bool
	AdjustViewportToContent *bool
	ScrollDelayMs           *int
	VirtualScroll           *VirtualScroll

	SimulateUser          *bool
	OverrideNavigator     *bool
	EnableStealthMode     *bool
	EnableUndetected      *bool
	Headless              *bool
	UseManagedBrowser     *bool
	UserDataDir           *string
	StorageState          *string
	IncludeImages         *bool
	RemoveForms           *bool
	TextMode              *bool
	CaptureScreenshot     *bool
	WaitForImages         *bool
	ExcludeExternalImgs   *bool
	ExcludeExternalLinks  *bool
	RemoveOverlayElements *bool
	ProcessIframes        *bool
	CSSSelector           *string
	ExcludedTags          []string
	WordCountThreshold    *int

	WaitUntil               *string
	WaitForTimeoutMs        *int
	PageTimeoutMs           *int
	DelayBeforeReturnHtmlMs *int
	MeanDelayMs             *int
	MaxDelayRangeMs         *int
	SemaphoreCount          *int
	SessionID               *string
	UserAgent               *string
	Locale                  *string
	TimezoneID              *string
	JSCode                  []string
	JSOnly                  *bool
	WaitForSelector         *string
	WaitForScript           *string
	TableScoreThreshold     *float64
	DeepCrawlStrategy       json.RawMessage

	MarkdownStrategy *MarkdownStrategy
	MarkdownFilter   *MarkdownFilter
	CleanMarkdown    *CleanMarkdown
	LinkPreview      *LinkPreview
	BrowserHeaders   map[string]string
}

// SystemEvent is one crawl4ai systemEvents entry.
type SystemEvent struct {
	Level         string          `json:"level"`
	EventType     string          `json:"eventType"`
	Message       string          `json:"message"`
	TriggerReason *string         `json:"triggerReason"`
	BeforeCount   *int            `json:"beforeCount"`
	AfterCount    *int            `json:"afterCount"`
	RescuedCount  *int            `json:"rescuedCount"`
	Details       json.RawMessage `json:"details"`
	Timestamp     string          `json:"timestamp"`
}

// Link is one element of a crawl4ai links bucket. crawl4ai returns link objects
// whose keys vary by server version, so the raw object is kept together with the
// fields the discovery chain reads.
type Link struct {
	Href            string
	Text            string
	Title           string
	Rel             string
	TotalScore      *float64
	ContextualScore *float64
	IntrinsicScore  *float64
}

// Article is one crawl4ai result set entry.
type Article struct {
	URL        string
	Success    *bool
	StatusCode *int
	Error      string
	// Links are the link buckets (internal/external) flattened into one slice;
	// the bucket name is irrelevant to discovery.
	Links []Link
	// Markdown is the cleaned markdown body when the server returned one.
	Markdown string
	// Metadata is the raw metadata object.
	Metadata json.RawMessage
}

// Response is the normalized /crawl response: results plus the warning and
// system-event envelope.
type Response struct {
	Results      []Article
	Warnings     []string
	SystemEvents []SystemEvent
}

// Error is a classified crawl4ai failure. Status mirrors the HTTPException
// status the NestJS Crawl4aiRequestException would surface: 400 for a blocked
// URL, 408 for a timeout, the upstream status otherwise, and 0 when the request
// never reached the service (connection error). Message is already formatted
// with the same hints the NestJS client appends.
type Error struct {
	Message string
	Status  int
}

func (e *Error) Error() string { return e.Message }

func newError(status int, message string) *Error {
	return &Error{Status: status, Message: message}
}

// StatusOf returns the HTTP status carried by err, or 0 when err is not a
// classified crawl4ai error.
func StatusOf(err error) int {
	if typed, ok := err.(*Error); ok {
		return typed.Status
	}
	return 0
}
