package crawl4ai

import (
	"encoding/json"
	"math"
	"regexp"
	"strings"
)

// This file ports CrawlOptionsNormalizerService.normalizeOptions
// (crawl-options-normalizer.service.ts:268-489) together with the
// crawl-options.helpers.ts normalizers it calls, for every field that reaches
// toHttpPayload. The resolved object is the Go CrawlOptions the payload builder
// consumes; defaults live here so the payload builder only decides presence.
//
// Not ported: multi-URL configurations, proxy configurations (both rejected by
// the crawl-config policy before normalization), detail expansion, page type
// hints, anti-bot mode and media extraction flags. The discovery chain never
// reads them and they cannot change the returned links.

// NormalizeOptions resolves the normalized CrawlTaskOptions subset. A nil,
// null, array or scalar input is treated as the empty object, exactly like
// `value && typeof value === "object" && !Array.isArray(value) ? value : {}`.
func NormalizeOptions(raw json.RawMessage) CrawlOptions {
	record := decodeObject(raw)

	includeImages := rawBoolOr(record, "includeImages", rawBoolOr(record, "storeMedia", false))
	storeMedia := rawBoolOr(record, "storeMedia", false)
	virtualScroll := normalizeVirtualScroll(record["virtualScroll"])
	scanFullPage := false
	if virtualScroll == nil {
		scanFullPage = rawBoolOr(record, "scanFullPage", false)
	}
	adjustViewport := rawBoolDefault(record, "adjustViewportToContent", scanFullPage)
	var scrollDelayMs *int
	if scanFullPage {
		if value, ok := rawNumber(record["scrollDelayMs"]); ok {
			scrollDelayMs = intPtr(clampScrollDelay(value))
		} else {
			scrollDelayMs = intPtr(200)
		}
	}
	enableStealthMode := rawBoolOr(record, "enableStealthMode", false)

	onlyMainContent := rawBoolOr(record, "onlyMainContent", true)
	wordCountThreshold := normalizeWordCountThreshold(rawNumberPtr(record["wordCountThreshold"]))
	if wordCountThreshold == nil {
		fallback := normalizeWordCountThresholdValue(80)
		wordCountThreshold = &fallback
	}

	markdownOptions := normalizeMarkdownOptionsRecord(record["markdownOptions"])
	beforeContentSource := markdownOptionsContentSource(markdownOptions)
	qualityProfile := parseQualityProfile(record["qualityProfile"])
	if qualityProfile == "" {
		qualityProfile = "quality_first"
	}
	if beforeContentSource == nil {
		source := "cleaned_html"
		if qualityProfile == "speed_first" {
			source = "raw_html"
		}
		if markdownOptions == nil {
			markdownOptions = &MarkdownOptions{}
		}
		markdownOptions.ContentSource = &source
	}
	if markdownOptions != nil && markdownOptions.Citations == nil {
		enabled := true
		markdownOptions.Citations = &enabled
	}

	markdownFilter := normalizeMarkdownFilter(record["markdownFilter"])
	markdownStrategy := normalizeMarkdownStrategy(record["markdownStrategy"])

	cleanMarkdown := normalizeCleanMarkdown(record["cleanMarkdown"])
	if cleanMarkdown == nil {
		cleanMarkdown = &CleanMarkdown{}
	}
	cleanMarkdown.CSSSelector = nil
	qualityExcluded := []string{"script", "style", "noscript"}
	if qualityProfile == "quality_first" {
		qualityExcluded = []string{"nav", "footer", "aside", "script", "style", "noscript", "form"}
	}
	cleanMarkdown.ExcludedTags = mergeSelectorValues(cleanMarkdown.ExcludedTags, qualityExcluded)
	if cleanMarkdown.RemoveOverlayElements == nil {
		enabled := true
		cleanMarkdown.RemoveOverlayElements = &enabled
	}
	if cleanMarkdown.WordCountThreshold == nil {
		value := 12
		if qualityProfile == "quality_first" {
			value = 18
		}
		cleanMarkdown.WordCountThreshold = &value
	}

	linkPreview := normalizeLinkPreview(record["linkPreview"])
	scoreLinks := false
	if explicit := rawBoolPtr(record["scoreLinks"]); explicit != nil {
		scoreLinks = *explicit
	} else if linkPreview != nil {
		scoreLinks = true
	}

	jsCode := normalizeScriptList(record["jsCode"])
	waitForSelector := normalizeWaitForSelector(record["waitForSelector"])
	waitForScript := normalizeWaitForScript(record["waitForScript"])
	waitForTimeoutMs := normalizeWaitForTimeout(rawNumberPtr(record["waitForTimeoutMs"]))
	waitUntil := normalizeWaitUntil(record["waitUntil"])
	if waitUntil != "" && waitForTimeoutMs != nil && waitUntil == "networkidle" && *waitForTimeoutMs < 5000 {
		boosted := 5000
		waitForTimeoutMs = &boosted
	}

	userAgent := normalizeTrimmed(record["userAgent"], 768)
	var userAgentMode *string
	if userAgent == nil {
		mode := "random"
		userAgentMode = &mode
	}

	headers := normalizeBrowserHeaders(record["browserHeaders"])
	headers = mergeBrowserHeaders(headers, autoBrowserHeaders(userAgent))

	return CrawlOptions{
		IncludeImages:   includeImages,
		StoreMedia:      storeMedia,
		OnlyMainContent: onlyMainContent,
		ExtractLinks:    rawBoolOr(record, "extractLinks", false),
		CacheMode:       stringOr(rawString(record["cacheMode"]), "bypass"),
		Prefetch:        rawBoolOr(record, "prefetch", false),
		ScoreLinks:      scoreLinks,
		QualityProfile:  qualityProfile,

		ScanFullPage:            scanFullPage,
		AdjustViewportToContent: adjustViewport,
		ScrollDelayMs:           scrollDelayMs,
		Headless:                rawBoolPtr(record["headless"]),
		EnableStealthMode:       enableStealthMode,
		EnableUndetectedBrowser: rawBoolOr(record, "enableUndetectedBrowser", false),
		UseManagedBrowser:       rawBoolOr(record, "useManagedBrowser", normalizeUserDataDir(record["userDataDir"]) != nil),
		UserDataDir:             normalizeUserDataDir(record["userDataDir"]),
		SimulateUser:            rawBoolOr(record, "simulateUser", enableStealthMode),
		OverrideNavigator:       rawBoolOr(record, "overrideNavigator", enableStealthMode),
		JSCode:                  jsCode,
		JSOnly:                  rawBoolOr(record, "jsOnly", false),
		WaitForSelector:         waitForSelector,
		WaitForScript:           waitForScript,
		WaitForTimeoutMs:        waitForTimeoutMs,
		WaitUntil:               stringPtrOrNil(waitUntil),
		PageTimeoutMs:           normalizePageTimeoutMs(rawNumberPtr(record["pageTimeoutMs"])),
		DelayBeforeReturnHTMLMs: normalizeDelayBeforeReturnHTMLMs(rawNumberPtr(record["delayBeforeReturnHtmlMs"])),
		MeanDelayMs:             normalizeDelayJitterMs(rawNumberPtr(record["meanDelayMs"])),
		MaxDelayRangeMs:         normalizeDelayJitterMs(rawNumberPtr(record["maxDelayRangeMs"])),
		SemaphoreCount:          normalizeSemaphoreCount(rawNumberPtr(record["semaphoreCount"])),

		MarkdownOptions:     markdownOptions,
		MarkdownFilter:      markdownFilter,
		MarkdownStrategy:    markdownStrategy,
		TableScoreThreshold: normalizeTableScore(rawNumberPtr(record["tableScoreThreshold"])),
		CleanMarkdown:       cleanMarkdown,
		LinkPreview:         linkPreview,
		BrowserHeaders:      headers,
		UserAgent:           userAgent,
		UserAgentMode:       userAgentMode,
		Locale:              normalizeTrimmed(record["locale"], 16),
		TimezoneID:          normalizeTrimmed(record["timezoneId"], 64),
		SessionID:           normalizeTrimmed(record["sessionId"], 160),
		StorageState:        normalizeTrimmed(record["storageState"], 12000),
		WordCountThreshold:  wordCountThreshold,

		ExcludeExternalLinks:  rawBoolOr(record, "excludeExternalLinks", true),
		RemoveOverlayElements: rawBoolOr(record, "removeOverlayElements", true),
		ProcessIframes:        rawBoolOr(record, "processIframes", true),
		TextMode:              rawBoolOr(record, "textMode", false),
		CaptureScreenshot:     rawBoolOr(record, "captureScreenshot", false),
		CSSSelector:           normalizeCSSSelector(record["cssSelector"]),
		ExcludedTags:          normalizeSelectorList(record["excludedTags"]),
		VirtualScroll:         virtualScroll,
		ExcludeExternalImages: rawBoolOr(record, "excludeExternalImages", !storeMedia),
		WaitForImages:         rawBoolOr(record, "waitForImages", storeMedia),
		RemoveForms:           rawBoolOr(record, "removeForms", false),
	}
}

