package crawl4ai

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"strings"
)

// This file ports Crawl4aiClient.toHttpPayload (crawl4ai.client.ts:850-1036) for
// the discovery subset. Presence follows the NestJS `compact` helper: a key is
// sent when the compacted value differs from undefined, so flags that are only
// ever forwarded when true use a nil pointer, while flags the normalizer always
// resolves to a boolean use a non-nil pointer set to that boolean.

type httpPayload struct {
	URLs        []string  `json:"urls"`
	Keywords    []string  `json:"keywords,omitempty"`
	BrowserConf component `json:"browser_config"`
	CrawlerConf component `json:"crawler_config"`
}

type component struct {
	Type   string `json:"type"`
	Params any    `json:"params,omitempty"`
}

type browserParams struct {
	Headless             *bool             `json:"headless,omitempty"`
	EnableStealth        *bool             `json:"enable_stealth,omitempty"`
	BrowserType          string            `json:"browser_type,omitempty"`
	LightMode            *bool             `json:"light_mode,omitempty"`
	UseManagedBrowser    *bool             `json:"use_managed_browser,omitempty"`
	UsePersistentContext *bool             `json:"use_persistent_context,omitempty"`
	UserDataDir          *string           `json:"user_data_dir,omitempty"`
	Proxy                string            `json:"proxy,omitempty"`
	Headers              map[string]string `json:"headers,omitempty"`
	Cookies              []BrowserCookie   `json:"cookies,omitempty"`
	UserAgent            *string           `json:"user_agent,omitempty"`
	UserAgentMode        *string           `json:"user_agent_mode,omitempty"`
	StorageState         json.RawMessage   `json:"storage_state,omitempty"`
}

type crawlerParams struct {
	CacheMode               string          `json:"cache_mode"`
	Prefetch                *bool           `json:"prefetch,omitempty"`
	ScanFullPage            *bool           `json:"scan_full_page"`
	AdjustViewportToContent *bool           `json:"adjust_viewport_to_content,omitempty"`
	ScrollDelay             *float64        `json:"scroll_delay,omitempty"`
	SimulateUser            *bool           `json:"simulate_user"`
	OverrideNavigator       *bool           `json:"override_navigator"`
	Magic                   *bool           `json:"magic"`
	MarkdownGenerator       *component      `json:"markdown_generator,omitempty"`
	ScoreLinks              *bool           `json:"score_links,omitempty"`
	LinkPreviewConfig       *component      `json:"link_preview_config,omitempty"`
	UserAgent               *string         `json:"user_agent,omitempty"`
	UserAgentMode           *string         `json:"user_agent_mode,omitempty"`
	Locale                  *string         `json:"locale,omitempty"`
	TimezoneID              *string         `json:"timezone_id,omitempty"`
	JSCode                  json.RawMessage `json:"js_code,omitempty"`
	JSOnly                  *bool           `json:"js_only,omitempty"`
	WaitFor                 string          `json:"wait_for,omitempty"`
	WaitForTimeout          *int            `json:"wait_for_timeout,omitempty"`
	WaitUntil               string          `json:"wait_until,omitempty"`
	PageTimeout             *int            `json:"page_timeout,omitempty"`
	DelayBeforeReturnHTML   *float64        `json:"delay_before_return_html,omitempty"`
	MeanDelay               *float64        `json:"mean_delay,omitempty"`
	MaxRange                *float64        `json:"max_range,omitempty"`
	SemaphoreCount          *int            `json:"semaphore_count,omitempty"`
	CheckRobotsTxt          bool            `json:"check_robots_txt"`
	RemoveForms             *bool           `json:"remove_forms,omitempty"`
	SessionID               *string         `json:"session_id,omitempty"`
	TableScoreThreshold     *float64        `json:"table_score_threshold,omitempty"`
	DeepCrawlStrategy       *component      `json:"deep_crawl_strategy,omitempty"`
	WordCountThreshold      *int            `json:"word_count_threshold"`
	ExcludeExternalLinks    *bool           `json:"exclude_external_links"`
	ExcludeExternalImages   *bool           `json:"exclude_external_images"`
	RemoveOverlayElements   *bool           `json:"remove_overlay_elements"`
	ProcessIframes          *bool           `json:"process_iframes"`
	CSSSelector             string          `json:"css_selector,omitempty"`
	TargetElements          []string        `json:"target_elements,omitempty"`
	ExcludedTags            []string        `json:"excluded_tags,omitempty"`
	WaitForImages           *bool           `json:"wait_for_images,omitempty"`
	OnlyText                *bool           `json:"only_text,omitempty"`
	Screenshot              *bool           `json:"screenshot,omitempty"`
	VirtualScrollConfig     *component      `json:"virtual_scroll_config,omitempty"`
}

