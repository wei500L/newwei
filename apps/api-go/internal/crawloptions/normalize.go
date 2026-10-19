package crawloptions

import (
	"encoding/json"
	"math"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf16"
)

// Normalizer applies normalizeOptions with the environment values it needs.
// CrawlBaseURL is CRAWL4AI_BASE_URL; it only participates in the localhost
// proxy translation, which the proxy policy rejects before normalization on the
// create/retry paths.
type Normalizer struct {
	CrawlBaseURL string
}

// NewNormalizer builds a normalizer for the given crawl4ai base URL.
func NewNormalizer(crawlBaseURL string) *Normalizer {
	return &Normalizer{CrawlBaseURL: crawlBaseURL}
}

// Normalize is CrawlExecutionService.normalizeOptions for this environment.
func (n *Normalizer) Normalize(options *OptionsInput) Options {
	return normalizeOptions(options, n.CrawlBaseURL)
}

// NormalizeOptions is normalizeOptions with no configured crawl4ai base URL.
func NormalizeOptions(options *OptionsInput) Options {
	return normalizeOptions(options, "")
}

// normalizeOptions ports normalizeOptions line by line. The input is fully
// optional; every ?? default is reproduced because OptionsInput keeps pointer
// fields.
func normalizeOptions(options *OptionsInput, crawlBaseURL string) Options {
	if options == nil {
		options = &OptionsInput{}
	}

	storeMedia := boolValue(options.StoreMedia)
	includeImages := boolOr(options.IncludeImages, storeMedia)
	virtualScroll := normalizeVirtualScrollConfig(options.VirtualScroll)
	scanFullPage := false
	if virtualScroll == nil {
		scanFullPage = boolValue(options.ScanFullPage)
	}
	adjustViewport := scanFullPage
	if options.AdjustViewportToContent != nil {
		adjustViewport = *options.AdjustViewportToContent
	}
	var scrollDelayMs *int
	if scanFullPage {
		if options.ScrollDelayMs != nil {
			value := clampScrollDelay(float64(*options.ScrollDelayMs))
			scrollDelayMs = &value
		} else {
			value := 200
			scrollDelayMs = &value
		}
	}

	antiBotMode := "auto"
	if parsed := parseAntiBotMode(stringValue(options.AntiBotMode)); parsed != nil {
		antiBotMode = *parsed
	}
	enableStealthMode := boolValue(options.EnableStealthMode)
	simulateUser := boolOr(options.SimulateUser, enableStealthMode)
	overrideNavigator := boolOr(options.OverrideNavigator, enableStealthMode)
	userDataDir := normalizeUserDataDir(stringValue(options.UserDataDir))
	useManagedBrowser := boolOr(options.UseManagedBrowser, userDataDir != nil)

	proxyConfig := normalizeProxyConfig(options.ProxyConfig, crawlBaseURL)
	var proxyURL *string
	if proxyConfig == nil {
		proxyURL = normalizeProxyURL(stringValue(options.ProxyURL), crawlBaseURL)
	}
	additionalURLs := normalizeURLList(options.AdditionalURLs)
	multiURLConfigs := normalizeMultiURLConfigs(options.MultiURLConfigs, crawlBaseURL)

	qualityProfile := "quality_first"
	if parsed := parseQualityProfile(stringValue(options.QualityProfile)); parsed != nil {
		qualityProfile = *parsed
	}

	markdownOptionsInput := normalizeMarkdownOptionsInput(options.MarkdownOptions)
	contentSource := "cleaned_html"
	if qualityProfile == "speed_first" {
		contentSource = "raw_html"
	}
	if markdownOptionsInput != nil && markdownOptionsInput.ContentSource != nil {
		contentSource = *markdownOptionsInput.ContentSource
	}
	citations := true
	if markdownOptionsInput != nil && markdownOptionsInput.Citations != nil {
		citations = *markdownOptionsInput.Citations
	}
	markdownOptionsInput = &MarkdownOptionsInput{
		ContentSource: &contentSource,
		Citations:     &citations,
	}
	if options.MarkdownOptions != nil {
		markdownOptionsInput.IgnoreLinks = options.MarkdownOptions.IgnoreLinks
		markdownOptionsInput.EscapeHTML = options.MarkdownOptions.EscapeHTML
		markdownOptionsInput.BodyWidth = options.MarkdownOptions.BodyWidth
	}
	markdownOptions := normalizeMarkdownOptions(markdownOptionsInput)

	markdownFilter := normalizeMarkdownFilter(options.MarkdownFilter)
	markdownStrategy := normalizeMarkdownStrategy(options.MarkdownStrategy)
	tableScoreThreshold := normalizeTableScore(options.TableScoreThreshold)
	tableExtraction := normalizeTableExtraction(options.TableExtraction)

	cleanMarkdownSource := normalizeCleanMarkdownOptions(options.CleanMarkdown)
	excludedFallback := []string{"script", "style", "noscript"}
	if qualityProfile == "quality_first" {
		excludedFallback = []string{"nav", "footer", "aside", "script", "style", "noscript", "form"}
	}
	var mergedExcluded []string
	var targetElements []string
	removeOverlayElements := true
	wordCountThresholdDefault := 12
	if qualityProfile == "quality_first" {
		wordCountThresholdDefault = 18
	}
	if cleanMarkdownSource != nil {
		mergedExcluded = append(mergedExcluded, cleanMarkdownSource.ExcludedTags...)
		targetElements = cleanMarkdownSource.TargetElements
		if cleanMarkdownSource.RemoveOverlayElements != nil {
			removeOverlayElements = *cleanMarkdownSource.RemoveOverlayElements
		}
		if cleanMarkdownSource.WordCountThreshold != nil {
			wordCountThresholdDefault = *cleanMarkdownSource.WordCountThreshold
		}
	}
	mergedExcluded = append(mergedExcluded, excludedFallback...)
	// cssSelector is deliberately dropped: the normalized document only keeps
	// targetElements, the merged excludedTags, removeOverlayElements and the
	// profile-dependent word threshold.
	cleanMarkdown := normalizeCleanMarkdownOptions(&CleanMarkdownInput{
		TargetElements:        targetElements,
		ExcludedTags:          mergeSelectorValues(mergedExcluded),
		RemoveOverlayElements: &removeOverlayElements,
		WordCountThreshold:    &wordCountThresholdDefault,
	})

	linkPreview := normalizeLinkPreviewOptions(options.LinkPreview)
	scoreLinks := boolOr(options.ScoreLinks, linkPreview != nil)
	jsCode := normalizeScriptList(options.JSCode)

	waitForSelector := normalizeWaitForSelector(stringValue(options.WaitForSelector))
	waitForScript := normalizeWaitForScript(stringValue(options.WaitForScript))
	waitForTimeoutMs := normalizeWaitForTimeout(options.WaitForTimeoutMs)
	waitUntil := normalizeWaitUntil(stringValue(options.WaitUntil))
	normalizedWaitForTimeoutMs := waitForTimeoutMs
	if waitUntil != nil && *waitUntil == "networkidle" && waitForTimeoutMs != nil {
		value := *waitForTimeoutMs
		if value < 5000 {
			value = 5000
		}
		normalizedWaitForTimeoutMs = &value
	}
	pageTimeoutMs := normalizePageTimeoutMs(options.PageTimeoutMs)
	delayBeforeReturnHTMLMs := normalizeDelayBeforeReturnHTMLMs(options.DelayBeforeReturnHTMLMs)
	meanDelayMs := normalizeDelayJitterMs(options.MeanDelayMs)
	maxDelayRangeMs := normalizeDelayJitterMs(options.MaxDelayRangeMs)
	semaphoreCount := normalizeSemaphoreCount(options.SemaphoreCount)
	sessionID := normalizeSessionID(stringValue(options.SessionID))
	storageState := normalizeStorageState(stringValue(options.StorageState))
	browserHeaders := normalizeBrowserHeaders(options.BrowserHeaders)
	browserCookies := normalizeBrowserCookies(options.BrowserCookies)
	userAgent := normalizeUserAgent(stringValue(options.UserAgent))

	var userAgentMode *string
	var userAgentGenerator *UserAgentGenerator
	if userAgent == nil {
		mode := "random"
		if parsed := normalizeUserAgentMode(stringValue(options.UserAgentMode)); parsed != nil {
			mode = *parsed
		}
		userAgentMode = &mode
		userAgentGenerator = normalizeUserAgentGenerator(options.UserAgentGenerator)
	}
	locale := normalizeLocale(stringValue(options.Locale))
	timezoneID := normalizeTimezone(stringValue(options.TimezoneID))
	geolocation := normalizeGeolocation(options.Geolocation)
	wordCountThresholdDefault := 80
	if options.WordCountThreshold != nil {
		wordCountThresholdDefault = *options.WordCountThreshold
	}
	wordCountThreshold := normalizeWordCountThreshold(&wordCountThresholdDefault)
	excludeExternalLinks := boolOr(options.ExcludeExternalLinks, true)
	excludeExternalImages := boolOr(options.ExcludeExternalImages, !storeMedia)
	removeOverlayElements := boolOr(options.RemoveOverlayElements, true)
	processIframes := boolOr(options.ProcessIframes, true)
	textMode := boolValue(options.TextMode)
	captureScreenshot := boolValue(options.CaptureScreenshot)
	cssSelector := normalizeCSSSelector(stringValue(options.CSSSelector))
	excludedTags := normalizeSelectorList(options.ExcludedTags)
	waitForImages := boolOr(options.WaitForImages, storeMedia)
	removeForms := boolValue(options.RemoveForms)
	pageTypeHint := parsePageTypeHint(stringValue(options.PageTypeHint))
	autoExpandDetails := true
	if options.AutoExpandDetails != nil {
		autoExpandDetails = *options.AutoExpandDetails
	}
	detailExpansion := normalizeDetailExpansionOptions(options.DetailExpansion)

	return Options{
		IncludeImages:           includeImages,
		StoreMedia:              storeMedia,
		OnlyMainContent:         boolOr(options.OnlyMainContent, true),
		ExtractLinks:            boolValue(options.ExtractLinks),
		CacheMode:               stringOr(options.CacheMode, "bypass"),
		Prefetch:                boolValue(options.Prefetch),
		ScanFullPage:            scanFullPage,
		AdjustViewportToContent: adjustViewport,
		ScrollDelayMs:           scrollDelayMs,
		Headless:                options.Headless,
		EnableUndetectedBrowser: boolValue(options.EnableUndetectedBrowser),
		AntiBotMode:             antiBotMode,
		EnableStealthMode:       enableStealthMode,
		UseManagedBrowser:       useManagedBrowser,
		UserDataDir:             userDataDir,
		SimulateUser:            simulateUser,
		OverrideNavigator:       overrideNavigator,
		JSCode:                  jsCode,
		JSOnly:                  boolValue(options.JSOnly),
		WaitForSelector:         waitForSelector,
		WaitForScript:           waitForScript,
		WaitForTimeoutMs:        normalizedWaitForTimeoutMs,
		WaitUntil:               waitUntil,
		PageTimeoutMs:           pageTimeoutMs,
		DelayBeforeReturnHTMLMs: delayBeforeReturnHTMLMs,
		MeanDelayMs:             meanDelayMs,
		MaxDelayRangeMs:         maxDelayRangeMs,
		SemaphoreCount:          semaphoreCount,
		ProxyConfig:             proxyConfig,
		ProxyURL:                proxyURL,
		AdditionalURLs:          additionalURLs,
		MultiURLConfigs:         multiURLConfigs,
		MarkdownOptions:         markdownOptions,
		MarkdownFilter:          markdownFilter,
		MarkdownStrategy:        markdownStrategy,
		TableScoreThreshold:     tableScoreThreshold,
		TableExtraction:         tableExtraction,
		CleanMarkdown:           cleanMarkdown,
		ScoreLinks:              scoreLinks,
		LinkPreview:             linkPreview,
		BrowserHeaders:          browserHeaders,
		BrowserCookies:          browserCookies,
		UserAgent:               userAgent,
		UserAgentMode:           userAgentMode,
		UserAgentGenerator:      userAgentGenerator,
		Locale:                  locale,
		TimezoneID:              timezoneID,
		Geolocation:             geolocation,
		SessionID:               sessionID,
		StorageState:            storageState,
		WordCountThreshold:      wordCountThreshold,
		ExcludeExternalLinks:    excludeExternalLinks,
		RemoveOverlayElements:   removeOverlayElements,
		ProcessIframes:          processIframes,
		TextMode:                textMode,
		CaptureScreenshot:       captureScreenshot,
		CSSSelector:             cssSelector,
		ExcludedTags:            excludedTags,
		VirtualScroll:           virtualScroll,
		ExcludeExternalImages:   excludeExternalImages,
		WaitForImages:           waitForImages,
		RemoveForms:             removeForms,
		PageTypeHint:            pageTypeHint,
		AutoExpandDetails:       autoExpandDetails,
		DetailExpansion:         detailExpansion,
		QualityProfile:          qualityProfile,
	}
}