// ---------------------------------------------------------------------------
// raw JSON accessors

func decodeObject(raw json.RawMessage) map[string]json.RawMessage {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed[0] != '{' {
		return map[string]json.RawMessage{}
	}
	record := map[string]json.RawMessage{}
	if err := json.Unmarshal([]byte(trimmed), &record); err != nil {
		return map[string]json.RawMessage{}
	}
	return record
}

func rawBoolPtr(raw json.RawMessage) *bool {
	trimmed := strings.TrimSpace(string(raw))
	switch trimmed {
	case "true":
		value := true
		return &value
	case "false":
		value := false
		return &value
	}
	return nil
}

func rawBoolOr(record map[string]json.RawMessage, key string, fallback bool) bool {
	if value := rawBoolPtr(record[key]); value != nil {
		return *value
	}
	return fallback
}

func rawBoolDefault(record map[string]json.RawMessage, key string, fallback bool) bool {
	return rawBoolOr(record, key, fallback)
}

func rawNumber(raw json.RawMessage) (float64, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return 0, false
	}
	switch trimmed[0] {
	case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
	default:
		return 0, false
	}
	var value float64
	if err := json.Unmarshal([]byte(trimmed), &value); err != nil {
		return 0, false
	}
	return value, true
}

func rawNumberPtr(raw json.RawMessage) *float64 {
	if value, ok := rawNumber(raw); ok {
		return &value
	}
	return nil
}

