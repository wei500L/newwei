// Package crawloptions ports the NestJS crawl task option pipeline: the
// CreateCrawlTaskDto class-validator tree, CrawlExecutionService.normalizeOptions
// (crawl-options-normalizer.service.ts), the helpers in crawl-options.helpers.ts,
// the proxy and crawl4ai-LLM config policies, normalizeKeywords/coerceDate and
// CrawlTaskService.normalizeMarkdownFilter.
//
// The normalized Options struct mirrors the JSON NestJS persists in
// CrawlTask.config: field order follows the object literal in
// normalizeOptions, optional keys use omitempty exactly where JavaScript drops
// an undefined value, and explicit false/0 values stay present. Nullable
// business leaves use pointers; extension leaves use json.RawMessage.
package crawloptions

import "encoding/json"

// Options is the normalized CrawlTaskOptions document.
type Options struct {
	IncludeImages           bool                `json:"includeImages"`
	StoreMedia              bool                `json:"storeMedia"`
	OnlyMainContent         bool                `json:"onlyMainContent"`
	ExtractLinks            bool                `json:"extractLinks"`
	CacheMode               string              `json:"cacheMode"`
	Prefetch                bool                `json:"prefetch"`
	ScanFullPage            bool                `json:"scanFullPage"`
	AdjustViewportToContent bool                `json:"adjustViewportToContent"`
	ScrollDelayMs           *int                `json:"scrollDelayMs,omitempty"`
	Headless                *bool               `json:"headless,omitempty"`
	EnableUndetectedBrowser bool                `json:"enableUndetectedBrowser"`
	AntiBotMode             string              `json:"antiBotMode"`
	EnableStealthMode       bool                `json:"enableStealthMode"`
	UseManagedBrowser       bool                `json:"useManagedBrowser"`
	UserDataDir             *string             `json:"userDataDir,omitempty"`
	SimulateUser            bool                `json:"simulateUser"`
	OverrideNavigator       bool                `json:"overrideNavigator"`
	JSCode                  []string            `json:"jsCode,omitempty"`
	JSOnly                  bool                `json:"jsOnly"`
	WaitForSelector         *string             `json:"waitForSelector,omitempty"`
	WaitForScript           *string             `json:"waitForScript,omitempty"`
	WaitForTimeoutMs        *int                `json:"waitForTimeoutMs,omitempty"`
	WaitUntil               *string             `json:"waitUntil,omitempty"`
	PageTimeoutMs           *int                `json:"pageTimeoutMs,omitempty"`
	DelayBeforeReturnHTMLMs *int                `json:"delayBeforeReturnHtmlMs,omitempty"`
	MeanDelayMs             *int                `json:"meanDelayMs,omitempty"`
	MaxDelayRangeMs         *int                `json:"maxDelayRangeMs,omitempty"`
	SemaphoreCount          *int                `json:"semaphoreCount,omitempty"`
	ProxyConfig             *ProxyConfig        `json:"proxyConfig,omitempty"`
	ProxyURL                *string             `json:"proxyUrl,omitempty"`
	AdditionalURLs          []string            `json:"additionalUrls,omitempty"`
	MultiURLConfigs         []MultiURLConfig    `json:"multiUrlConfigs,omitempty"`
	MarkdownOptions         *MarkdownOptions    `json:"markdownOptions,omitempty"`
	MarkdownFilter          *MarkdownFilter     `json:"markdownFilter,omitempty"`
	MarkdownStrategy        *Strategy           `json:"markdownStrategy,omitempty"`
	TableScoreThreshold     *float64            `json:"tableScoreThreshold,omitempty"`
	TableExtraction         *Strategy           `json:"tableExtraction,omitempty"`
	CleanMarkdown           *CleanMarkdown      `json:"cleanMarkdown,omitempty"`
	ScoreLinks              bool                `json:"scoreLinks"`
	LinkPreview             *LinkPreviewOptions `json:"linkPreview,omitempty"`
	BrowserHeaders          []BrowserHeader     `json:"browserHeaders,omitempty"`
	BrowserCookies          []BrowserCookie     `json:"browserCookies,omitempty"`
	UserAgent               *string             `json:"userAgent,omitempty"`
	UserAgentMode           *string             `json:"userAgentMode,omitempty"`
	UserAgentGenerator      *UserAgentGenerator `json:"userAgentGenerator,omitempty"`
	Locale                  *string             `json:"locale,omitempty"`
	TimezoneID              *string             `json:"timezoneId,omitempty"`
	Geolocation             *Geolocation        `json:"geolocation,omitempty"`
	SessionID               *string             `json:"sessionId,omitempty"`
	StorageState            *string             `json:"storageState,omitempty"`
	WordCountThreshold      *int                `json:"wordCountThreshold,omitempty"`
	ExcludeExternalLinks    bool                `json:"excludeExternalLinks"`
	RemoveOverlayElements   bool                `json:"removeOverlayElements"`
	ProcessIframes          bool                `json:"processIframes"`
	TextMode                bool                `json:"textMode"`
	CaptureScreenshot       bool                `json:"captureScreenshot"`
	CSSSelector             *string             `json:"cssSelector,omitempty"`
	ExcludedTags            []string            `json:"excludedTags,omitempty"`
	VirtualScroll           *VirtualScroll      `json:"virtualScroll,omitempty"`
	ExcludeExternalImages   bool                `json:"excludeExternalImages"`
	WaitForImages           bool                `json:"waitForImages"`
	RemoveForms             bool                `json:"removeForms"`
	PageTypeHint            *string             `json:"pageTypeHint,omitempty"`
	AutoExpandDetails       bool                `json:"autoExpandDetails"`
	DetailExpansion         *DetailExpansion    `json:"detailExpansion,omitempty"`
	QualityProfile          string              `json:"qualityProfile"`
}