// ---------------------------------------------------------------------------
// crawl-options.helpers.ts
// ---------------------------------------------------------------------------

// clampScrollDelay mirrors clampScrollDelay: NaN becomes 200; otherwise the
// value is rounded and clamped into [0, 5000].
func clampScrollDelay(value float64) int {
	if math.IsNaN(value) {
		return 200
	}
	return clampInt(jsRound(value), 0, 5000)
}

func normalizeSessionID(value string) *string {
	return truncateTrimmed(value, 160)
}

func normalizeUserDataDir(value string) *string {
	return truncateTrimmed(value, 512)
}

func normalizeStorageState(value string) *string {
	return truncateTrimmed(value, 12000)
}

// normalizeURLList trims, drops empties, deduplicates in first-occurrence order
// and returns nil for an empty result.
func normalizeURLList(urls []string) []string {
	if len(urls) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(urls))
	out := make([]string, 0, len(urls))
	for _, entry := range urls {
		trimmed := strings.TrimSpace(entry)
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

func normalizeMatcher(matcher *URLMatcher) *URLMatcher {
	if matcher == nil {
		return nil
	}
	patterns := normalizePatternEntries(matcher.Patterns, 0)
	if len(patterns) == 0 {
		return nil
	}
	return &URLMatcher{MatchMode: matcher.MatchMode, Patterns: patterns}
}

func normalizeMarkdownOptionsInput(input *MarkdownOptionsInput) *MarkdownOptionsInput {
	if input == nil {
		return nil
	}
	normalized := &MarkdownOptionsInput{}
	if input.ContentSource != nil && isMarkdownContentSource(*input.ContentSource) {
		value := *input.ContentSource
		normalized.ContentSource = &value
	}
	if input.IgnoreLinks != nil {
		value := *input.IgnoreLinks
		normalized.IgnoreLinks = &value
	}
	if input.EscapeHTML != nil {
		value := *input.EscapeHTML
		normalized.EscapeHTML = &value
	}
	if input.Citations != nil {
		value := *input.Citations
		normalized.Citations = &value
	}
	if input.BodyWidth != nil && isFinite(float64(*input.BodyWidth)) {
		value := clampInt(jsRound(float64(*input.BodyWidth)), 40, 200)
		normalized.BodyWidth = &value
	}
	if normalized.ContentSource == nil && normalized.IgnoreLinks == nil &&
		normalized.EscapeHTML == nil && normalized.Citations == nil &&
		normalized.BodyWidth == nil {
		return nil
	}
	return normalized
}

func normalizeMarkdownOptions(input *MarkdownOptionsInput) *MarkdownOptions {
	normalized := normalizeMarkdownOptionsInput(input)
	if normalized == nil {
		return nil
	}
	return &MarkdownOptions{
		ContentSource: normalized.ContentSource,
		IgnoreLinks:   normalized.IgnoreLinks,
		EscapeHTML:    normalized.EscapeHTML,
		Citations:     normalized.Citations,
		BodyWidth:     normalized.BodyWidth,
	}
}

func isMarkdownContentSource(value string) bool {
	return value == "raw_html" || value == "cleaned_html" || value == "fit_html"
}

// normalizeSelectorList trims, drops empties, caps at ten entries and
// deduplicates preserving order.
func normalizeSelectorList(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	normalized := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		normalized = append(normalized, trimmed)
		if len(normalized) == 10 {
			break
		}
	}
	if len(normalized) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(normalized))
	out := make([]string, 0, len(normalized))
	for _, value := range normalized {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func normalizeCSSSelector(value string) *string {
	return truncateTrimmed(value, 512)
}

func normalizeWordCountThreshold(value *int) *int {
	if value == nil {
		return nil
	}
	clamped := clampInt(*value, 0, 5000)
	return &clamped
}

// normalizeMarkdownFilter mirrors normalizeMarkdownFilter in
// crawl-options.helpers.ts (the strict, type-discriminated form).
func normalizeMarkdownFilter(filter *MarkdownFilter) *MarkdownFilter {
	if filter == nil {
		return nil
	}
	if filter.Type == "pruning" {
		normalized := &MarkdownFilter{Type: "pruning"}
		if filter.Threshold != nil && isFinite(*filter.Threshold) {
			value := clampFloat(*filter.Threshold, 0, 1)
			normalized.Threshold = &value
		}
		if filter.ThresholdType != nil && (*filter.ThresholdType == "fixed" || *filter.ThresholdType == "dynamic") {
			value := *filter.ThresholdType
			normalized.ThresholdType = &value
		}
		if filter.MinWordThreshold != nil && isFinite(float64(*filter.MinWordThreshold)) {
			value := clampInt(jsRound(float64(*filter.MinWordThreshold)), 0, 500)
			normalized.MinWordThreshold = &value
		}
		return normalized
	}
	if filter.Type == "bm25" {
		normalized := &MarkdownFilter{Type: "bm25"}
		if filter.UserQuery != nil {
			trimmed := strings.TrimSpace(*filter.UserQuery)
			if trimmed != "" {
				value := sliceUTF16(trimmed, 240)
				normalized.UserQuery = &value
			}
		}
		if filter.BM25Threshold != nil && isFinite(*filter.BM25Threshold) {
			value := jsToFixedNumber(clampFloat(*filter.BM25Threshold, 0, 20), 2)
			normalized.BM25Threshold = &value
		}
		if filter.Language != nil {
			trimmed := strings.TrimSpace(*filter.Language)
			if trimmed != "" {
				value := sliceUTF16(trimmed, 32)
				normalized.Language = &value
			}
		}
		if normalized.UserQuery == nil {
			return nil
		}
		return normalized
	}
	return nil
}

// NormalizeMarkdownFilterForTask is CrawlTaskService.normalizeMarkdownFilter:
// unlike the helper above it defaults an unknown filter type to pruning.
func NormalizeMarkdownFilterForTask(filter *MarkdownFilter) *MarkdownFilter {
	if filter == nil {
		return nil
	}
	if filter.Type == "bm25" {
		query := ""
		if filter.UserQuery != nil {
			query = strings.TrimSpace(*filter.UserQuery)
		}
		if query == "" {
			return nil
		}
		normalized := &MarkdownFilter{Type: "bm25", UserQuery: &query}
		if filter.BM25Threshold != nil {
			value := *filter.BM25Threshold
			normalized.BM25Threshold = &value
		}
		if filter.Language != nil {
			value := strings.TrimSpace(*filter.Language)
			normalized.Language = &value
		}
		return normalized
	}
	return &MarkdownFilter{
		Type:             "pruning",
		Threshold:        filter.Threshold,
		ThresholdType:    filter.ThresholdType,
		MinWordThreshold: filter.MinWordThreshold,
	}
}

func normalizeTableScore(value *float64) *float64 {
	if value == nil || math.IsNaN(*value) {
		return nil
	}
	clamped := jsToFixedNumber(clampFloat(*value, 0, 10), 2)
	return &clamped
}

// normalizeStrategyParams re-serializes a JSON object, which is what
// JSON.parse(JSON.stringify(params)) does, and returns nil for non-objects.
func normalizeStrategyParams(params json.RawMessage) json.RawMessage {
	if len(params) == 0 {
		return nil
	}
	var raw any
	if err := json.Unmarshal(params, &raw); err != nil {
		return nil
	}
	if _, ok := raw.(map[string]any); !ok {
		return nil
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return nil
	}
	return encoded
}

func normalizeBrowserHeaders(headers []BrowserHeader) []BrowserHeader {
	if len(headers) == 0 {
		return nil
	}
	normalized := make([]BrowserHeader, 0, len(headers))
	for _, header := range headers {
		name := normalizeHeaderName(header.Name)
		value := normalizeHeaderValue(header.Value)
		if name == "" || value == "" {
			continue
		}
		normalized = append(normalized, BrowserHeader{
			Name:  sliceUTF16(name, 128),
			Value: sliceUTF16(value, 512),
		})
	}
	if len(normalized) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(normalized))
	unique := make([]BrowserHeader, 0, len(normalized))
	for _, header := range normalized {
		key := strings.ToLower(header.Name)
		if seen[key] {
			continue
		}
		seen[key] = true
		unique = append(unique, header)
		if len(unique) == 20 {
			break
		}
	}
	return unique
}

