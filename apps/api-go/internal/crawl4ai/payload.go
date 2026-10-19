package crawl4ai

import (
	"encoding/json"
	"math"
	"net/url"
	"strings"
)

// httpPayload is the POST /crawl body (Crawl4aiHttpPayload).
type httpPayload struct {
	URLs          []string  `json:"urls"`
	Keywords      []string  `json:"keywords,omitempty"`
	BrowserConfig component `json:"browser_config"`
	CrawlerConfig component `json:"crawler_config"`
}

type component struct {
	Type   string `json:"type"`
	Params any    `json:"params"`
}

// browserParams is the BrowserConfig.params object. Every key the NestJS client
// builds is represented with the same name; absent values stay nil so they are
// omitted instead of being sent as null.
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
	UserAgent            *string           `json:"user_agent,omitempty"`
	StorageState         *string           `json:"storage_state,omitempty"`
}

// crawlerParams is CrawlerRunConfig.params. The field order follows the NestJS
// object literal; the clean-markdown keys are spread last and therefore
// override the four fields they share (css_selector, excluded_tags,
// remove_overlay_elements, word_count_threshold), exactly like
// `...(cleanMarkdown ?? {})` in toHttpPayload.
type crawlerParams struct {
	CacheMode               string          `json:"cache_mode"`
	Prefetch                *bool           `json:"prefetch,omitempty"`
	ScanFullPage            bool            `json:"scan_full_page"`
	AdjustViewportToContent *bool           `json:"adjust_viewport_to_content,omitempty"`
	ScrollDelay             *float64        `json:"scroll_delay,omitempty"`
	SimulateUser            *bool           `json:"simulate_user,omitempty"`
	OverrideNavigator       *bool           `json:"override_navigator,omitempty"`
	Magic                   *bool           `json:"magic,omitempty"`
	MarkdownGenerator       *component      `json:"markdown_generator,omitempty"`
	ScoreLinks              *bool           `json:"score_links,omitempty"`
	LinkPreviewConfig       *component      `json:"link_preview_config,omitempty"`
	UserAgent               *string         `json:"user_agent,omitempty"`
	Locale                  *string         `json:"locale,omitempty"`
	TimezoneID              *string         `json:"timezone_id,omitempty"`
	JSCode                  []string        `json:"js_code,omitempty"`
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
	DeepCrawlStrategy       json.RawMessage `json:"deep_crawl_strategy,omitempty"`
	WordCountThreshold      *int            `json:"word_count_threshold,omitempty"`
	ExcludeExternalLinks    *bool           `json:"exclude_external_links,omitempty"`
	ExcludeExternalImages   *bool           `json:"exclude_external_images,omitempty"`
	RemoveOverlayElements   *bool           `json:"remove_overlay_elements,omitempty"`
	ProcessIframes          *bool           `json:"process_iframes,omitempty"`
	CSSSelector             string          `json:"css_selector,omitempty"`
	ExcludedTags            []string        `json:"excluded_tags,omitempty"`
	WaitForImages           *bool           `json:"wait_for_images,omitempty"`
	OnlyText                *bool           `json:"only_text,omitempty"`
	Screenshot              *bool           `json:"screenshot,omitempty"`
	VirtualScrollConfig     *component      `json:"virtual_scroll_config,omitempty"`
}