// OptionsInput is the optional-typed input of normalizeOptions. Every field is
// a pointer so an absent key stays distinguishable from an explicit false/0,
// which the ?? defaults depend on.
type OptionsInput struct {
	IncludeImages           *bool                    `json:"includeImages"`
	StoreMedia              *bool                    `json:"storeMedia"`
	OnlyMainContent         *bool                    `json:"onlyMainContent"`
	ExtractLinks            *bool                    `json:"extractLinks"`
	CacheMode               *string                  `json:"cacheMode"`
	Prefetch                *bool                    `json:"prefetch"`
	ScanFullPage            *bool                    `json:"scanFullPage"`
	AdjustViewportToContent *bool                    `json:"adjustViewportToContent"`
	ScrollDelayMs           *int                     `json:"scrollDelayMs"`
	Headless                *bool                    `json:"headless"`
	EnableUndetectedBrowser *bool                    `json:"enableUndetectedBrowser"`
	AntiBotMode             *string                  `json:"antiBotMode"`
	EnableStealthMode       *bool                    `json:"enableStealthMode"`
	UseManagedBrowser       *bool                    `json:"useManagedBrowser"`
	UserDataDir             *string                  `json:"userDataDir"`
	SimulateUser            *bool                    `json:"simulateUser"`
	OverrideNavigator       *bool                    `json:"overrideNavigator"`
	JSCode                  []string                 `json:"jsCode"`
	JSOnly                  *bool                    `json:"jsOnly"`
	WaitForSelector         *string                  `json:"waitForSelector"`
	WaitForScript           *string                  `json:"waitForScript"`
	WaitForTimeoutMs        *int                     `json:"waitForTimeoutMs"`
	WaitUntil               *string                  `json:"waitUntil"`
	PageTimeoutMs           *int                     `json:"pageTimeoutMs"`
	DelayBeforeReturnHTMLMs *int                     `json:"delayBeforeReturnHtmlMs"`
	MeanDelayMs             *int                     `json:"meanDelayMs"`
	MaxDelayRangeMs         *int                     `json:"maxDelayRangeMs"`
	SemaphoreCount          *int                     `json:"semaphoreCount"`
	ProxyConfig             *ProxyConfig             `json:"proxyConfig"`
	ProxyURL                *string                  `json:"proxyUrl"`
	AdditionalURLs          []string                 `json:"additionalUrls"`
	MultiURLConfigs         []MultiURLConfig         `json:"multiUrlConfigs"`
	MarkdownOptions         *MarkdownOptionsInput    `json:"markdownOptions"`
	MarkdownFilter          *MarkdownFilter          `json:"markdownFilter"`
	MarkdownStrategy        *MarkdownStrategyInput   `json:"markdownStrategy"`
	TableScoreThreshold     *float64                 `json:"tableScoreThreshold"`
	TableExtraction         *TableExtractionInput    `json:"tableExtraction"`
	CleanMarkdown           *CleanMarkdownInput      `json:"cleanMarkdown"`
	ScoreLinks              *bool                    `json:"scoreLinks"`
	LinkPreview             *LinkPreviewOptionsInput `json:"linkPreview"`
	BrowserHeaders          []BrowserHeader          `json:"browserHeaders"`
	BrowserCookies          []BrowserCookie          `json:"browserCookies"`
	UserAgent               *string                  `json:"userAgent"`
	UserAgentMode           *string                  `json:"userAgentMode"`
	UserAgentGenerator      *UserAgentGenerator      `json:"userAgentGenerator"`
	Locale                  *string                  `json:"locale"`
	TimezoneID              *string                  `json:"timezoneId"`
	Geolocation             *Geolocation             `json:"geolocation"`
	SessionID               *string                  `json:"sessionId"`
	StorageState            *string                  `json:"storageState"`
	WordCountThreshold      *int                     `json:"wordCountThreshold"`
	ExcludeExternalLinks    *bool                    `json:"excludeExternalLinks"`
	ExcludeExternalImages   *bool                    `json:"excludeExternalImages"`
	RemoveOverlayElements   *bool                    `json:"removeOverlayElements"`
	ProcessIframes          *bool                    `json:"processIframes"`
	TextMode                *bool                    `json:"textMode"`
	CaptureScreenshot       *bool                    `json:"captureScreenshot"`
	CSSSelector             *string                  `json:"cssSelector"`
	ExcludedTags            []string                 `json:"excludedTags"`
	VirtualScroll           *VirtualScroll           `json:"virtualScroll"`
	WaitForImages           *bool                    `json:"waitForImages"`
	RemoveForms             *bool                    `json:"removeForms"`
	PageTypeHint            *string                  `json:"pageTypeHint"`
	AutoExpandDetails       *bool                    `json:"autoExpandDetails"`
	DetailExpansion         *DetailExpansion         `json:"detailExpansion"`
	QualityProfile          *string                  `json:"qualityProfile"`
}

