package crawlexecution

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawloptions"
)

// requestPayload is Crawl4aiRequest: the target URL, the URL list, keywords and
// the effective options.
type requestPayload struct {
	URL      string
	URLs     []string
	Keywords []string
	Options  normalizedOptions
}

// extractOptions ports CrawlOptionsNormalizerService.extractOptions: the stored
// CrawlTask.config is a flattened CrawlTaskOptions document, and every value is
// type-checked before it is handed to normalizeOptions. A key whose stored type
// does not match is ignored (the NestJS typeof guards do the same).
func extractOptions(config map[string]json.RawMessage) *crawloptions.OptionsInput {
	options := &crawloptions.OptionsInput{}
	if config == nil {
		return options
	}
	options.IncludeImages = decodeInto[bool](config, "includeImages")
	options.StoreMedia = decodeInto[bool](config, "storeMedia")
	options.OnlyMainContent = decodeInto[bool](config, "onlyMainContent")
	options.ExtractLinks = decodeInto[bool](config, "extractLinks")
	options.CacheMode = decodeInto[string](config, "cacheMode")
	options.Prefetch = decodeInto[bool](config, "prefetch")
	options.ScanFullPage = decodeInto[bool](config, "scanFullPage")
	options.AdjustViewportToContent = decodeInto[bool](config, "adjustViewportToContent")
	options.ScrollDelayMs = decodeInto[int](config, "scrollDelayMs")
	options.Headless = decodeInto[bool](config, "headless")
	options.EnableUndetectedBrowser = decodeInto[bool](config, "enableUndetectedBrowser")
	options.AntiBotMode = decodeInto[string](config, "antiBotMode")
	options.EnableStealthMode = decodeInto[bool](config, "enableStealthMode")
	options.UseManagedBrowser = decodeInto[bool](config, "useManagedBrowser")
	options.UserDataDir = decodeInto[string](config, "userDataDir")
	options.SimulateUser = decodeInto[bool](config, "simulateUser")
	options.OverrideNavigator = decodeInto[bool](config, "overrideNavigator")
	options.JSCode = decodeStringList(config, "jsCode")
	options.JSOnly = decodeInto[bool](config, "jsOnly")
	options.WaitForSelector = decodeInto[string](config, "waitForSelector")
	options.WaitForScript = decodeInto[string](config, "waitForScript")
	options.WaitForTimeoutMs = decodeInto[int](config, "waitForTimeoutMs")
	options.WaitUntil = decodeInto[string](config, "waitUntil")
	options.PageTimeoutMs = decodeInto[int](config, "pageTimeoutMs")
	options.DelayBeforeReturnHTMLMs = decodeInto[int](config, "delayBeforeReturnHtmlMs")
	options.MeanDelayMs = decodeInto[int](config, "meanDelayMs")
	options.MaxDelayRangeMs = decodeInto[int](config, "maxDelayRangeMs")
	options.SemaphoreCount = decodeInto[int](config, "semaphoreCount")
	options.ProxyURL = decodeInto[string](config, "proxyUrl")
	options.ProxyConfig = decodeInto[crawloptions.ProxyConfig](config, "proxyConfig")
	options.AdditionalURLs = decodeStringList(config, "additionalUrls")
	options.MultiURLConfigs = decodeSlice[crawloptions.MultiURLConfig](config, "multiUrlConfigs")
	options.MarkdownOptions = decodeInto[crawloptions.MarkdownOptionsInput](config, "markdownOptions")
	options.MarkdownFilter = decodeInto[crawloptions.MarkdownFilter](config, "markdownFilter")
	options.MarkdownStrategy = decodeInto[crawloptions.MarkdownStrategyInput](config, "markdownStrategy")
	options.TableScoreThreshold = decodeInto[float64](config, "tableScoreThreshold")
	options.TableExtraction = decodeInto[crawloptions.TableExtractionInput](config, "tableExtraction")
	options.CleanMarkdown = decodeInto[crawloptions.CleanMarkdownInput](config, "cleanMarkdown")
	options.ScoreLinks = decodeInto[bool](config, "scoreLinks")
	options.LinkPreview = decodeInto[crawloptions.LinkPreviewOptionsInput](config, "linkPreview")
	options.BrowserHeaders = decodeSlice[crawloptions.BrowserHeader](config, "browserHeaders")
	options.BrowserCookies = decodeSlice[crawloptions.BrowserCookie](config, "browserCookies")
	options.UserAgent = decodeInto[string](config, "userAgent")
	options.UserAgentMode = decodeInto[string](config, "userAgentMode")
	options.UserAgentGenerator = decodeInto[crawloptions.UserAgentGenerator](config, "userAgentGenerator")
	options.Locale = decodeInto[string](config, "locale")
	options.TimezoneID = decodeInto[string](config, "timezoneId")
	options.Geolocation = decodeInto[crawloptions.Geolocation](config, "geolocation")
	options.WordCountThreshold = decodeInto[int](config, "wordCountThreshold")
	options.ExcludeExternalLinks = decodeInto[bool](config, "excludeExternalLinks")
	options.ExcludeExternalImages = decodeInto[bool](config, "excludeExternalImages")
	options.RemoveOverlayElements = decodeInto[bool](config, "removeOverlayElements")
	options.ProcessIframes = decodeInto[bool](config, "processIframes")
	options.TextMode = decodeInto[bool](config, "textMode")
	options.CaptureScreenshot = decodeInto[bool](config, "captureScreenshot")
	options.CSSSelector = decodeInto[string](config, "cssSelector")
	options.ExcludedTags = decodeStringList(config, "excludedTags")
	options.VirtualScroll = decodeInto[crawloptions.VirtualScroll](config, "virtualScroll")
	options.WaitForImages = decodeInto[bool](config, "waitForImages")
	options.RemoveForms = decodeInto[bool](config, "removeForms")
	options.PageTypeHint = decodeInto[string](config, "pageTypeHint")
	options.AutoExpandDetails = decodeInto[bool](config, "autoExpandDetails")
	options.DetailExpansion = decodeInto[crawloptions.DetailExpansion](config, "detailExpansion")
	options.QualityProfile = decodeInto[string](config, "qualityProfile")
	return options
}