type markdownOptionsPayload struct {
	IgnoreLinks *bool `json:"ignore_links,omitempty"`
	EscapeHTML  *bool `json:"escape_html,omitempty"`
	Citations   *bool `json:"citations,omitempty"`
	BodyWidth   *int  `json:"body_width,omitempty"`
}

type linkPreviewPayload struct {
	IncludeInternal *bool    `json:"include_internal,omitempty"`
	IncludeExternal *bool    `json:"include_external,omitempty"`
	MaxLinks        *int     `json:"max_links,omitempty"`
	Concurrency     *int     `json:"concurrency,omitempty"`
	Timeout         *float64 `json:"timeout,omitempty"`
	Query           *string  `json:"query,omitempty"`
	ScoreThreshold  *float64 `json:"score_threshold,omitempty"`
	Verbose         *bool    `json:"verbose,omitempty"`
	IncludePatterns []string `json:"include_patterns,omitempty"`
	ExcludePatterns []string `json:"exclude_patterns,omitempty"`
}

type contentFilterPayload struct {
	Type   string       `json:"type"`
	Params filterParams `json:"params"`
}

type markdownGeneratorPayload struct {
	ContentSource *string                 `json:"content_source,omitempty"`
	Options       *markdownOptionsPayload `json:"options,omitempty"`
	ContentFilter *contentFilterPayload   `json:"content_filter,omitempty"`
}

type filterParams struct {
	Threshold        *float64 `json:"threshold,omitempty"`
	ThresholdType    *string  `json:"threshold_type,omitempty"`
	MinWordThreshold *int     `json:"min_word_threshold,omitempty"`
	UserQuery        *string  `json:"user_query,omitempty"`
	BM25Threshold    *float64 `json:"bm25_threshold,omitempty"`
	Language         *string  `json:"language,omitempty"`
}

type virtualScrollParams struct {
	ContainerSelector string   `json:"container_selector,omitempty"`
	ScrollCount       *int     `json:"scroll_count,omitempty"`
	ScrollBy          *string  `json:"scroll_by,omitempty"`
	WaitAfterScroll   *float64 `json:"wait_after_scroll,omitempty"`
}