func normalizeHeaderName(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || hasControlChars(trimmed) {
		return ""
	}
	for _, r := range trimmed {
		if !isHeaderNameRune(r) {
			return ""
		}
	}
	return trimmed
}

func normalizeHeaderValue(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || hasControlChars(trimmed) {
		return ""
	}
	return trimmed
}

func isHeaderNameRune(r rune) bool {
	if r >= '0' && r <= '9' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' {
		return true
	}
	switch r {
	case '!', '#', '$', '%', '&', '\'', '*', '+', '.', '^', '_', '`', '|', '~', '-':
		return true
	}
	return false
}

func hasControlChars(value string) bool {
	for _, r := range value {
		if r <= 0x1f || r == 0x7f {
			return true
		}
	}
	return false
}

func normalizeBrowserCookies(cookies []BrowserCookie) []BrowserCookie {
	if len(cookies) == 0 {
		return nil
	}
	normalized := make([]BrowserCookie, 0, len(cookies))
	for _, cookie := range cookies {
		name := strings.TrimSpace(cookie.Name)
		value := strings.TrimSpace(cookie.Value)
		domain := strings.TrimSpace(cookie.Domain)
		if name == "" || value == "" || domain == "" {
			continue
		}
		var path *string
		if cookie.Path != nil {
			trimmed := strings.TrimSpace(*cookie.Path)
			if trimmed != "" {
				value := sliceUTF16(trimmed, 255)
				path = &value
			}
		}
		normalized = append(normalized, BrowserCookie{
			Name:   sliceUTF16(name, 128),
			Value:  sliceUTF16(value, 4000),
			Domain: sliceUTF16(domain, 255),
			Path:   path,
		})
	}
	if len(normalized) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(normalized))
	deduped := make([]BrowserCookie, 0, len(normalized))
	for _, cookie := range normalized {
		pathKey := ""
		if cookie.Path != nil {
			pathKey = *cookie.Path
		}
		key := strings.ToLower(cookie.Name) + "|" + strings.ToLower(cookie.Domain) + "|" + pathKey
		if seen[key] {
			continue
		}
		seen[key] = true
		deduped = append(deduped, cookie)
		if len(deduped) == 20 {
			break
		}
	}
	return deduped
}