// decodeInto decodes one stored config value into T. A missing, null or
// wrong-typed value yields nil, mirroring the NestJS typeof guards.
func decodeInto[T any](config map[string]json.RawMessage, key string) *T {
	raw, ok := config[key]
	if !ok || len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	value := new(T)
	if err := json.Unmarshal(raw, value); err != nil {
		return nil
	}
	return value
}

// decodeSlice decodes a stored JSON array into []T; a missing/null/wrong-typed
// value yields nil.
func decodeSlice[T any](config map[string]json.RawMessage, key string) []T {
	raw, ok := config[key]
	if !ok || len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var values []T
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil
	}
	return values
}

// decodeStringList decodes a JSON string array, dropping non-string entries.
func decodeStringList(config map[string]json.RawMessage, key string) []string {
	raw, ok := config[key]
	if !ok || len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var entries []any
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil
	}
	values := make([]string, 0, len(entries))
	for _, entry := range entries {
		if text, ok := entry.(string); ok {
			values = append(values, text)
		}
	}
	return values
}

// marshalOptions serializes the extracted options for the crawl4ai LLM guard.
func marshalOptions(options *crawloptions.OptionsInput) (json.RawMessage, error) {
	raw, err := json.Marshal(options)
	if err != nil {
		return nil, fmt.Errorf("crawlexecution: marshal crawl options: %w", err)
	}
	return raw, nil
}

// assertNoUnsupportedProxy is assertNoUnsupportedProxy(task.config).
func assertNoUnsupportedProxy(config json.RawMessage, path string) error {
	return crawloptions.AssertNoUnsupportedProxy(config, path)
}

// assertNoCrawl4aiLLMOptions is assertNoCrawl4aiLlmOptions.
func assertNoCrawl4aiLLMOptions(options json.RawMessage, label string) error {
	return crawloptions.AssertNoCrawl4aiLlmOptions(options, label)
}

// decodeConfigObject mirrors the task.config object check: only a JSON object
// becomes a record, anything else is nil.
func decodeConfigObject(raw json.RawMessage) map[string]json.RawMessage {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || !strings.HasPrefix(trimmed, "{") {
		return nil
	}
	var record map[string]json.RawMessage
	if err := json.Unmarshal(raw, &record); err != nil {
		return nil
	}
	return record
}

// configBool reads a boolean config leaf (config.ingestToItems === true).
func configBool(config map[string]json.RawMessage, key string) bool {
	value := decodeInto[bool](config, key)
	return value != nil && *value
}

// normalizeRequestTimeoutMs is CrawlConditionalPreflightService's
// normalizeRequestTimeoutMs: absent/<=0 means undefined (0 here).
func normalizeRequestTimeoutMs(value int) int {
	if value <= 0 {
		return 0
	}
	if value < 1000 {
		return 1000
	}
	return value
}