// buildPayload mirrors toHttpPayload. It returns an error only for the jsCode
// guard, which the NestJS client raises before the request is issued.
func buildPayload(request CrawlRequest, ssrfProxyURL string, jsCodeEnabled bool) (httpPayload, error) {
	options := request.Options
	target := strings.TrimSpace(request.URL)

	jsCodePayload, err := buildJSCodePayload(options.JSCode, jsCodeEnabled)
	if err != nil {
		return httpPayload{}, err
	}

	browserType := ""
	if options.EnableUndetectedBrowser {
		browserType = "undetected"
	}
	var lightMode *bool
	if !options.IncludeImages {
		enabled := true
		lightMode = &enabled
	}
	useManagedBrowser := options.UseManagedBrowser
	usePersistentContext := useManagedBrowser || (options.UserDataDir != nil && *options.UserDataDir != "")

	headers := map[string]string{}
	for _, header := range options.BrowserHeaders {
		headers[header.Name] = header.Value
	}
	if len(headers) == 0 {
		headers = nil
	}

	scanFullPage := options.ScanFullPage
	var scrollDelay *float64
	if scanFullPage && options.ScrollDelayMs != nil {
		scrollDelay = secondsPtr(clampInt(*options.ScrollDelayMs, 0, 5000))
	}

	crawler := crawlerParams{
		CacheMode:               cacheMode(options.CacheMode),
		Prefetch:                boolOnlyTrue(options.Prefetch),
		ScanFullPage:            boolPtr(scanFullPage),
		AdjustViewportToContent: boolOnlyTrue(options.AdjustViewportToContent),
		ScrollDelay:             scrollDelay,
		SimulateUser:            boolPtr(options.SimulateUser),
		OverrideNavigator:       boolPtr(options.OverrideNavigator),
		Magic:                   boolPtr(options.EnableStealthMode),
		MarkdownGenerator:       buildMarkdownGenerator(options),
		ScoreLinks:              boolOnlyTrue(options.ScoreLinks),
		LinkPreviewConfig:       buildLinkPreviewConfig(options.LinkPreview),
		UserAgent:               options.UserAgent,
		UserAgentMode:           options.UserAgentMode,
		Locale:                  options.Locale,
		TimezoneID:              options.TimezoneID,
		JSCode:                  jsCodePayload,
		JSOnly:                  boolOnlyTrue(options.JSOnly),
		WaitFor:                 buildWaitFor(options),
		WaitForTimeout:          normalizeWaitForTimeoutForPayload(options.WaitForTimeoutMs, options.WaitUntil),
		WaitUntil:               stringOrEmpty(options.WaitUntil),
		PageTimeout:             options.PageTimeoutMs,
		DelayBeforeReturnHTML:   millisToSeconds(options.DelayBeforeReturnHTMLMs, 0, 30000),
		MeanDelay:               millisToSeconds(options.MeanDelayMs, 0, 10000),
		MaxRange:                millisToSeconds(options.MaxDelayRangeMs, 0, 10000),
		SemaphoreCount:          options.SemaphoreCount,
		CheckRobotsTxt:          false,
		RemoveForms:             boolOnlyTrue(options.RemoveForms),
		SessionID:               options.SessionID,
		TableScoreThreshold:     options.TableScoreThreshold,
		DeepCrawlStrategy:       buildComponent(options.DeepCrawlStrategy),
		WordCountThreshold:      options.WordCountThreshold,
		ExcludeExternalLinks:    boolPtr(options.ExcludeExternalLinks),
		ExcludeExternalImages:   boolPtr(options.ExcludeExternalImages),
		RemoveOverlayElements:   boolPtr(options.RemoveOverlayElements),
		ProcessIframes:          boolPtr(options.ProcessIframes),
		CSSSelector:             stringOrEmpty(options.CSSSelector),
		ExcludedTags:            options.ExcludedTags,
		WaitForImages:           boolOnlyTrue(options.WaitForImages),
		OnlyText:                boolOnlyTrue(options.TextMode),
		Screenshot:              boolOnlyTrue(options.CaptureScreenshot),
		VirtualScrollConfig:     buildVirtualScrollConfig(options.VirtualScroll),
	}
	applyCleanMarkdown(&crawler, options.CleanMarkdown)

	return httpPayload{
		URLs:     []string{target},
		Keywords: request.Keywords,
		BrowserConf: component{Type: "BrowserConfig", Params: browserParams{
			Headless:             options.Headless,
			EnableStealth:        boolPtr(options.EnableStealthMode),
			BrowserType:          browserType,
			LightMode:            lightMode,
			UseManagedBrowser:    boolOnlyTrue(useManagedBrowser),
			UsePersistentContext: boolOnlyTrue(usePersistentContext),
			UserDataDir:          options.UserDataDir,
			Proxy:                ssrfProxy(ssrfProxyURL),
			Headers:              headers,
			Cookies:              options.BrowserCookies,
			UserAgent:            options.UserAgent,
			UserAgentMode:        options.UserAgentMode,
			StorageState:         buildStorageState(options.StorageState),
		}},
		CrawlerConf: component{Type: "CrawlerRunConfig", Params: crawler},
	}, nil
}

// applyCleanMarkdown spreads the clean-markdown payload last, overriding the
// keys it shares with the main crawler params, exactly like `...(cleanMarkdown
// ?? {})`.
func applyCleanMarkdown(params *crawlerParams, clean *CleanMarkdown) {
	if clean == nil {
		return
	}
	if selector := normalizeTrimmedString(clean.CSSSelector); selector != nil && *selector != "" {
		params.CSSSelector = *selector
	}
	if len(clean.TargetElements) > 0 {
		params.TargetElements = clean.TargetElements
	}
	if tags := normalizeSelectorValues(clean.ExcludedTags); len(tags) > 0 {
		params.ExcludedTags = tags
	}
	if clean.RemoveOverlayElements != nil {
		params.RemoveOverlayElements = clean.RemoveOverlayElements
	}
	if clean.WordCountThreshold != nil {
		clamped := clampInt(*clean.WordCountThreshold, 0, 5000)
		params.WordCountThreshold = &clamped
	}
}