// buildPayload mirrors Crawl4aiClient.toHttpPayload for the discovery subset.
func buildPayload(request CrawlRequest, ssrfProxyURL string) httpPayload {
	options := request.Options
	targets := []string{strings.TrimSpace(request.URL)}

	virtualScroll := buildVirtualScrollConfig(options.VirtualScroll)
	explicitScanFullPage := options.ScanFullPage
	scanFullPage := false
	if virtualScroll == nil && explicitScanFullPage != nil {
		scanFullPage = *explicitScanFullPage
	}

	browserType := ""
	if options.EnableUndetected != nil && *options.EnableUndetected {
		browserType = "undetected"
	}
	var lightMode *bool
	if options.IncludeImages != nil && !*options.IncludeImages {
		enabled := true
		lightMode = &enabled
	}
	useManagedBrowser := options.UseManagedBrowser != nil && *options.UseManagedBrowser
	// 与 useManagedBrowser || Boolean(userDataDir) 一致。
	usePersistentContext := useManagedBrowser || (options.UserDataDir != nil && *options.UserDataDir != "")

	headers := options.BrowserHeaders
	if len(headers) == 0 {
		headers = nil
	}

	// resolveScanProfile keeps the caller's explicit value; virtual scroll only
	// disables scan_full_page.
	adjustViewport := options.AdjustViewportToContent
	var scrollDelay *float64
	if scanFullPage {
		delayMs := 350
		if options.ScrollDelayMs != nil {
			delayMs = clampInt(*options.ScrollDelayMs, 50, 5000)
		}
		scrollDelay = secondsPtr(delayMs)
	}

	crawler := crawlerParams{
		CacheMode:               cacheMode(options.CacheMode),
		Prefetch:                options.Prefetch,
		ScanFullPage:            scanFullPage,
		AdjustViewportToContent: boolOnlyTrue(adjustViewport),
		ScrollDelay:             scrollDelay,
		SimulateUser:            options.SimulateUser,
		OverrideNavigator:       options.OverrideNavigator,
		Magic:                   options.EnableStealthMode,
		MarkdownGenerator:       buildMarkdownGenerator(options),
		ScoreLinks:              scoreLinks(options),
		LinkPreviewConfig:       buildLinkPreviewConfig(options.LinkPreview),
		UserAgent:               options.UserAgent,
		Locale:                  options.Locale,
		TimezoneID:              options.TimezoneID,
		JSCode:                  options.JSCode,
		JSOnly:                  boolOnlyTrue(options.JSOnly),
		WaitFor:                 buildWaitFor(options),
		WaitForTimeout:          normalizeWaitForTimeout(options.WaitForTimeoutMs, options.WaitUntil),
		WaitUntil:               waitUntil(options.WaitUntil),
		PageTimeout:             clampOptionalInt(options.PageTimeoutMs, 1000, 180000),
		DelayBeforeReturnHTML:   millisToSeconds(options.DelayBeforeReturnHtmlMs, 0, 30000),
		MeanDelay:               millisToSeconds(options.MeanDelayMs, 0, 10000),
		MaxRange:                millisToSeconds(options.MaxDelayRangeMs, 0, 10000),
		SemaphoreCount:          clampOptionalInt(options.SemaphoreCount, 1, 50),
		CheckRobotsTxt:          false,
		RemoveForms:             boolOnlyTrue(options.RemoveForms),
		SessionID:               options.SessionID,
		TableScoreThreshold:     tableScore(options.TableScoreThreshold),
		DeepCrawlStrategy:       options.DeepCrawlStrategy,
		WordCountThreshold:      wordCountThreshold(options.WordCountThreshold),
		ExcludeExternalLinks:    boolOrTrue(options.ExcludeExternalLinks),
		ExcludeExternalImages:   boolOrTrue(options.ExcludeExternalImgs),
		RemoveOverlayElements:   boolOrTrue(options.RemoveOverlayElements),
		ProcessIframes:          boolOrTrue(options.ProcessIframes),
		CSSSelector:             trimmed(options.CSSSelector),
		ExcludedTags:            selectorList(options.ExcludedTags),
		WaitForImages:           boolOnlyTrue(options.WaitForImages),
		OnlyText:                boolOnlyTrue(options.TextMode),
		Screenshot:              boolOnlyTrue(options.CaptureScreenshot),
		VirtualScrollConfig:     virtualScroll,
	}
	applyCleanMarkdown(&crawler, options.CleanMarkdown)

	return httpPayload{
		URLs:     targets,
		Keywords: request.Keywords,
		BrowserConfig: component{Type: "BrowserConfig", Params: browserParams{
			Headless:             options.Headless,
			EnableStealth:        options.EnableStealthMode,
			BrowserType:          browserType,
			LightMode:            lightMode,
			UseManagedBrowser:    boolOnlyTrue(options.UseManagedBrowser),
			UsePersistentContext: boolOnlyTrue(&usePersistentContext),
			UserDataDir:          options.UserDataDir,
			Proxy:                ssrfProxy(ssrfProxyURL),
			Headers:              headers,
			UserAgent:            options.UserAgent,
			StorageState:         options.StorageState,
		}},
		CrawlerConfig: component{Type: "CrawlerRunConfig", Params: crawler},
	}
}

// applyCleanMarkdown spreads the clean-markdown payload last, overriding the
// four keys it shares with the main crawler params.
func applyCleanMarkdown(params *crawlerParams, clean *CleanMarkdown) {
	if clean == nil {
		return
	}
	if selector := trimmed(clean.CSSSelector); selector != "" {
		params.CSSSelector = selector
	}
	if tags := selectorList(clean.ExcludedTags); len(tags) > 0 {
		params.ExcludedTags = tags
	}
	if clean.RemoveOverlayElements != nil {
		params.RemoveOverlayElements = clean.RemoveOverlayElements
	}
	if clean.WordCountThreshold != nil {
		params.WordCountThreshold = normalizeWordCountThreshold(clean.WordCountThreshold)
	}
}