// ensureTaskSessionReuse is ensureTaskSessionReuse: an explicit session id wins,
// otherwise the deterministic task session keeps repeat runs on one browser
// session.
func ensureTaskSessionReuse(taskID string, options normalizedOptions) normalizedOptions {
	if options.SessionID != nil && *options.SessionID != "" {
		return options
	}
	sessionID := buildTaskSessionID(taskID)
	options.SessionID = &sessionID
	return options
}

// buildTaskSessionID is buildTaskSessionId.
func buildTaskSessionID(taskID string) string {
	normalized := strings.ToLower(strings.TrimSpace(taskID))
	var builder strings.Builder
	for _, r := range normalized {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			builder.WriteRune(r)
		} else {
			builder.WriteRune('-')
		}
	}
	seed := builder.String()
	if seed == "" {
		seed = "default"
	}
	return "task-" + seed
}

// buildURLList is buildUrlList: the target URL plus additionalUrls plus every
// multiUrlConfigs URL, de-duplicated in insertion order.
func buildURLList(baseURL string, options normalizedOptions) []string {
	accumulator := []string{baseURL}
	accumulator = append(accumulator, options.AdditionalURLs...)
	for _, config := range options.MultiURLConfigs {
		accumulator = append(accumulator, config.URLs...)
	}
	seen := map[string]struct{}{}
	urls := make([]string, 0, len(accumulator))
	for _, entry := range accumulator {
		if entry == "" {
			continue
		}
		if _, ok := seen[entry]; ok {
			continue
		}
		seen[entry] = struct{}{}
		urls = append(urls, entry)
	}
	return urls
}

// buildRequestPayload is CrawlOptionsNormalizerService.buildRequestPayload.
func (s *Service) buildRequestPayload(task *taskRow, normalizer *crawloptions.Normalizer, provided normalizedOptions) requestPayload {
	keywords := keywordsFromJSON(task.Keywords)
	options := ensureTaskSessionReuse(task.ID, provided)
	return requestPayload{
		URL:      task.TargetURL,
		URLs:     buildURLList(task.TargetURL, options),
		Keywords: keywords,
		Options:  options,
	}
}

// keywordsFromJSON is fromJsonArray(task.keywords): only strings survive.
func keywordsFromJSON(raw json.RawMessage) []string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" || !strings.HasPrefix(trimmed, "[") {
		return []string{}
	}
	var entries []any
	if err := json.Unmarshal(raw, &entries); err != nil {
		return []string{}
	}
	keywords := make([]string, 0, len(entries))
	for _, entry := range entries {
		if text, ok := entry.(string); ok && text != "" {
			keywords = append(keywords, text)
		}
	}
	return keywords
}