func buildVirtualScrollConfig(config *VirtualScroll) *component {
	if config == nil {
		return nil
	}
	params := virtualScrollParams{ContainerSelector: config.ContainerSelector}
	params.ScrollCount = config.ScrollCount
	params.ScrollBy = config.ScrollBy
	if config.WaitAfterScrollMs != nil {
		clamped := clampInt(*config.WaitAfterScrollMs, 0, 60000)
		value := roundTo(float64(clamped)/1000, 2)
		params.WaitAfterScroll = &value
	}
	if params.ContainerSelector == "" && params.ScrollCount == nil && params.ScrollBy == nil && params.WaitAfterScroll == nil {
		return nil
	}
	return &component{Type: "VirtualScrollConfig", Params: params}
}

func buildMarkdownGenerator(options CrawlOptions) *component {
	if strategy := options.MarkdownStrategy; strategy != nil && strings.TrimSpace(strategy.Type) != "" {
		if len(strategy.Params) > 0 && json.Valid(strategy.Params) && string(strategy.Params) != "{}" && string(strategy.Params) != "null" {
			return &component{Type: strings.TrimSpace(strategy.Type), Params: json.RawMessage(strategy.Params)}
		}
		return &component{Type: strings.TrimSpace(strategy.Type)}
	}
	contentFilter := options.MarkdownFilter
	if contentFilter == nil && options.OnlyMainContent {
		thresholdType := "dynamic"
		contentFilter = &MarkdownFilter{Type: "pruning", ThresholdType: &thresholdType, MinWordThreshold: options.WordCountThreshold}
	}
	params := markdownGeneratorPayload{}
	if options.MarkdownOptions != nil && options.MarkdownOptions.ContentSource != nil {
		params.ContentSource = options.MarkdownOptions.ContentSource
	}
	params.Options = buildMarkdownOptionsPayload(options.MarkdownOptions)
	params.ContentFilter = buildContentFilterPayload(contentFilter)
	if params.ContentSource == nil && params.Options == nil && params.ContentFilter == nil {
		return nil
	}
	return &component{Type: "DefaultMarkdownGenerator", Params: params}
}

func buildMarkdownOptionsPayload(options *MarkdownOptions) *markdownOptionsPayload {
	if options == nil {
		return nil
	}
	payload := markdownOptionsPayload{
		IgnoreLinks: options.IgnoreLinks,
		EscapeHTML:  options.EscapeHTML,
		Citations:   options.Citations,
		BodyWidth:   options.BodyWidth,
	}
	if payload.IgnoreLinks == nil && payload.EscapeHTML == nil && payload.Citations == nil && payload.BodyWidth == nil {
		return nil
	}
	return &payload
}

func buildContentFilterPayload(filter *MarkdownFilter) *contentFilterPayload {
	if filter == nil {
		return nil
	}
	switch filter.Type {
	case "pruning":
		return &contentFilterPayload{Type: "PruningContentFilter", Params: filterParams{
			Threshold:        filter.Threshold,
			ThresholdType:    filter.ThresholdType,
			MinWordThreshold: filter.MinWordThreshold,
		}}
	case "bm25":
		query := ""
		if filter.UserQuery != nil {
			query = strings.TrimSpace(*filter.UserQuery)
		}
		if query == "" {
			return nil
		}
		userQuery := query
		return &contentFilterPayload{Type: "BM25ContentFilter", Params: filterParams{
			UserQuery:     &userQuery,
			BM25Threshold: filter.BM25Threshold,
			Language:      filter.Language,
		}}
	}
	return nil
}

func buildLinkPreviewConfig(config *LinkPreview) *component {
	if config == nil {
		return nil
	}
	payload := linkPreviewPayload{
		IncludeInternal: config.IncludeInternal,
		IncludeExternal: config.IncludeExternal,
		MaxLinks:        config.MaxLinks,
		Concurrency:     config.Concurrency,
		Timeout:         config.TimeoutSeconds,
		Query:           normalizeTrimmedString(config.Query),
		ScoreThreshold:  roundFloatPtr(config.ScoreThreshold, 3),
		Verbose:         config.Verbose,
		IncludePatterns: config.IncludePatterns,
		ExcludePatterns: config.ExcludePatterns,
	}
	if payload.IncludeInternal == nil && payload.IncludeExternal == nil && payload.MaxLinks == nil &&
		payload.Concurrency == nil && payload.Timeout == nil && payload.Query == nil &&
		payload.ScoreThreshold == nil && payload.Verbose == nil &&
		len(payload.IncludePatterns) == 0 && len(payload.ExcludePatterns) == 0 {
		return nil
	}
	return &component{Type: "LinkPreviewConfig", Params: payload}
}