func normalizeUserAgent(value string) *string {
	return truncateTrimmed(value, 768)
}

func normalizeUserAgentMode(value string) *string {
	if value == "random" {
		copied := value
		return &copied
	}
	return nil
}

func normalizeUserAgentGenerator(input *UserAgentGenerator) *UserAgentGenerator {
	if input == nil {
		return nil
	}
	normalized := &UserAgentGenerator{}
	if input.Platform != nil && oneOf(*input.Platform, "windows", "macos", "linux", "android", "ios") {
		value := *input.Platform
		normalized.Platform = &value
	}
	if input.Browser != nil && oneOf(*input.Browser, "chrome", "firefox", "safari", "edge") {
		value := *input.Browser
		normalized.Browser = &value
	}
	if input.DeviceType != nil && oneOf(*input.DeviceType, "desktop", "mobile", "tablet") {
		value := *input.DeviceType
		normalized.DeviceType = &value
	}
	if input.Locale != nil {
		if value := truncateTrimmed(*input.Locale, 16); value != nil {
			normalized.Locale = value
		}
	}
	if normalized.Platform == nil && normalized.Browser == nil &&
		normalized.DeviceType == nil && normalized.Locale == nil {
		return nil
	}
	return normalized
}

func normalizeLocale(value string) *string {
	return truncateTrimmed(value, 16)
}