// ProxyConfig mirrors CrawlProxyConfig.
type ProxyConfig struct {
	Server   string  `json:"server"`
	Username *string `json:"username,omitempty"`
	Password *string `json:"password,omitempty"`
}

// MarkdownOptions mirrors CrawlMarkdownOptions.
type MarkdownOptions struct {
	ContentSource *string `json:"contentSource,omitempty"`
	IgnoreLinks   *bool   `json:"ignoreLinks,omitempty"`
	EscapeHTML    *bool   `json:"escapeHtml,omitempty"`
	Citations     *bool   `json:"citations,omitempty"`
	BodyWidth     *int    `json:"bodyWidth,omitempty"`
}

// MarkdownOptionsInput is the optional input form of MarkdownOptions.
type MarkdownOptionsInput struct {
	ContentSource *string `json:"contentSource"`
	IgnoreLinks   *bool   `json:"ignoreLinks"`
	EscapeHTML    *bool   `json:"escapeHtml"`
	Citations     *bool   `json:"citations"`
	BodyWidth     *int    `json:"bodyWidth"`
}

// MarkdownFilter mirrors CrawlMarkdownFilter in its normalized form.
type MarkdownFilter struct {
	Type             string   `json:"type"`
	Threshold        *float64 `json:"threshold,omitempty"`
	ThresholdType    *string  `json:"thresholdType,omitempty"`
	MinWordThreshold *int     `json:"minWordThreshold,omitempty"`
	UserQuery        *string  `json:"userQuery,omitempty"`
	BM25Threshold    *float64 `json:"bm25Threshold,omitempty"`
	Language         *string  `json:"language,omitempty"`
}

// Strategy mirrors CrawlMarkdownStrategy and CrawlTableExtractionStrategy.
type Strategy struct {
	Type   string          `json:"type"`
	Params json.RawMessage `json:"params,omitempty"`
}

// MarkdownStrategyInput is the optional input form of Strategy.
type MarkdownStrategyInput struct {
	Type   *string         `json:"type"`
	Params json.RawMessage `json:"params"`
}

// TableExtractionInput is the optional input form of the table strategy.
type TableExtractionInput struct {
	Type   *string         `json:"type"`
	Params json.RawMessage `json:"params"`
}

// CleanMarkdown mirrors CrawlCleanMarkdownOptions after normalizeOptions.
type CleanMarkdown struct {
	CSSSelector           *string  `json:"cssSelector,omitempty"`
	TargetElements        []string `json:"targetElements,omitempty"`
	ExcludedTags          []string `json:"excludedTags,omitempty"`
	RemoveOverlayElements *bool    `json:"removeOverlayElements,omitempty"`
	WordCountThreshold    *int     `json:"wordCountThreshold,omitempty"`
}