func buildVirtualScrollConfig(config *VirtualScroll) *component {
	if config == nil {
		return nil
	}
	params := map[string]any{}
	if selector := trimmedString(config.ContainerSelector); selector != "" {
		params["container_selector"] = selector
	}
	if config.ScrollCount > 0 {
		params["scroll_count"] = clampInt(config.ScrollCount, 1, 1000)
	}
	if scrollBy := normalizedScrollBy(config.ScrollBy); scrollBy != "" {
		params["scroll_by"] = scrollBy
	}
	if config.WaitAfterScrollMs != nil {
		params["wait_after_scroll"] = roundTo(seconds(*config.WaitAfterScrollMs), 2)
	}
	if len(params) == 0 {
		return nil
	}
	return &component{Type: "VirtualScrollConfig", Params: params}
}

func normalizedScrollBy(value string) string {
	trimmedValue := strings.TrimSpace(value)
	if trimmedValue == "" {
		return ""
	}
	if strings.EqualFold(trimmedValue, "full_page") || strings.EqualFold(trimmedValue, "page_height") {
		return strings.ToLower(trimmedValue)
	}
	for _, char := range trimmedValue {
		if char < '0' || char > '9' {
			return ""
		}
	}
	return trimmedValue
}

func buildMarkdownGenerator(options CrawlOptions) *component {
	if strategy := options.MarkdownStrategy; strategy != nil && strings.TrimSpace(strategy.Type) != "" {
		if len(strategy.Params) > 0 && json.Valid(strategy.Params) && string(strategy.Params) != "{}" && string(strategy.Params) != "null" {
			return &component{Type: strings.TrimSpace(strategy.Type), Params: strategy.Params}
		}
		return &component{Type: strings.TrimSpace(strategy.Type), Params: map[string]any{}}
	}
	var contentFilter *component
	if filter := options.MarkdownFilter; filter != nil {
		contentFilter = buildContentFilter(filter)
	}
	if contentFilter == nil {
		return nil
	}
	return &component{
		Type:   "DefaultMarkdownGenerator",
		Params: map[string]any{"content_filter": contentFilter},
	}
}

func buildContentFilter(filter *MarkdownFilter) *component {
	switch filter.Type {
	case "pruning":
		params := map[string]any{}
		if filter.Threshold != nil {
			params["threshold"] = clampFloat(*filter.Threshold, 0, 1)
		}
		if filter.ThresholdType != nil {
			params["threshold_type"] = *filter.ThresholdType
		}
		if filter.MinWordThresh != nil {
			params["min_word_threshold"] = *filter.MinWordThresh
		}
		return &component{Type: "PruningContentFilter", Params: params}
	case "bm25":
		if filter.UserQuery == nil || strings.TrimSpace(*filter.UserQuery) == "" {
			return nil
		}
		params := map[string]any{"user_query": strings.TrimSpace(*filter.UserQuery)}
		if filter.BM25Threshold != nil {
			params["bm25_threshold"] = *filter.BM25Threshold
		}
		if filter.BM25Language != nil {
			params["language"] = *filter.BM25Language
		}
		return &component{Type: "BM25ContentFilter", Params: params}
	}
	return nil
}

func buildLinkPreviewConfig(config *LinkPreview) *component {
	if config == nil {
		return nil
	}
	params := map[string]any{
		"include_internal": config.IncludeInternal,
		"include_external": config.IncludeExternal,
	}
	if config.MaxLinks != nil {
		params["max_links"] = *config.MaxLinks
	}
	if config.Concurrency != nil {
		params["concurrency"] = *config.Concurrency
	}
	if config.TimeoutSeconds != nil {
		params["timeout"] = *config.TimeoutSeconds
	}
	if query := trimmed(config.Query); query != "" {
		params["query"] = query
	}
	if config.ScoreThreshold != nil {
		params["score_threshold"] = roundTo(*config.ScoreThreshold, 3)
	}
	if config.Verbose != nil {
		params["verbose"] = *config.Verbose
	}
	if patterns := patternList(config.IncludePatterns); len(patterns) > 0 {
		params["include_patterns"] = patterns
	}
	if patterns := patternList(config.ExcludePatterns); len(patterns) > 0 {
		params["exclude_patterns"] = patterns
	}
	// Link preview describes link scoring, which is never the only signal worth
	// sending: include_internal/include_external are always present, so the
	// object is never empty.
	return &component{Type: "LinkPreviewConfig", Params: params}
}