// optionsToInput converts a normalized options document back into the optional
// input form so the anti-bot branches can re-run normalizeOptions with
// overrides, exactly like the NestJS spreads.
func optionsToInput(options normalizedOptions) *crawloptions.OptionsInput {
	input := &crawloptions.OptionsInput{}
	input.IncludeImages = boolPtr(options.IncludeImages)
	input.StoreMedia = boolPtr(options.StoreMedia)
	input.OnlyMainContent = boolPtr(options.OnlyMainContent)
	input.ExtractLinks = boolPtr(options.ExtractLinks)
	input.CacheMode = stringPtr(options.CacheMode)
	input.Prefetch = boolPtr(options.Prefetch)
	input.ScanFullPage = boolPtr(options.ScanFullPage)
	input.AdjustViewportToContent = boolPtr(options.AdjustViewportToContent)
	input.ScrollDelayMs = intPtr(options.ScrollDelayMs)
	input.Headless = options.Headless
	input.EnableUndetectedBrowser = boolPtr(options.EnableUndetectedBrowser)
	input.AntiBotMode = stringPtr(options.AntiBotMode)
	input.EnableStealthMode = boolPtr(options.EnableStealthMode)
	input.UseManagedBrowser = boolPtr(options.UseManagedBrowser)
	input.UserDataDir = options.UserDataDir
	input.SimulateUser = boolPtr(options.SimulateUser)
	input.OverrideNavigator = boolPtr(options.OverrideNavigator)
	input.JSCode = options.JSCode
	input.JSOnly = boolPtr(options.JSOnly)
	input.WaitForSelector = options.WaitForSelector
	input.WaitForScript = options.WaitForScript
	input.WaitForTimeoutMs = intPtr(options.WaitForTimeoutMs)
	input.WaitUntil = options.WaitUntil
	input.PageTimeoutMs = intPtr(options.PageTimeoutMs)
	input.DelayBeforeReturnHTMLMs = intPtr(options.DelayBeforeReturnHTMLMs)
	input.MeanDelayMs = intPtr(options.MeanDelayMs)
	input.MaxDelayRangeMs = intPtr(options.MaxDelayRangeMs)
	input.SemaphoreCount = intPtr(options.SemaphoreCount)
	input.ProxyConfig = options.ProxyConfig
	input.ProxyURL = options.ProxyURL
	input.AdditionalURLs = options.AdditionalURLs
	input.MultiURLConfigs = options.MultiURLConfigs
	input.MarkdownOptions = markdownOptionsToInput(options.MarkdownOptions)
	input.MarkdownFilter = options.MarkdownFilter
	input.MarkdownStrategy = strategyToInput(options.MarkdownStrategy)
	input.TableScoreThreshold = options.TableScoreThreshold
	input.TableExtraction = tableToInput(options.TableExtraction)
	input.CleanMarkdown = cleanMarkdownToInput(options.CleanMarkdown)
	input.ScoreLinks = boolPtr(options.ScoreLinks)
	input.LinkPreview = linkPreviewToInput(options.LinkPreview)
	input.BrowserHeaders = options.BrowserHeaders
	input.BrowserCookies = options.BrowserCookies
	input.UserAgent = options.UserAgent
	input.UserAgentMode = options.UserAgentMode
	input.UserAgentGenerator = options.UserAgentGenerator
	input.Locale = options.Locale
	input.TimezoneID = options.TimezoneID
	input.Geolocation = options.Geolocation
	input.SessionID = options.SessionID
	input.StorageState = options.StorageState
	input.WordCountThreshold = intPtr(options.WordCountThreshold)
	input.ExcludeExternalLinks = boolPtr(options.ExcludeExternalLinks)
	input.ExcludeExternalImages = boolPtr(options.ExcludeExternalImages)
	input.RemoveOverlayElements = boolPtr(options.RemoveOverlayElements)
	input.ProcessIframes = boolPtr(options.ProcessIframes)
	input.TextMode = boolPtr(options.TextMode)
	input.CaptureScreenshot = boolPtr(options.CaptureScreenshot)
	input.CSSSelector = options.CSSSelector
	input.ExcludedTags = options.ExcludedTags
	input.VirtualScroll = options.VirtualScroll
	input.WaitForImages = boolPtr(options.WaitForImages)
	input.RemoveForms = boolPtr(options.RemoveForms)
	input.PageTypeHint = options.PageTypeHint
	input.AutoExpandDetails = boolPtr(options.AutoExpandDetails)
	input.DetailExpansion = options.DetailExpansion
	input.QualityProfile = stringPtr(options.QualityProfile)
	return input
}

func markdownOptionsToInput(value *crawloptions.MarkdownOptions) *crawloptions.MarkdownOptionsInput {
	if value == nil {
		return nil
	}
	return &crawloptions.MarkdownOptionsInput{
		ContentSource: value.ContentSource,
		IgnoreLinks:   value.IgnoreLinks,
		EscapeHTML:    value.EscapeHTML,
		Citations:     value.Citations,
		BodyWidth:     value.BodyWidth,
	}
}

func cleanMarkdownToInput(value *crawloptions.CleanMarkdown) *crawloptions.CleanMarkdownInput {
	if value == nil {
		return nil
	}
	return &crawloptions.CleanMarkdownInput{
		CSSSelector:           value.CSSSelector,
		TargetElements:        value.TargetElements,
		ExcludedTags:          value.ExcludedTags,
		RemoveOverlayElements: value.RemoveOverlayElements,
		WordCountThreshold:    value.WordCountThreshold,
	}
}

func linkPreviewToInput(value *crawloptions.LinkPreviewOptions) *crawloptions.LinkPreviewOptionsInput {
	if value == nil {
		return nil
	}
	return &crawloptions.LinkPreviewOptionsInput{
		IncludeInternal: value.IncludeInternal,
		IncludeExternal: value.IncludeExternal,
		IncludeSocial:   value.IncludeSocial,
		MaxLinks:        value.MaxLinks,
		Concurrency:     value.Concurrency,
		TimeoutSeconds:  value.TimeoutSeconds,
		Query:           value.Query,
		ScoreThreshold:  value.ScoreThreshold,
		Verbose:         value.Verbose,
		IncludePatterns: value.IncludePatterns,
		ExcludePatterns: value.ExcludePatterns,
	}
}