func normalizeTimezone(value string) *string {
	return truncateTrimmed(value, 64)
}

func normalizeGeolocation(value *Geolocation) *Geolocation {
	if value == nil {
		return nil
	}
	latitude := clampFloat(value.Latitude, -90, 90)
	longitude := clampFloat(value.Longitude, -180, 180)
	normalized := &Geolocation{Latitude: latitude, Longitude: longitude}
	if value.Accuracy != nil && isFinite(*value.Accuracy) {
		accuracy := clampFloat(*value.Accuracy, 1, 5000)
		normalized.Accuracy = &accuracy
	}
	return normalized
}

func normalizePatternList(patterns []string) []string {
	if len(patterns) == 0 {
		return nil
	}
	normalized := make([]string, 0, len(patterns))
	for _, entry := range patterns {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		normalized = append(normalized, trimmed)
	}
	if len(normalized) == 0 {
		return nil
	}
	unique := make([]string, 0, len(normalized))
	for _, pattern := range normalized {
		duplicate := false
		for _, existing := range unique {
			if existing == pattern {
				duplicate = true
				break
			}
		}
		if duplicate {
			continue
		}
		unique = append(unique, pattern)
		if len(unique) == 25 {
			break
		}
	}
	return unique
}

func normalizePatternEntries(patterns []string, limit int) []string {
	normalized := make([]string, 0, len(patterns))
	for _, entry := range patterns {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		normalized = append(normalized, trimmed)
		if limit > 0 && len(normalized) == limit {
			break
		}
	}
	return normalized
}

func normalizeScriptList(entries []string) []string {
	if len(entries) == 0 {
		return nil
	}
	normalized := make([]string, 0, len(entries))
	for _, entry := range entries {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		normalized = append(normalized, trimmed)
	}
	if len(normalized) == 0 {
		return nil
	}
	if len(normalized) > 10 {
		normalized = normalized[:10]
	}
	return normalized
}

func normalizeWaitForSelector(selector string) *string {
	return truncateTrimmed(selector, 1024)
}

func normalizeWaitForScript(script string) *string {
	return truncateTrimmed(script, 4000)
}

func normalizeWaitForTimeout(value *int) *int {
	if value == nil {
		return nil
	}
	clamped := clampInt(*value, 500, 60000)
	return &clamped
}

func normalizeWaitUntil(value string) *string {
	trimmed := strings.ToLower(strings.TrimSpace(value))
	if trimmed == "" {
		return nil
	}
	switch trimmed {
	case "domcontentloaded", "load", "networkidle", "commit":
		copied := trimmed
		return &copied
	}
	return nil
}

func normalizePageTimeoutMs(value *int) *int {
	if value == nil {
		return nil
	}
	clamped := clampInt(*value, 1000, 180000)
	return &clamped
}

func normalizeDelayBeforeReturnHTMLMs(value *int) *int {
	if value == nil {
		return nil
	}
	clamped := clampInt(*value, 0, 30000)
	return &clamped
}

func normalizeDelayJitterMs(value *int) *int {
	if value == nil {
		return nil
	}
	clamped := clampInt(*value, 0, 10000)
	return &clamped
}

func normalizeSemaphoreCount(value *int) *int {
	if value == nil {
		return nil
	}
	clamped := clampInt(*value, 1, 50)
	return &clamped
}

// ---------------------------------------------------------------------------
// normalizer private helpers
// ---------------------------------------------------------------------------

func parsePageTypeHint(value string) *string {
	if value == "auto" || value == "list" || value == "detail" {
		copied := value
		return &copied
	}
	return nil
}

func parseAntiBotMode(value string) *string {
	if value == "auto" || value == "enabled" || value == "disabled" {
		copied := value
		return &copied
	}
	return nil
}

func parseQualityProfile(value string) *string {
	if value == "balanced" || value == "quality_first" || value == "speed_first" {
		copied := value
		return &copied
	}
	return nil
}

func normalizeProxyURL(value, crawlBaseURL string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	translated := translateLocalhostProxyURL(trimmed, crawlBaseURL)
	return &translated
}

func normalizeProxyConfig(value *ProxyConfig, crawlBaseURL string) *ProxyConfig {
	if value == nil {
		return nil
	}
	server := strings.TrimSpace(value.Server)
	if server == "" {
		return nil
	}
	normalized := &ProxyConfig{Server: translateLocalhostProxyURL(server, crawlBaseURL)}
	if value.Username != nil {
		if username := strings.TrimSpace(*value.Username); username != "" {
			normalized.Username = &username
		}
	}
	if value.Password != nil {
		if password := strings.TrimSpace(*value.Password); password != "" {
			normalized.Password = &password
		}
	}
	return normalized
}

func normalizeMultiURLConfigs(configs []MultiURLConfig, crawlBaseURL string) []MultiURLConfig {
	if len(configs) == 0 {
		return nil
	}
	normalized := make([]MultiURLConfig, 0, len(configs))
	for index := range configs {
		config := normalizeMultiURLConfig(&configs[index], crawlBaseURL)
		if config != nil {
			normalized = append(normalized, *config)
		}
	}
	if len(normalized) == 0 {
		return nil
	}
	return normalized
}

func normalizeMultiURLConfig(config *MultiURLConfig, crawlBaseURL string) *MultiURLConfig {
	if config == nil {
		return nil
	}
	var name *string
	if config.Name != nil {
		trimmed := strings.TrimSpace(*config.Name)
		name = &trimmed
	}
	matcher := normalizeMatcher(config.Matcher)
	urls := normalizeURLList(config.URLs)
	options := normalizeStrategyOverrides(config.Options, crawlBaseURL)
	if matcher == nil && len(urls) == 0 {
		return nil
	}
	return &MultiURLConfig{Name: name, Matcher: matcher, URLs: urls, Options: options}
}