// CleanMarkdownInput is the optional input form of CleanMarkdown.
type CleanMarkdownInput struct {
	CSSSelector           *string  `json:"cssSelector"`
	TargetElements        []string `json:"targetElements"`
	ExcludedTags          []string `json:"excludedTags"`
	RemoveOverlayElements *bool    `json:"removeOverlayElements"`
	WordCountThreshold    *int     `json:"wordCountThreshold"`
}

// LinkPreviewOptions mirrors CrawlLinkPreviewOptions.
type LinkPreviewOptions struct {
	IncludeInternal *bool    `json:"includeInternal,omitempty"`
	IncludeExternal *bool    `json:"includeExternal,omitempty"`
	IncludeSocial   *bool    `json:"includeSocial,omitempty"`
	MaxLinks        *int     `json:"maxLinks,omitempty"`
	Concurrency     *int     `json:"concurrency,omitempty"`
	TimeoutSeconds  *int     `json:"timeoutSeconds,omitempty"`
	Query           *string  `json:"query,omitempty"`
	ScoreThreshold  *float64 `json:"scoreThreshold,omitempty"`
	Verbose         *bool    `json:"verbose,omitempty"`
	IncludePatterns []string `json:"includePatterns,omitempty"`
	ExcludePatterns []string `json:"excludePatterns,omitempty"`
}

// LinkPreviewOptionsInput is the optional input form of LinkPreviewOptions.
type LinkPreviewOptionsInput struct {
	IncludeInternal *bool    `json:"includeInternal"`
	IncludeExternal *bool    `json:"includeExternal"`
	IncludeSocial   *bool    `json:"includeSocial"`
	MaxLinks        *int     `json:"maxLinks"`
	Concurrency     *int     `json:"concurrency"`
	TimeoutSeconds  *int     `json:"timeoutSeconds"`
	Query           *string  `json:"query"`
	ScoreThreshold  *float64 `json:"scoreThreshold"`
	Verbose         *bool    `json:"verbose"`
	IncludePatterns []string `json:"includePatterns"`
	ExcludePatterns []string `json:"excludePatterns"`
}

// BrowserHeader mirrors CrawlBrowserHeader.
type BrowserHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// BrowserCookie mirrors CrawlBrowserCookie.
type BrowserCookie struct {
	Name   string  `json:"name"`
	Value  string  `json:"value"`
	Domain string  `json:"domain"`
	Path   *string `json:"path,omitempty"`
}

// UserAgentGenerator mirrors CrawlUserAgentGeneratorConfig.
type UserAgentGenerator struct {
	Platform   *string `json:"platform,omitempty"`
	Browser    *string `json:"browser,omitempty"`
	DeviceType *string `json:"deviceType,omitempty"`
	Locale     *string `json:"locale,omitempty"`
}

// Geolocation mirrors CrawlGeolocationConfig.
type Geolocation struct {
	Latitude  float64  `json:"latitude"`
	Longitude float64  `json:"longitude"`
	Accuracy  *float64 `json:"accuracy,omitempty"`
}

// VirtualScroll mirrors CrawlVirtualScrollConfig. ScrollBy is either a mode
// string or a numeric pixel count, matching the stored union.
type VirtualScroll struct {
	ContainerSelector string          `json:"containerSelector"`
	ScrollCount       *int            `json:"scrollCount,omitempty"`
	ScrollBy          json.RawMessage `json:"scrollBy,omitempty"`
	// ScrollByPixels is the DTO input that feeds scrollBy="pixels"; it is never
	// part of the normalized document.
	ScrollByPixels    *int `json:"-"`
	WaitAfterScrollMs *int `json:"waitAfterScrollMs,omitempty"`
}

// MultiURLConfig mirrors CrawlMultiUrlConfig.
type MultiURLConfig struct {
	Name    *string            `json:"name,omitempty"`
	Matcher *URLMatcher        `json:"matcher,omitempty"`
	URLs    []string           `json:"urls,omitempty"`
	Options *StrategyOverrides `json:"options,omitempty"`
}

// URLMatcher mirrors CrawlUrlMatcher.
type URLMatcher struct {
	MatchMode *string  `json:"matchMode,omitempty"`
	Patterns  []string `json:"patterns,omitempty"`
}

