package crawl4ai

import (
	"encoding/json"
	"errors"
	"net/http"
)

// Options is the client configuration. It mirrors EnvService.crawl4aiConfig
// (apps/api/src/modules/config/config.service.ts:865-884): the base URL, the API
// key forwarded as the `x-api-key` header, the HTTP timeout ceiling, the health
// check TTL and the outbound SSRF proxy.
type Options struct {
	// BaseURL is CRAWL4AI_BASE_URL without a trailing slash. Empty means the
	// client is not configured; the discovery chain then reports deep discovery
	// as unavailable and list discovery falls back to raw HTML.
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
	// JSCodeEnabled is CRAWL4AI_JSCODE_ENABLED (default true). When false the
	// request drops jsCode exactly like normalizeJsCode.
	JSCodeEnabled bool
	// HTTPClient overrides the transport (tests). Nil builds the default.
	HTTPClient *http.Client
	// Now overrides the clock in Unix milliseconds (tests). Nil uses time.Now.
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

// BrowserHeader is one browser_config.params.headers entry.
type BrowserHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// BrowserCookie is one browser_config.params.cookies entry.
type BrowserCookie struct {
	Name   string  `json:"name"`
	Value  string  `json:"value"`
	Domain string  `json:"domain"`
	Path   *string `json:"path,omitempty"`
}

// VirtualScroll is CrawlVirtualScrollConfig.
type VirtualScroll struct {
	ContainerSelector string
	ScrollCount       *int
	// ScrollBy is "container_height" or "page_height" (the client maps
	// "viewport" to "page_height" and numeric values to their decimal string).
	ScrollBy *string
	// WaitAfterScrollMs is converted to seconds with two decimals.
	WaitAfterScrollMs *int
}

// LinkPreview is CrawlLinkPreviewOptions.
type LinkPreview struct {
	IncludeInternal *bool
	IncludeExternal *bool
	MaxLinks        *int
	Concurrency     *int
	TimeoutSeconds  *float64
	Query           *string
	ScoreThreshold  *float64
	Verbose         *bool
	IncludePatterns []string
	ExcludePatterns []string
}

// MarkdownOptions is CrawlMarkdownOptions (content_source/options payload).
type MarkdownOptions struct {
	ContentSource *string
	IgnoreLinks   *bool
	EscapeHTML    *bool
	Citations     *bool
	BodyWidth     *int
}

// MarkdownStrategy is CrawlMarkdownStrategy: a generator type plus raw params.
type MarkdownStrategy struct {
	Type   string
	Params json.RawMessage
}

// MarkdownFilter is CrawlMarkdownFilter. Type is "pruning" or "bm25".
type MarkdownFilter struct {
	Type             string
	Threshold        *float64
	ThresholdType    *string
	MinWordThreshold *int
	UserQuery        *string
	BM25Threshold    *float64
	Language         *string
}

// CleanMarkdown is CrawlCleanMarkdownOptions. The payload spreads these keys
// last, so they override the same-named crawler params.
type CleanMarkdown struct {
	CSSSelector           *string
	TargetElements        []string
	ExcludedTags          []string
	RemoveOverlayElements *bool
	WordCountThreshold    *int
}

// Component is a pass-through crawl4ai component (type + raw params).
type Component struct {
	Type   string
	Params json.RawMessage
}

// CrawlOptions is the normalized CrawlTaskOptions subset the request body
// builder reads. It is the Go equivalent of the object
// CrawlOptionsNormalizerService.normalizeOptions returns, for the fields that
// reach toHttpPayload. Zero values are meaningful: the normalizer resolves every
// default before the payload is built, so the payload builder only decides
// presence (always sent vs sent only when true).
type CrawlOptions struct {
	IncludeImages   bool
	StoreMedia      bool
	OnlyMainContent bool
	ExtractLinks    bool
	CacheMode       string
	Prefetch        bool
	ScoreLinks      bool
	QualityProfile  string

	ScanFullPage            bool
	AdjustViewportToContent bool
	ScrollDelayMs           *int
	Headless                *bool
	EnableStealthMode       bool
	EnableUndetectedBrowser bool
	UseManagedBrowser       bool
	UserDataDir             *string
	SimulateUser            bool
	OverrideNavigator       bool
	JSCode                  []string
	JSOnly                  bool
	WaitForSelector         *string
	WaitForScript           *string
	WaitForTimeoutMs        *int
	WaitUntil               *string
	PageTimeoutMs           *int
	DelayBeforeReturnHTMLMs *int
	MeanDelayMs             *int
	MaxDelayRangeMs         *int
	SemaphoreCount          *int

	MarkdownOptions     *MarkdownOptions
	MarkdownFilter      *MarkdownFilter
	MarkdownStrategy    *MarkdownStrategy
	TableScoreThreshold *float64
	TableExtraction     *Component
	CleanMarkdown       *CleanMarkdown
	LinkPreview         *LinkPreview
	BrowserHeaders      []BrowserHeader
	BrowserCookies      []BrowserCookie
	UserAgent           *string
	UserAgentMode       *string
	Locale              *string
	TimezoneID          *string
	SessionID           *string
	StorageState        *string
	WordCountThreshold  *int

	ExcludeExternalLinks  bool
	RemoveOverlayElements bool
	ProcessIframes        bool
	TextMode              bool
	CaptureScreenshot     bool
	CSSSelector           *string
	ExcludedTags          []string
	VirtualScroll         *VirtualScroll
	ExcludeExternalImages bool
	WaitForImages         bool
	RemoveForms           bool
	DeepCrawlStrategy     *Component
}

// SystemEvent is one crawl4ai systemEvents entry.
type SystemEvent struct {
	Level         string          `json:"level"`
	EventType     string          `json:"eventType"`
	Message       string          `json:"message"`
	TriggerReason *string         `json:"triggerReason,omitempty"`
	BeforeCount   *int            `json:"beforeCount,omitempty"`
	AfterCount    *int            `json:"afterCount,omitempty"`
	RescuedCount  *int            `json:"rescuedCount,omitempty"`
	Details       json.RawMessage `json:"details,omitempty"`
	Timestamp     string          `json:"timestamp"`
}

// Link is one element of a crawl4ai links bucket. crawl4ai returns link objects
// whose keys vary by server version, so the fields the discovery chain reads are
// normalized here.
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
//
// It unwraps with errors.As on purpose: the execution service and the crawl
// worker wrap client errors with %w for context and retry telemetry, and the
// retryable-status decision must still see the upstream status.
func StatusOf(err error) int {
	var typed *Error
	if errors.As(err, &typed) && typed != nil {
		return typed.Status
	}
	return 0
}