func strategyToInput(value *crawloptions.Strategy) *crawloptions.MarkdownStrategyInput {
	if value == nil {
		return nil
	}
	return &crawloptions.MarkdownStrategyInput{Type: stringPtr(value.Type), Params: value.Params}
}

func tableToInput(value *crawloptions.Strategy) *crawloptions.TableExtractionInput {
	if value == nil {
		return nil
	}
	return &crawloptions.TableExtractionInput{Type: stringPtr(value.Type), Params: value.Params}
}

func boolPtr(value bool) *bool { return &value }

func intPtr(value *int) *int {
	if value == nil {
		return nil
	}
	copied := *value
	return &copied
}

// crawlOptionsForRequest maps the normalized CrawlTaskOptions onto the crawl4ai
// request options subset the shared payload builder reads.
func crawlOptionsForRequest(options normalizedOptions) crawl4ai.CrawlOptions {
	mapped := crawl4ai.CrawlOptions{
		IncludeImages:           options.IncludeImages,
		StoreMedia:              options.StoreMedia,
		OnlyMainContent:         options.OnlyMainContent,
		ExtractLinks:            options.ExtractLinks,
		CacheMode:               options.CacheMode,
		Prefetch:                options.Prefetch,
		ScoreLinks:              options.ScoreLinks,
		QualityProfile:          options.QualityProfile,
		ScanFullPage:            options.ScanFullPage,
		AdjustViewportToContent: options.AdjustViewportToContent,
		ScrollDelayMs:           options.ScrollDelayMs,
		Headless:                options.Headless,
		EnableStealthMode:       options.EnableStealthMode,
		EnableUndetectedBrowser: options.EnableUndetectedBrowser,
		UseManagedBrowser:       options.UseManagedBrowser,
		UserDataDir:             options.UserDataDir,
		SimulateUser:            options.SimulateUser,
		OverrideNavigator:       options.OverrideNavigator,
		JSCode:                  options.JSCode,
		JSOnly:                  options.JSOnly,
		WaitForSelector:         options.WaitForSelector,
		WaitForScript:           options.WaitForScript,
		WaitForTimeoutMs:        options.WaitForTimeoutMs,
		WaitUntil:               options.WaitUntil,
		PageTimeoutMs:           options.PageTimeoutMs,
		DelayBeforeReturnHTMLMs: options.DelayBeforeReturnHTMLMs,
		MeanDelayMs:             options.MeanDelayMs,
		MaxDelayRangeMs:         options.MaxDelayRangeMs,
		SemaphoreCount:          options.SemaphoreCount,
		MarkdownOptions:         crawl4aiMarkdownOptions(options.MarkdownOptions),
		MarkdownFilter:          crawl4aiMarkdownFilter(options.MarkdownFilter),
		MarkdownStrategy:        crawl4aiMarkdownStrategy(options.MarkdownStrategy),
		TableScoreThreshold:     options.TableScoreThreshold,
		TableExtraction:         crawl4aiComponent(options.TableExtraction),
		CleanMarkdown:           crawl4aiCleanMarkdown(options.CleanMarkdown),
		LinkPreview:             crawl4aiLinkPreview(options.LinkPreview),
		BrowserHeaders:          browserHeaders(options.BrowserHeaders),
		BrowserCookies:          browserCookies(options.BrowserCookies),
		UserAgent:               options.UserAgent,
		UserAgentMode:           options.UserAgentMode,
		Locale:                  options.Locale,
		TimezoneID:              options.TimezoneID,
		SessionID:               options.SessionID,
		StorageState:            options.StorageState,
		WordCountThreshold:      options.WordCountThreshold,
		ExcludeExternalLinks:    options.ExcludeExternalLinks,
		RemoveOverlayElements:   options.RemoveOverlayElements,
		ProcessIframes:          options.ProcessIframes,
		TextMode:                options.TextMode,
		CaptureScreenshot:       options.CaptureScreenshot,
		CSSSelector:             options.CSSSelector,
		ExcludedTags:            options.ExcludedTags,
		VirtualScroll:           crawl4aiVirtualScroll(options.VirtualScroll),
		ExcludeExternalImages:   options.ExcludeExternalImages,
		WaitForImages:           options.WaitForImages,
		RemoveForms:             options.RemoveForms,
	}
	return mapped
}