func buildComponent(input *Component) *component {
	if input == nil || strings.TrimSpace(input.Type) == "" {
		return nil
	}
	if len(input.Params) > 0 && json.Valid(input.Params) && string(input.Params) != "{}" && string(input.Params) != "null" {
		return &component{Type: strings.TrimSpace(input.Type), Params: json.RawMessage(input.Params)}
	}
	return &component{Type: strings.TrimSpace(input.Type)}
}

// buildWaitFor mirrors buildWaitFor: `js:` for a script, `css:`/`xpath:`
// prefixes for a selector.
func buildWaitFor(options CrawlOptions) string {
	if script := trimmedString(options.WaitForScript); script != "" {
		if strings.HasPrefix(script, "js:") {
			return script
		}
		return "js:" + script
	}
	selector := trimmedString(options.WaitForSelector)
	if selector == "" {
		return ""
	}
	if strings.HasPrefix(selector, "css:") || strings.HasPrefix(selector, "js:") || strings.HasPrefix(selector, "xpath:") {
		return selector
	}
	return "css:" + selector
}

// normalizeWaitForTimeoutForPayload mirrors the client's normalizeWaitForTimeout
// applied to the already-normalized value (idempotent).
func normalizeWaitForTimeoutForPayload(value *int, waitUntil *string) *int {
	if value == nil {
		return nil
	}
	clamped := clampInt(*value, 500, 60000)
	if stringOrEmpty(waitUntil) == "networkidle" && clamped < 5000 {
		clamped = 5000
	}
	return &clamped
}

func buildStorageState(value *string) json.RawMessage {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
		if json.Valid([]byte(trimmed)) {
			return json.RawMessage(trimmed)
		}
		encoded, err := json.Marshal(trimmed)
		if err != nil {
			return nil
		}
		return encoded
	}
	encoded, err := json.Marshal(trimmed)
	if err != nil {
		return nil
	}
	return encoded
}

func cacheMode(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "bypass"
	}
	return trimmed
}

func boolPtr(value bool) *bool { return &value }

func boolOnlyTrue(value bool) *bool {
	if !value {
		return nil
	}
	return boolPtr(true)
}

func millisToSeconds(value *int, min, max int) *float64 {
	if value == nil {
		return nil
	}
	clamped := clampInt(*value, min, max)
	return secondsPtr(clamped)
}

func secondsPtr(milliseconds int) *float64 {
	result := roundTo(float64(milliseconds)/1000, 2)
	return &result
}

func stringOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func trimmedString(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func normalizeTrimmedString(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func roundFloatPtr(value *float64, digits int) *float64 {
	if value == nil {
		return nil
	}
	result := roundTo(*value, digits)
	return &result
}

// ssrfProxy normalizes CRAWL4AI_SSRF_PROXY_URL: only absolute http(s) URLs are
// forwarded (resolveBrowserProxy / normalizeSsrfProxyUrl).
func ssrfProxy(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return ""
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return ""
	}
	return trimmed
}

// buildJSCodePayload mirrors normalizeJsCode: the entries are trimmed and the
// blank ones dropped first, jsCode is then dropped entirely when the feature is
// disabled, the whitelist validator runs on the normalized list, and a single
// script is sent as a string while several are sent as an array.
func buildJSCodePayload(scripts []string, enabled bool) (json.RawMessage, error) {
	if len(scripts) == 0 {
		return nil, nil
	}
	if !enabled {
		return nil, nil
	}
	normalized := normalizeJSCodeList(scripts)
	if len(normalized) == 0 {
		return nil, nil
	}
	if blocked := validateJSCodeArray(normalized); len(blocked) > 0 {
		shown := blocked
		if len(shown) > 5 {
			shown = shown[:5]
		}
		return nil, newError(400, "jsCode contains blocked patterns: "+strings.Join(shown, "; ")+". Only safe DOM operations are allowed.")
	}
	if len(normalized) == 1 {
		encoded, err := json.Marshal(normalized[0])
		if err != nil {
			return nil, err
		}
		return encoded, nil
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return nil, err
	}
	return encoded, nil
}

// mathMax keeps the bounded values used by the scanFullPage fallback readable.
func mathMax(a, b float64) float64 {
	return math.Max(a, b)
}

func mathMin(a, b float64) float64 {
	return math.Min(a, b)
}

// formatInt is a tiny helper used by the fallback message.
func formatInt(value int) string { return fmt.Sprintf("%d", value) }