func rawString(raw json.RawMessage) *string {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) < 2 || trimmed[0] != '"' {
		return nil
	}
	var value string
	if err := json.Unmarshal([]byte(trimmed), &value); err != nil {
		return nil
	}
	return &value
}

func stringOr(value *string, fallback string) string {
	if value == nil || strings.TrimSpace(*value) == "" {
		return fallback
	}
	return strings.TrimSpace(*value)
}

func stringPtrOrNil(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// ---------------------------------------------------------------------------
// scalar helpers

func normalizeTrimmed(raw json.RawMessage, limit int) *string {
	value := rawString(raw)
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	if limit > 0 && len([]rune(trimmed)) > limit {
		trimmed = string([]rune(trimmed)[:limit])
	}
	return &trimmed
}

func clampScrollDelay(value float64) int {
	if value != value { // NaN
		return 200
	}
	return clampInt(int(roundTo(value, 0)), 0, 5000)
}

func normalizeWordCountThreshold(value *float64) *int {
	if value == nil {
		return nil
	}
	clamped := normalizeWordCountThresholdValue(int(roundTo(*value, 0)))
	return &clamped
}

func normalizeWordCountThresholdValue(value int) int {
	return clampInt(value, 0, 5000)
}

func normalizePageTimeoutMs(value *float64) *int {
	if value == nil {
		return nil
	}
	clamped := clampInt(int(roundTo(*value, 0)), 1000, 180000)
	return &clamped
}

func normalizeDelayBeforeReturnHTMLMs(value *float64) *int {
	if value == nil {
		return nil
	}
	clamped := clampInt(int(roundTo(*value, 0)), 0, 30000)
	return &clamped
}

func normalizeDelayJitterMs(value *float64) *int {
	if value == nil {
		return nil
	}
	clamped := clampInt(int(roundTo(*value, 0)), 0, 10000)
	return &clamped
}

func normalizeSemaphoreCount(value *float64) *int {
	if value == nil {
		return nil
	}
	clamped := clampInt(int(roundTo(*value, 0)), 1, 50)
	return &clamped
}

func normalizeWaitForTimeout(value *float64) *int {
	if value == nil {
		return nil
	}
	clamped := clampInt(int(roundTo(*value, 0)), 500, 60000)
	return &clamped
}

func normalizeWaitUntil(raw json.RawMessage) string {
	value := rawString(raw)
	if value == nil {
		return ""
	}
	switch strings.ToLower(strings.TrimSpace(*value)) {
	case "domcontentloaded", "load", "networkidle", "commit":
		return strings.ToLower(strings.TrimSpace(*value))
	}
	return ""
}

func normalizeWaitForSelector(raw json.RawMessage) *string {
	return normalizeTrimmed(raw, 1024)
}

func normalizeWaitForScript(raw json.RawMessage) *string {
	return normalizeTrimmed(raw, 4000)
}

func normalizeCSSSelector(raw json.RawMessage) *string {
	return normalizeTrimmed(raw, 512)
}

func normalizeTableScore(value *float64) *float64 {
	if value == nil {
		return nil
	}
	clamped := roundTo(clampFloat(*value, 0, 10), 2)
	return &clamped
}

func normalizeScriptList(raw json.RawMessage) []string {
	values := rawStringArray(raw)
	if len(values) == 0 {
		return nil
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		out = append(out, trimmed)
		if len(out) >= 10 {
			break
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func normalizeSelectorList(raw json.RawMessage) []string {
	values := rawStringArray(raw)
	if len(values) == 0 {
		return nil
	}
	out := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		out = append(out, trimmed)
		if len(out) >= 10 {
			break
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func normalizePatternList(raw json.RawMessage) []string {
	values := rawStringArray(raw)
	if len(values) == 0 {
		return nil
	}
	out := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		out = append(out, trimmed)
		if len(out) >= 25 {
			break
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func rawStringArray(raw json.RawMessage) []string {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) < 2 || trimmed[0] != '[' {
		return nil
	}
	var values []string
	if err := json.Unmarshal([]byte(trimmed), &values); err != nil {
		return nil
	}
	return values
}

func mergeSelectorValues(existing, defaults []string) []string {
	out := make([]string, 0, len(existing)+len(defaults))
	seen := map[string]bool{}
	for _, value := range append(append([]string{}, existing...), defaults...) {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		out = append(out, trimmed)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func parseQualityProfile(raw json.RawMessage) string {
	value := rawString(raw)
	if value == nil {
		return ""
	}
	switch strings.TrimSpace(*value) {
	case "balanced", "quality_first", "speed_first":
		return strings.TrimSpace(*value)
	}
	return ""
}

// ---------------------------------------------------------------------------
// markdown / link preview / virtual scroll

func markdownOptionsContentSource(options *MarkdownOptions) *string {
	if options == nil {
		return nil
	}
	return options.ContentSource
}

func normalizeMarkdownOptionsRecord(raw json.RawMessage) *MarkdownOptions {
	record := decodeObject(raw)
	if len(record) == 0 {
		return nil
	}
	options := &MarkdownOptions{}
	if source := stringOr(rawString(record["contentSource"]), ""); source == "raw_html" || source == "cleaned_html" || source == "fit_html" {
		options.ContentSource = &source
	}
	options.IgnoreLinks = rawBoolPtr(record["ignoreLinks"])
	options.EscapeHTML = rawBoolPtr(record["escapeHtml"])
	options.Citations = rawBoolPtr(record["citations"])
	if value, ok := rawNumber(record["bodyWidth"]); ok {
		clamped := clampInt(int(roundTo(value, 0)), 40, 200)
		options.BodyWidth = &clamped
	}
	return options
}

func normalizeMarkdownFilter(raw json.RawMessage) *MarkdownFilter {
	record := decodeObject(raw)
	filterType := stringOr(rawString(record["type"]), "")
	switch filterType {
	case "pruning":
		filter := &MarkdownFilter{Type: "pruning"}
		if value, ok := rawNumber(record["threshold"]); ok {
			clamped := clampFloat(value, 0, 1)
			filter.Threshold = &clamped
		}
		if thresholdType := stringOr(rawString(record["thresholdType"]), ""); thresholdType == "fixed" || thresholdType == "dynamic" {
			filter.ThresholdType = &thresholdType
		}
		if value, ok := rawNumber(record["minWordThreshold"]); ok {
			clamped := clampInt(int(roundTo(value, 0)), 0, 500)
			filter.MinWordThreshold = &clamped
		}
		return filter
	case "bm25":
		filter := &MarkdownFilter{Type: "bm25"}
		if value := normalizeTrimmed(record["userQuery"], 240); value != nil {
			filter.UserQuery = value
		}
		if value, ok := rawNumber(record["bm25Threshold"]); ok && value == value {
			clamped := roundTo(clampFloat(value, 0, 20), 2)
			filter.BM25Threshold = &clamped
		}
		if value := normalizeTrimmed(record["language"], 32); value != nil {
			filter.Language = value
		}
		if filter.UserQuery == nil {
			return nil
		}
		return filter
	}
	return nil
}

func normalizeMarkdownStrategy(raw json.RawMessage) *MarkdownStrategy {
	record := decodeObject(raw)
	strategyType := strings.TrimSpace(stringOr(rawString(record["type"]), ""))
	if strategyType == "" {
		return nil
	}
	params := record["params"]
	trimmedParams := strings.TrimSpace(string(params))
	if trimmedParams != "" && trimmedParams != "{}" && trimmedParams != "null" && json.Valid([]byte(trimmedParams)) {
		return &MarkdownStrategy{Type: strategyType, Params: json.RawMessage(trimmedParams)}
	}
	return &MarkdownStrategy{Type: strategyType}
}

func normalizeCleanMarkdown(raw json.RawMessage) *CleanMarkdown {
	record := decodeObject(raw)
	if len(record) == 0 {
		return nil
	}
	clean := &CleanMarkdown{}
	clean.CSSSelector = normalizeCSSSelector(record["cssSelector"])
	clean.TargetElements = rawStringArray(record["targetElements"])
	clean.ExcludedTags = rawStringArray(record["excludedTags"])
	clean.RemoveOverlayElements = rawBoolPtr(record["removeOverlayElements"])
	clean.WordCountThreshold = normalizeWordCountThreshold(rawNumberPtr(record["wordCountThreshold"]))
	return clean
}

func normalizeLinkPreview(raw json.RawMessage) *LinkPreview {
	record := decodeObject(raw)
	if len(record) == 0 {
		return nil
	}
	preview := &LinkPreview{
		IncludeInternal: rawBoolPtr(record["includeInternal"]),
		IncludeExternal: rawBoolPtr(record["includeExternal"]),
		Verbose:         rawBoolPtr(record["verbose"]),
		IncludePatterns: normalizePatternList(record["includePatterns"]),
		ExcludePatterns: normalizePatternList(record["excludePatterns"]),
	}
	if value, ok := rawNumber(record["maxLinks"]); ok {
		clamped := int(roundTo(value, 0))
		preview.MaxLinks = &clamped
	}
	if value, ok := rawNumber(record["concurrency"]); ok {
		clamped := int(roundTo(value, 0))
		preview.Concurrency = &clamped
	}
	if value, ok := rawNumber(record["timeoutSeconds"]); ok {
		preview.TimeoutSeconds = &value
	}
	if value, ok := rawNumber(record["scoreThreshold"]); ok {
		clamped := roundTo(value, 3)
		preview.ScoreThreshold = &clamped
	}
	preview.Query = normalizeTrimmed(record["query"], 0)
	return preview
}

func normalizeVirtualScroll(raw json.RawMessage) *VirtualScroll {
	record := decodeObject(raw)
	if len(record) == 0 {
		return nil
	}
	config := &VirtualScroll{}
	if value := normalizeTrimmed(record["containerSelector"], 512); value != nil {
		config.ContainerSelector = *value
	}
	if value, ok := rawNumber(record["scrollCount"]); ok {
		clamped := clampInt(int(roundTo(value, 0)), 1, 1000)
		config.ScrollCount = &clamped
	}
	config.ScrollBy = normalizeScrollBy(record["scrollBy"])
	if value, ok := rawNumber(record["waitAfterScrollMs"]); ok {
		clamped := clampInt(int(roundTo(value, 0)), 0, 60000)
		config.WaitAfterScrollMs = &clamped
	}
	if config.ContainerSelector == "" && config.ScrollCount == nil && config.ScrollBy == nil && config.WaitAfterScrollMs == nil {
		return nil
	}
	return config
}

func normalizeScrollBy(raw json.RawMessage) *string {
	value := strings.TrimSpace(stringOr(rawString(raw), ""))
	switch value {
	case "container_height", "page_height":
		return &value
	case "viewport":
		result := "page_height"
		return &result
	}
	if number, ok := rawNumber(raw); ok {
		result := itoa(clampInt(int(roundTo(number, 0)), 1, 20000))
		return &result
	}
	if value != "" {
		for _, char := range value {
			if char < '0' || char > '9' {
				return nil
			}
		}
		result := itoa(clampInt(atoiSafe(value), 1, 20000))
		return &result
	}
	return nil
}

func normalizeUserDataDir(raw json.RawMessage) *string {
	return normalizeTrimmed(raw, 512)
}

// ---------------------------------------------------------------------------
// browser headers

const headerTokenPattern = "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$"

var (
	httpHeaderNamePattern = regexp.MustCompile(headerTokenPattern)
	controlCharPattern    = regexp.MustCompile("[\x00-\x1f\x7f]")
	chromiumUAVersion     = regexp.MustCompile(`(?i)(?:chrome|crios|chromium|edg|edga|edgios)/(\d{2,3})`)
)

func normalizeBrowserHeaders(raw json.RawMessage) []BrowserHeader {
	record := decodeList(raw)
	out := make([]BrowserHeader, 0, len(record))
	for _, entryRaw := range record {
		entry := decodeObject(entryRaw)
		name := normalizeHeaderName(entry["name"])
		value := normalizeHeaderValue(entry["value"])
		if name == "" || value == "" {
			continue
		}
		out = append(out, BrowserHeader{Name: name, Value: value})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func decodeList(raw json.RawMessage) []json.RawMessage {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) < 2 || trimmed[0] != '[' {
		return nil
	}
	var values []json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &values); err != nil {
		return nil
	}
	return values
}

func normalizeHeaderName(raw json.RawMessage) string {
	value := strings.TrimSpace(stringOr(rawString(raw), ""))
	if value == "" || controlCharPattern.MatchString(value) || !httpHeaderNamePattern.MatchString(value) {
		return ""
	}
	return value
}

func normalizeHeaderValue(raw json.RawMessage) string {
	value := strings.TrimSpace(stringOr(rawString(raw), ""))
	if value == "" || controlCharPattern.MatchString(value) {
		return ""
	}
	return value
}

// autoBrowserHeaders ports buildAutoBrowserHeadersForCrawlOptions: the two
// sec-fetch headers are always present, and the sec-ch-ua trio is added only
// when the caller supplied a Chromium user agent (the discovery chain normally
// leaves the agent to crawl4ai's random generator, so the trio is absent).
func autoBrowserHeaders(userAgent *string) []BrowserHeader {
	headers := []BrowserHeader{
		{Name: "sec-fetch-site", Value: "none"},
		{Name: "sec-fetch-mode", Value: "navigate"},
	}
	if userAgent == nil {
		return headers
	}
	brand := inferChromiumBrand(*userAgent)
	if brand == "" {
		return headers
	}
	match := chromiumUAVersion.FindStringSubmatch(*userAgent)
	if match == nil {
		return headers
	}
	platform := inferPlatformFromUserAgent(*userAgent)
	mobile := inferMobileFromUserAgent(*userAgent)
	prefix := []BrowserHeader{
		{Name: "sec-ch-ua", Value: buildSecChUAValue(brand, match[1])},
		{Name: "sec-ch-ua-mobile", Value: mobile},
		{Name: "sec-ch-ua-platform", Value: `"` + platform + `"`},
	}
	return append(prefix, headers...)
}

func inferChromiumBrand(userAgent string) string {
	normalized := strings.ToLower(userAgent)
	switch {
	case strings.Contains(normalized, "edg/"), strings.Contains(normalized, "edga/"), strings.Contains(normalized, "edgios/"):
		return "edge"
	case strings.Contains(normalized, "chrome/"), strings.Contains(normalized, "crios/"):
		return "chrome"
	case strings.Contains(normalized, "chromium"):
		return "chromium"
	}
	return ""
}

func inferPlatformFromUserAgent(userAgent string) string {
	normalized := strings.ToLower(userAgent)
	switch {
	case strings.Contains(normalized, "android"):
		return "Android"
	case strings.Contains(normalized, "iphone"), strings.Contains(normalized, "ipad"), strings.Contains(normalized, "ios"):
		return "iOS"
	case strings.Contains(normalized, "macintosh"), strings.Contains(normalized, "mac os x"):
		return "macOS"
	case strings.Contains(normalized, "linux"), strings.Contains(normalized, "x11"):
		return "Linux"
	case strings.Contains(normalized, "windows"):
		return "Windows"
	}
	return "Windows"
}

func inferMobileFromUserAgent(userAgent string) string {
	normalized := strings.ToLower(userAgent)
	if strings.Contains(normalized, "mobile") || strings.Contains(normalized, "iphone") ||
		strings.Contains(normalized, "ipod") ||
		(strings.Contains(normalized, "android") && strings.Contains(normalized, "mobile")) {
		return "?1"
	}
	return "?0"
}

func buildSecChUAValue(brand, majorVersion string) string {
	switch brand {
	case "edge":
		return `"Chromium";v="` + majorVersion + `", "Not_A Brand";v="8", "Microsoft Edge";v="` + majorVersion + `"`
	case "chrome":
		return `"Chromium";v="` + majorVersion + `", "Not_A Brand";v="8", "Google Chrome";v="` + majorVersion + `"`
	}
	return `"Chromium";v="` + majorVersion + `", "Not_A Brand";v="8"`
}

func mergeBrowserHeaders(existing, auto []BrowserHeader) []BrowserHeader {
	byName := map[string]BrowserHeader{}
	order := []string{}
	for _, header := range existing {
		key := strings.ToLower(header.Name)
		if _, ok := byName[key]; !ok {
			order = append(order, key)
		}
		byName[key] = header
	}
	for _, header := range auto {
		key := strings.ToLower(header.Name)
		if _, ok := byName[key]; ok {
			continue
		}
		order = append(order, key)
		byName[key] = header
	}
	if len(order) == 0 {
		return nil
	}
	out := make([]BrowserHeader, 0, len(order))
	for _, key := range order {
		out = append(out, byName[key])
	}
	return out
}

// ---------------------------------------------------------------------------
// small numeric helpers

func clampInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func clampFloat(value, min, max float64) float64 {
	if value != value {
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

func intPtr(value int) *int { return &value }

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	digits := []byte{}
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	if negative {
		return "-" + string(digits)
	}
	return string(digits)
}

func atoiSafe(value string) int {
	result := 0
	for _, char := range value {
		if char < '0' || char > '9' {
			return result
		}
		result = result*10 + int(char-'0')
		if result > 1<<30 {
			return result
		}
	}
	return result
}