func normalizeStrategyOverrides(overrides *StrategyOverrides, crawlBaseURL string) *StrategyOverrides {
	if overrides == nil {
		return nil
	}
	normalized := &StrategyOverrides{}
	if overrides.CacheMode != nil && *overrides.CacheMode != "" {
		value := *overrides.CacheMode
		normalized.CacheMode = &value
	}
	if overrides.OnlyMainContent != nil {
		value := *overrides.OnlyMainContent
		normalized.OnlyMainContent = &value
	}
	if overrides.ExtractLinks != nil {
		value := *overrides.ExtractLinks
		normalized.ExtractLinks = &value
	}
	if overrides.ScanFullPage != nil {
		value := *overrides.ScanFullPage
		normalized.ScanFullPage = &value
	}
	if overrides.AdjustViewportToContent != nil {
		value := *overrides.AdjustViewportToContent
		normalized.AdjustViewportToContent = &value
	}
	if overrides.ScrollDelayMs != nil && overrides.ScanFullPage != nil && *overrides.ScanFullPage {
		value := clampScrollDelay(float64(*overrides.ScrollDelayMs))
		normalized.ScrollDelayMs = &value
	}
	if overrides.SimulateUser != nil {
		value := *overrides.SimulateUser
		normalized.SimulateUser = &value
	}
	if overrides.OverrideNavigator != nil {
		value := *overrides.OverrideNavigator
		normalized.OverrideNavigator = &value
	}
	if jsCode := normalizeScriptList(overrides.JSCode); jsCode != nil {
		normalized.JSCode = jsCode
	}
	if overrides.JSOnly != nil {
		value := *overrides.JSOnly
		normalized.JSOnly = &value
	}
	if value := normalizeWaitForSelector(stringValue(overrides.WaitForSelector)); value != nil {
		normalized.WaitForSelector = value
	}
	if value := normalizeWaitForScript(stringValue(overrides.WaitForScript)); value != nil {
		normalized.WaitForScript = value
	}
	waitUntil := normalizeWaitUntil(stringValue(overrides.WaitUntil))
	if waitUntil != nil {
		normalized.WaitUntil = waitUntil
	}
	waitForTimeout := normalizeWaitForTimeout(overrides.WaitForTimeoutMs)
	if waitForTimeout != nil {
		value := *waitForTimeout
		if waitUntil != nil && *waitUntil == "networkidle" && value < 5000 {
			value = 5000
		}
		normalized.WaitForTimeoutMs = &value
	}
	if value := normalizePageTimeoutMs(overrides.PageTimeoutMs); value != nil {
		normalized.PageTimeoutMs = value
	}
	if value := normalizeDelayBeforeReturnHTMLMs(overrides.DelayBeforeReturnHTMLMs); value != nil {
		normalized.DelayBeforeReturnHTMLMs = value
	}
	if value := normalizeDelayJitterMs(overrides.MeanDelayMs); value != nil {
		normalized.MeanDelayMs = value
	}
	if value := normalizeDelayJitterMs(overrides.MaxDelayRangeMs); value != nil {
		normalized.MaxDelayRangeMs = value
	}
	if value := normalizeSemaphoreCount(overrides.SemaphoreCount); value != nil {
		normalized.SemaphoreCount = value
	}
	if overrides.RemoveForms != nil {
		value := *overrides.RemoveForms
		normalized.RemoveForms = &value
	}
	if value := normalizeWordCountThreshold(overrides.WordCountThreshold); value != nil {
		normalized.WordCountThreshold = value
	}
	if overrides.ExcludeExternalLinks != nil {
		value := *overrides.ExcludeExternalLinks
		normalized.ExcludeExternalLinks = &value
	}
	if overrides.ExcludeExternalImages != nil {
		value := *overrides.ExcludeExternalImages
		normalized.ExcludeExternalImages = &value
	}
	if overrides.RemoveOverlayElements != nil {
		value := *overrides.RemoveOverlayElements
		normalized.RemoveOverlayElements = &value
	}
	if overrides.ProcessIframes != nil {
		value := *overrides.ProcessIframes
		normalized.ProcessIframes = &value
	}
	if overrides.TextMode != nil {
		value := *overrides.TextMode
		normalized.TextMode = &value
	}
	if overrides.WaitForImages != nil {
		value := *overrides.WaitForImages
		normalized.WaitForImages = &value
	}
	if overrides.CaptureScreenshot != nil {
		value := *overrides.CaptureScreenshot
		normalized.CaptureScreenshot = &value
	}
	if value := normalizeCSSSelector(stringValue(overrides.CSSSelector)); value != nil {
		normalized.CSSSelector = value
	}
	if value := normalizeSelectorList(overrides.ExcludedTags); value != nil {
		normalized.ExcludedTags = value
	}
	if virtualScroll := normalizeVirtualScrollConfig(overrides.VirtualScroll); virtualScroll != nil {
		normalized.VirtualScroll = virtualScroll
		if normalized.ScanFullPage != nil && *normalized.ScanFullPage {
			value := false
			normalized.ScanFullPage = &value
			normalized.ScrollDelayMs = nil
		}
	}
	if value := parsePageTypeHint(stringValue(overrides.PageTypeHint)); value != nil {
		normalized.PageTypeHint = value
	}
	if overrides.AutoExpandDetails != nil {
		value := *overrides.AutoExpandDetails
		normalized.AutoExpandDetails = &value
	}
	if value := normalizeDetailExpansionOptions(overrides.DetailExpansion); value != nil {
		normalized.DetailExpansion = value
	}
	if value := parseQualityProfile(stringValue(overrides.QualityProfile)); value != nil {
		normalized.QualityProfile = value
	}
	if emptyStrategyOverrides(normalized) {
		return nil
	}
	return normalized
}

func emptyStrategyOverrides(value *StrategyOverrides) bool {
	return value.CacheMode == nil && value.OnlyMainContent == nil && value.ExtractLinks == nil &&
		value.ScanFullPage == nil && value.AdjustViewportToContent == nil && value.ScrollDelayMs == nil &&
		value.SimulateUser == nil && value.OverrideNavigator == nil && value.JSCode == nil &&
		value.JSOnly == nil && value.WaitForSelector == nil && value.WaitForScript == nil &&
		value.WaitUntil == nil && value.WaitForTimeoutMs == nil && value.PageTimeoutMs == nil &&
		value.DelayBeforeReturnHTMLMs == nil && value.MeanDelayMs == nil && value.MaxDelayRangeMs == nil &&
		value.SemaphoreCount == nil && value.RemoveForms == nil && value.WordCountThreshold == nil &&
		value.ExcludeExternalLinks == nil && value.ExcludeExternalImages == nil &&
		value.RemoveOverlayElements == nil && value.ProcessIframes == nil && value.TextMode == nil &&
		value.WaitForImages == nil && value.CaptureScreenshot == nil && value.CSSSelector == nil &&
		value.ExcludedTags == nil && value.VirtualScroll == nil && value.PageTypeHint == nil &&
		value.AutoExpandDetails == nil && value.DetailExpansion == nil && value.QualityProfile == nil
}