// scoreLinks mirrors `options.scoreLinks ?? Boolean(linkPreviewConfig)`.
func scoreLinks(options CrawlOptions) *bool {
	if options.ScoreLinks != nil {
		return options.ScoreLinks
	}
	if options.LinkPreview != nil {
		enabled := true
		return &enabled
	}
	return nil
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

func waitUntil(value *string) string {
	if value == nil {
		return ""
	}
	switch strings.ToLower(strings.TrimSpace(*value)) {
	case "domcontentloaded", "load", "networkidle", "commit":
		return strings.ToLower(strings.TrimSpace(*value))
	}
	return ""
}

// normalizeWaitForTimeout mirrors the client helper: 500..60000, and at least
// 5000 for networkidle.
func normalizeWaitForTimeout(value *int, until *string) *int {
	if value == nil {
		return nil
	}
	clamped := clampInt(*value, 500, 60000)
	if waitUntil(until) == "networkidle" && clamped < 5000 {
		clamped = 5000
	}
	return &clamped
}

func cacheMode(value *string) string {
	if value == nil {
		return "bypass"
	}
	trimmedValue := strings.TrimSpace(*value)
	if trimmedValue == "" {
		return "bypass"
	}
	return trimmedValue
}

func wordCountThreshold(value *int) *int {
	if value == nil {
		fallback := 80
		return &fallback
	}
	return normalizeWordCountThreshold(value)
}

func normalizeWordCountThreshold(value *int) *int {
	if value == nil {
		return nil
	}
	clamped := clampInt(*value, 0, 5000)
	return &clamped
}

func tableScore(value *float64) *float64 {
	if value == nil {
		return nil
	}
	clamped := roundTo(clampFloat(*value, 0, 10), 2)
	return &clamped
}

func boolOrTrue(value *bool) *bool {
	if value == nil {
		enabled := true
		return &enabled
	}
	return value
}

func boolOnlyTrue(value *bool) *bool {
	if value == nil || !*value {
		return nil
	}
	return value
}

func millisToSeconds(value *int, min, max int) *float64 {
	if value == nil {
		return nil
	}
	seconds := secondsPtr(clampInt(*value, min, max))
	return seconds
}

func secondsPtr(milliseconds int) *float64 {
	result := roundTo(seconds(milliseconds), 2)
	return &result
}

func seconds(milliseconds int) float64 {
	return float64(milliseconds) / 1000
}

func clampInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func clampOptionalInt(value *int, min, max int) *int {
	if value == nil {
		return nil
	}
	clamped := clampInt(*value, min, max)
	return &clamped
}

func clampFloat(value, min, max float64) float64 {
	if math.IsNaN(value) {
		return min
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func roundTo(value float64, digits int) float64 {
	scale := math.Pow(10, float64(digits))
	return math.Round(value*scale) / scale
}

func trimmed(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func trimmedString(value *string) string {
	return trimmed(value)
}

func selectorList(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		normalized := strings.TrimSpace(strings.ToLower(value))
		if normalized == "" {
			continue
		}
		if !validSelector(normalized) {
			continue
		}
		out = append(out, normalized)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// validSelector matches /^[a-z0-9][a-z0-9-_:.[\]=#\s>+~*()]*$/i lowercased.
func validSelector(value string) bool {
	for index, char := range value {
		switch {
		case char >= 'a' && char <= 'z', char >= '0' && char <= '9':
			continue
		case index == 0:
			return false
		case strings.ContainsRune("-_:.[]=# >+~*()", char):
			continue
		default:
			return false
		}
	}
	return value != ""
}

func patternList(patterns []string) []string {
	out := make([]string, 0, len(patterns))
	for _, pattern := range patterns {
		normalized := strings.TrimSpace(pattern)
		if normalized == "" || len(normalized) > 512 {
			continue
		}
		out = append(out, normalized)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// ssrfProxy normalizes CRAWL4AI_SSRF_PROXY_URL: only absolute http(s) URLs are
// forwarded.
func ssrfProxy(value string) string {
	trimmedValue := strings.TrimSpace(value)
	if trimmedValue == "" {
		return ""
	}
	parsed, err := url.Parse(trimmedValue)
	if err != nil {
		return ""
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return ""
	}
	return trimmedValue
}