func crawl4aiMarkdownOptions(value *crawloptions.MarkdownOptions) *crawl4ai.MarkdownOptions {
	if value == nil {
		return nil
	}
	return &crawl4ai.MarkdownOptions{
		ContentSource: value.ContentSource,
		IgnoreLinks:   value.IgnoreLinks,
		EscapeHTML:    value.EscapeHTML,
		Citations:     value.Citations,
		BodyWidth:     value.BodyWidth,
	}
}

func crawl4aiMarkdownFilter(value *crawloptions.MarkdownFilter) *crawl4ai.MarkdownFilter {
	if value == nil {
		return nil
	}
	return &crawl4ai.MarkdownFilter{
		Type:             value.Type,
		Threshold:        value.Threshold,
		ThresholdType:    value.ThresholdType,
		MinWordThreshold: value.MinWordThreshold,
		UserQuery:        value.UserQuery,
		BM25Threshold:    value.BM25Threshold,
		Language:         value.Language,
	}
}

func crawl4aiMarkdownStrategy(value *crawloptions.Strategy) *crawl4ai.MarkdownStrategy {
	if value == nil {
		return nil
	}
	return &crawl4ai.MarkdownStrategy{Type: value.Type, Params: value.Params}
}

func crawl4aiComponent(value *crawloptions.Strategy) *crawl4ai.Component {
	if value == nil {
		return nil
	}
	return &crawl4ai.Component{Type: value.Type, Params: value.Params}
}

func crawl4aiCleanMarkdown(value *crawloptions.CleanMarkdown) *crawl4ai.CleanMarkdown {
	if value == nil {
		return nil
	}
	return &crawl4ai.CleanMarkdown{
		CSSSelector:           value.CSSSelector,
		TargetElements:        value.TargetElements,
		ExcludedTags:          value.ExcludedTags,
		RemoveOverlayElements: value.RemoveOverlayElements,
		WordCountThreshold:    value.WordCountThreshold,
	}
}

func crawl4aiLinkPreview(value *crawloptions.LinkPreviewOptions) *crawl4ai.LinkPreview {
	if value == nil {
		return nil
	}
	var timeoutSeconds *float64
	if value.TimeoutSeconds != nil {
		seconds := float64(*value.TimeoutSeconds)
		timeoutSeconds = &seconds
	}
	return &crawl4ai.LinkPreview{
		IncludeInternal: value.IncludeInternal,
		IncludeExternal: value.IncludeExternal,
		MaxLinks:        value.MaxLinks,
		Concurrency:     value.Concurrency,
		TimeoutSeconds:  timeoutSeconds,
		Query:           value.Query,
		ScoreThreshold:  value.ScoreThreshold,
		Verbose:         value.Verbose,
		IncludePatterns: value.IncludePatterns,
		ExcludePatterns: value.ExcludePatterns,
	}
}

func browserHeaders(values []crawloptions.BrowserHeader) []crawl4ai.BrowserHeader {
	if len(values) == 0 {
		return nil
	}
	headers := make([]crawl4ai.BrowserHeader, 0, len(values))
	for _, header := range values {
		headers = append(headers, crawl4ai.BrowserHeader{Name: header.Name, Value: header.Value})
	}
	return headers
}

func browserCookies(values []crawloptions.BrowserCookie) []crawl4ai.BrowserCookie {
	if len(values) == 0 {
		return nil
	}
	cookies := make([]crawl4ai.BrowserCookie, 0, len(values))
	for _, cookie := range values {
		cookies = append(cookies, crawl4ai.BrowserCookie{
			Name:   cookie.Name,
			Value:  cookie.Value,
			Domain: cookie.Domain,
			Path:   cookie.Path,
		})
	}
	return cookies
}

func crawl4aiVirtualScroll(value *crawloptions.VirtualScroll) *crawl4ai.VirtualScroll {
	if value == nil {
		return nil
	}
	return &crawl4ai.VirtualScroll{
		ContainerSelector: value.ContainerSelector,
		ScrollCount:       value.ScrollCount,
		ScrollBy:          scrollByString(value.ScrollBy),
		WaitAfterScrollMs: value.WaitAfterScrollMs,
	}
}

// scrollByString converts the stored scrollBy union (mode string or pixel
// number) into the crawl4ai payload string.
func scrollByString(raw json.RawMessage) *string {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	switch typed := value.(type) {
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return nil
		}
		return &trimmed
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return nil
		}
		text := strconv.FormatInt(int64(math.Round(typed)), 10)
		return &text
	default:
		return nil
	}
}