// DetailExpansion mirrors CrawlDetailExpansionOptions.
type DetailExpansion struct {
	MaxDetailUrls               *int     `json:"maxDetailUrls,omitempty"`
	MinRelevanceScore           *float64 `json:"minRelevanceScore,omitempty"`
	RequireSameDomain           *bool    `json:"requireSameDomain,omitempty"`
	AllowExternalLinks          *bool    `json:"allowExternalLinks,omitempty"`
	IncludeURLPatterns          []string `json:"includeUrlPatterns,omitempty"`
	ExcludeURLPatterns          []string `json:"excludeUrlPatterns,omitempty"`
	MinPublishTimeConfidence    *float64 `json:"minPublishTimeConfidence,omitempty"`
	PreferFitMarkdownForQuality *bool    `json:"preferFitMarkdownForQuality,omitempty"`
}

// StrategyOverrides mirrors the normalized CrawlStrategyOverrides object.
type StrategyOverrides struct {
	CacheMode               *string          `json:"cacheMode,omitempty"`
	OnlyMainContent         *bool            `json:"onlyMainContent,omitempty"`
	ExtractLinks            *bool            `json:"extractLinks,omitempty"`
	ScanFullPage            *bool            `json:"scanFullPage,omitempty"`
	AdjustViewportToContent *bool            `json:"adjustViewportToContent,omitempty"`
	ScrollDelayMs           *int             `json:"scrollDelayMs,omitempty"`
	SimulateUser            *bool            `json:"simulateUser,omitempty"`
	OverrideNavigator       *bool            `json:"overrideNavigator,omitempty"`
	JSCode                  []string         `json:"jsCode,omitempty"`
	JSOnly                  *bool            `json:"jsOnly,omitempty"`
	WaitForSelector         *string          `json:"waitForSelector,omitempty"`
	WaitForScript           *string          `json:"waitForScript,omitempty"`
	WaitUntil               *string          `json:"waitUntil,omitempty"`
	WaitForTimeoutMs        *int             `json:"waitForTimeoutMs,omitempty"`
	PageTimeoutMs           *int             `json:"pageTimeoutMs,omitempty"`
	DelayBeforeReturnHTMLMs *int             `json:"delayBeforeReturnHtmlMs,omitempty"`
	MeanDelayMs             *int             `json:"meanDelayMs,omitempty"`
	MaxDelayRangeMs         *int             `json:"maxDelayRangeMs,omitempty"`
	SemaphoreCount          *int             `json:"semaphoreCount,omitempty"`
	RemoveForms             *bool            `json:"removeForms,omitempty"`
	WordCountThreshold      *int             `json:"wordCountThreshold,omitempty"`
	ExcludeExternalLinks    *bool            `json:"excludeExternalLinks,omitempty"`
	ExcludeExternalImages   *bool            `json:"excludeExternalImages,omitempty"`
	RemoveOverlayElements   *bool            `json:"removeOverlayElements,omitempty"`
	ProcessIframes          *bool            `json:"processIframes,omitempty"`
	TextMode                *bool            `json:"textMode,omitempty"`
	WaitForImages           *bool            `json:"waitForImages,omitempty"`
	CaptureScreenshot       *bool            `json:"captureScreenshot,omitempty"`
	CSSSelector             *string          `json:"cssSelector,omitempty"`
	ExcludedTags            []string         `json:"excludedTags,omitempty"`
	VirtualScroll           *VirtualScroll   `json:"virtualScroll,omitempty"`
	PageTypeHint            *string          `json:"pageTypeHint,omitempty"`
	AutoExpandDetails       *bool            `json:"autoExpandDetails,omitempty"`
	DetailExpansion         *DetailExpansion `json:"detailExpansion,omitempty"`
	QualityProfile          *string          `json:"qualityProfile,omitempty"`
}

// CreateTaskInput is the validated CreateCrawlTaskDto. REST validation fills
// every field; the GraphQL create mutation fills the same struct with the
// GraphQL input mapping (timeRange.from/to become TimeRangeFrom/To).
type CreateTaskInput struct {
	URL           string
	DisplayName   *string
	IngestToItems *bool
	TimeRangeFrom *string
	TimeRangeTo   *string
	Concurrency   *int
	Keywords      []string
	Options       *OptionsInput
	// RawOptions is the options object exactly as submitted. The proxy policy
	// inspects key presence, which the typed form no longer carries.
	RawOptions json.RawMessage
}