func normalizeCleanMarkdownOptions(options *CleanMarkdownInput) *CleanMarkdown {
	if options == nil {
		return nil
	}
	normalized := &CleanMarkdown{}
	if options.CSSSelector != nil {
		trimmed := strings.TrimSpace(*options.CSSSelector)
		if trimmed != "" {
			value := sliceUTF16(trimmed, 512)
			normalized.CSSSelector = &value
		}
	}
	if targetElements := normalizeSelectorList(options.TargetElements); targetElements != nil {
		normalized.TargetElements = targetElements
	}
	if excludedTags := normalizeSelectorList(options.ExcludedTags); excludedTags != nil {
		normalized.ExcludedTags = excludedTags
	}
	if options.RemoveOverlayElements != nil {
		value := *options.RemoveOverlayElements
		normalized.RemoveOverlayElements = &value
	}
	if options.WordCountThreshold != nil {
		value := clampInt(*options.WordCountThreshold, 0, 2000)
		normalized.WordCountThreshold = &value
	}
	if normalized.CSSSelector == nil && normalized.TargetElements == nil &&
		normalized.ExcludedTags == nil && normalized.RemoveOverlayElements == nil &&
		normalized.WordCountThreshold == nil {
		return nil
	}
	return normalized
}

func mergeSelectorValues(values []string) []string {
	return normalizeSelectorList(values)
}

func normalizeVirtualScrollConfig(config *VirtualScroll) *VirtualScroll {
	if config == nil {
		return nil
	}
	containerSelector := normalizeCSSSelector(config.ContainerSelector)
	var scrollCount *int
	if config.ScrollCount != nil && isFinite(float64(*config.ScrollCount)) {
		value := clampInt(jsRound(float64(*config.ScrollCount)), 1, 1000)
		scrollCount = &value
	}
	scrollBy := normalizeScrollBy(config.ScrollBy, config.ScrollByPixels)
	var waitAfterScrollMs *int
	if config.WaitAfterScrollMs != nil && isFinite(float64(*config.WaitAfterScrollMs)) {
		value := clampInt(jsRound(float64(*config.WaitAfterScrollMs)), 0, 60000)
		waitAfterScrollMs = &value
	}
	hasValue := containerSelector != nil || scrollCount != nil || waitAfterScrollMs != nil || scrollBy != nil
	if !hasValue {
		return nil
	}
	if containerSelector == nil {
		body := "body"
		containerSelector = &body
	}
	return &VirtualScroll{
		ContainerSelector: *containerSelector,
		ScrollCount:       scrollCount,
		ScrollBy:          scrollBy,
		WaitAfterScrollMs: waitAfterScrollMs,
	}
}

func normalizeScrollBy(raw, pixelsRaw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	switch typed := value.(type) {
	case string:
		switch typed {
		case "container_height":
			return raw
		case "page_height":
			return raw
		case "viewport":
			return mustJSON("page_height")
		case "pixels":
			pixels := 500
			if value, ok := jsToNumber(pixelsRaw); ok && isFinite(value) {
				pixels = clampInt(jsRound(value), 1, 20000)
			}
			return mustJSON(pixels)
		}
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return nil
		}
		if isDigits(trimmed) {
			if parsed, err := strconv.Atoi(trimmed); err == nil {
				return mustJSON(clampInt(parsed, 1, 20000))
			}
		}
		return nil
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return nil
		}
		return mustJSON(clampInt(jsRound(typed), 1, 20000))
	default:
		return nil
	}
}

func isDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func normalizeMarkdownStrategy(strategy *MarkdownStrategyInput) *Strategy {
	if strategy == nil || strategy.Type == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*strategy.Type)
	if trimmed == "" {
		return nil
	}
	normalized := &Strategy{Type: sliceUTF16(trimmed, 128)}
	if params := normalizeStrategyParams(strategy.Params); params != nil {
		normalized.Params = params
	}
	return normalized
}

func normalizeTableExtraction(strategy *TableExtractionInput) *Strategy {
	if strategy == nil || strategy.Type == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*strategy.Type)
	if trimmed == "" {
		return nil
	}
	normalized := &Strategy{Type: sliceUTF16(trimmed, 128)}
	if params := normalizeStrategyParams(strategy.Params); params != nil {
		normalized.Params = params
	}
	return normalized
}

func normalizeDetailExpansionOptions(value *DetailExpansion) *DetailExpansion {
	if value == nil {
		return nil
	}
	normalized := &DetailExpansion{}
	if value.MaxDetailUrls != nil && isFinite(float64(*value.MaxDetailUrls)) {
		v := clampInt(jsRound(float64(*value.MaxDetailUrls)), 1, 30)
		normalized.MaxDetailUrls = &v
	}
	if value.MinRelevanceScore != nil && isFinite(*value.MinRelevanceScore) {
		v := clampFloat(jsToFixedNumber(*value.MinRelevanceScore, 3), 0, 1)
		normalized.MinRelevanceScore = &v
	}
	if value.RequireSameDomain != nil {
		v := *value.RequireSameDomain
		normalized.RequireSameDomain = &v
	}
	if value.AllowExternalLinks != nil {
		v := *value.AllowExternalLinks
		normalized.AllowExternalLinks = &v
	}
	if patterns := normalizePatternList(value.IncludeURLPatterns); patterns != nil {
		normalized.IncludeURLPatterns = patterns
	}
	if patterns := normalizePatternList(value.ExcludeURLPatterns); patterns != nil {
		normalized.ExcludeURLPatterns = patterns
	}
	if value.MinPublishTimeConfidence != nil && isFinite(*value.MinPublishTimeConfidence) {
		v := clampFloat(jsToFixedNumber(*value.MinPublishTimeConfidence, 3), 0, 1)
		normalized.MinPublishTimeConfidence = &v
	}
	if value.PreferFitMarkdownForQuality != nil {
		v := *value.PreferFitMarkdownForQuality
		normalized.PreferFitMarkdownForQuality = &v
	}
	if normalized.MaxDetailUrls == nil && normalized.MinRelevanceScore == nil &&
		normalized.RequireSameDomain == nil && normalized.AllowExternalLinks == nil &&
		normalized.IncludeURLPatterns == nil && normalized.ExcludeURLPatterns == nil &&
		normalized.MinPublishTimeConfidence == nil && normalized.PreferFitMarkdownForQuality == nil {
		return nil
	}
	return normalized
}

func normalizeLinkPreviewOptions(options *LinkPreviewOptionsInput) *LinkPreviewOptions {
	if options == nil {
		return nil
	}
	normalized := &LinkPreviewOptions{}
	if options.IncludeInternal != nil {
		v := *options.IncludeInternal
		normalized.IncludeInternal = &v
	}
	if options.IncludeExternal != nil {
		v := *options.IncludeExternal
		normalized.IncludeExternal = &v
	}
	if options.IncludeSocial != nil {
		v := *options.IncludeSocial
		normalized.IncludeSocial = &v
	}
	if options.MaxLinks != nil && isFinite(float64(*options.MaxLinks)) {
		v := clampInt(jsRound(float64(*options.MaxLinks)), 1, 500)
		normalized.MaxLinks = &v
	}
	if options.Concurrency != nil && isFinite(float64(*options.Concurrency)) {
		v := clampInt(jsRound(float64(*options.Concurrency)), 1, 50)
		normalized.Concurrency = &v
	}
	if options.TimeoutSeconds != nil && isFinite(float64(*options.TimeoutSeconds)) {
		v := clampInt(jsRound(float64(*options.TimeoutSeconds)), 1, 60)
		normalized.TimeoutSeconds = &v
	}
	if options.Query != nil {
		trimmed := strings.TrimSpace(*options.Query)
		if len(trimmed) > 0 && utf16Length(trimmed) <= 160 {
			v := trimmed
			normalized.Query = &v
		}
	}
	if options.ScoreThreshold != nil && isFinite(*options.ScoreThreshold) {
		v := jsToFixedNumber(clampFloat(*options.ScoreThreshold, 0, 1), 3)
		normalized.ScoreThreshold = &v
	}
	if options.Verbose != nil {
		v := *options.Verbose
		normalized.Verbose = &v
	}
	if patterns := normalizePatternList(options.IncludePatterns); patterns != nil {
		normalized.IncludePatterns = patterns
	}
	if patterns := normalizePatternList(options.ExcludePatterns); patterns != nil {
		normalized.ExcludePatterns = patterns
	}
	if normalized.IncludeInternal == nil && normalized.IncludeExternal == nil &&
		normalized.IncludeSocial == nil && normalized.MaxLinks == nil &&
		normalized.Concurrency == nil && normalized.TimeoutSeconds == nil &&
		normalized.Query == nil && normalized.ScoreThreshold == nil &&
		normalized.Verbose == nil && normalized.IncludePatterns == nil &&
		normalized.ExcludePatterns == nil {
		return nil
	}
	return normalized
}

// ---------------------------------------------------------------------------
// numeric / string helpers with JavaScript semantics
// ---------------------------------------------------------------------------

func isFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

// jsRound is Math.round: ties round toward positive infinity and -0.5 becomes
// -0, which is still 0 as an integer.
func jsRound(value float64) int {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return int(math.Floor(value + 0.5))
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

func clampFloat(value, min, max float64) float64 {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// jsToFixedNumber mirrors Number(value.toFixed(digits)): round to the requested
// decimal places and parse the decimal text back.
func jsToFixedNumber(value float64, digits int) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return value
	}
	factor := math.Pow10(digits)
	return math.Round(value*factor) / factor
}

func boolValue(value *bool) bool {
	return value != nil && *value
}

func boolOr(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return *value
}

func boolPtrOr(value *bool, fallback bool) *bool {
	if value != nil {
		return value
	}
	copied := fallback
	return &copied
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func stringOr(value *string, fallback string) string {
	if value == nil {
		return fallback
	}
	return *value
}

func oneOf(value string, options ...string) bool {
	for _, option := range options {
		if value == option {
			return true
		}
	}
	return false
}

// truncateTrimmed is `value.trim()` followed by an optional slice(0, limit);
// an empty result is undefined.
func truncateTrimmed(value string, limit int) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	result := sliceUTF16(trimmed, limit)
	return &result
}

// sliceUTF16 truncates on UTF-16 code units, matching JavaScript String.slice.
func sliceUTF16(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	units := utf16.Encode([]rune(value))
	if len(units) <= limit {
		return value
	}
	return string(utf16.Decode(units[:limit]))
}

func mustJSON(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return encoded
}

// ---------------------------------------------------------------------------
// proxy translation (crawl4ai-proxy.ts)
// ---------------------------------------------------------------------------

func translateLocalhostProxyURL(proxyURL, crawlBaseURL string) string {
	trimmed := strings.TrimSpace(proxyURL)
	if trimmed == "" {
		return trimmed
	}
	if strings.TrimSpace(crawlBaseURL) == "" {
		return trimmed
	}
	if !crawl4aiLikelyRunsInDocker(crawlBaseURL) {
		return trimmed
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return trimmed
	}
	hostname := strings.ToLower(parsed.Hostname())
	if hostname != "localhost" && hostname != "127.0.0.1" && hostname != "::1" {
		return trimmed
	}
	// url.URL has no setter for hostname; rebuild the authority.
	port := parsed.Port()
	parsed.Host = "host.docker.internal"
	if port != "" {
		parsed.Host += ":" + port
	}
	return parsed.String()
}

func crawl4aiLikelyRunsInDocker(baseURL string) bool {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return false
	}
	hostname := strings.ToLower(parsed.Hostname())
	port := 0
	if parsed.Port() != "" {
		port, _ = strconv.Atoi(parsed.Port())
	} else if parsed.Scheme == "https" {
		port = 443
	} else {
		port = 80
	}
	if hostname == "crawl4ai" || hostname == "host.docker.internal" {
		return true
	}
	return (hostname == "localhost" || hostname == "127.0.0.1" || hostname == "::1") &&
		(port == 8082 || port == 11235)
}
