package crawlmetadata

import (
	"encoding/json"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
)

// This file parses the `crawlOptions` object that the workflow nodes and the
// news-source config carry into the typed crawl4ai options.
//
// Provenance: apps/api/src/modules/crawl/crawl-metadata.service.ts:1890-1977
// (normalizeCrawlOptions) and apps/api/src/modules/crawl/crawl-config-policy.ts
// (assertNoUnsupportedProxy). NestJS validates the object through
// CrawlOptionsNormalizerService; this parser reads the same fields with the same
// clamps for the subset the crawl4ai payload builder consumes. Options the
// discovery chain never reads (multi-URL configurations, media capture, model
// extraction settings) are dropped instead of forwarded, exactly like the
// DTO-based normalizer drops unknown keys.
//
// assertNoUnsupportedProxy is the one hard rejection: a `proxyUrl` or
// `proxyConfig` key fails the request with the source's 400 message. The
// crawl4ai LLM guard is not applied here because the source applies it to
// profile/template/news-source config normalization, not to node crawl options;
// those paths run it through crawlprofile.NormalizeConfigJSON.

// ParseCrawlOptions validates and normalizes one crawlOptions object.
func ParseCrawlOptions(raw json.RawMessage) (crawl4ai.CrawlOptions, error) {
	// The proxy guard lives in crawlworkflow (the same source function the
	// workflow definition validation uses), so both entries reject a custom
	// upstream proxy with one message.
	if err := crawlworkflow.AssertNoUnsupportedProxy(raw, "crawlOptions"); err != nil {
		return crawl4ai.CrawlOptions{}, err
	}
	fields, ok := decodeRawObject(raw)
	if !ok {
		return crawl4ai.CrawlOptions{}, nil
	}
	options := crawl4ai.CrawlOptions{
		CacheMode:               rawString(fields["cacheMode"]),
		Prefetch:                rawBool(fields["prefetch"]),
		ScoreLinks:              rawBool(fields["scoreLinks"]),
		ScanFullPage:            rawBool(fields["scanFullPage"]),
		AdjustViewportToContent: rawBool(fields["adjustViewportToContent"]),
		ScrollDelayMs:           rawClampedInt(fields["scrollDelayMs"], 50, 5000),
		SimulateUser:            rawBool(fields["simulateUser"]),
		OverrideNavigator:       rawBool(fields["overrideNavigator"]),
		EnableStealthMode:       rawBool(fields["enableStealthMode"]),
		EnableUndetected:        rawBool(fields["enableUndetectedBrowser"]),
		Headless:                rawBool(fields["headless"]),
		UseManagedBrowser:       rawBool(fields["useManagedBrowser"]),
		UserDataDir:             rawTrimmedString(fields["userDataDir"], 4096),
		StorageState:            rawTrimmedString(fields["storageState"], 1<<20),
		IncludeImages:           rawBool(fields["includeImages"]),
		RemoveForms:             rawBool(fields["removeForms"]),
		TextMode:                rawBool(fields["textMode"]),
		CaptureScreenshot:       rawBool(fields["captureScreenshot"]),
		WaitForImages:           rawBool(fields["waitForImages"]),
		ExcludeExternalImgs:     rawBool(fields["excludeExternalImages"]),
		ExcludeExternalLinks:    rawBool(fields["excludeExternalLinks"]),
		RemoveOverlayElements:   rawBool(fields["removeOverlayElements"]),
		ProcessIframes:          rawBool(fields["processIframes"]),
		CSSSelector:             rawTrimmedString(fields["cssSelector"], 512),
		ExcludedTags:            rawSelectorList(fields["excludedTags"]),
		WordCountThreshold:      rawClampedInt(fields["wordCountThreshold"], 0, 5000),
		WaitUntil:               rawWaitUntil(fields["waitUntil"]),
		WaitForTimeoutMs:        rawClampedInt(fields["waitForTimeoutMs"], 500, 60000),
		PageTimeoutMs:           rawClampedInt(fields["pageTimeoutMs"], 1000, 180000),
		DelayBeforeReturnHtmlMs: rawClampedInt(fields["delayBeforeReturnHtmlMs"], 0, 30000),
		MeanDelayMs:             rawClampedInt(fields["meanDelayMs"], 0, 10000),
		MaxDelayRangeMs:         rawClampedInt(fields["maxDelayRangeMs"], 0, 10000),
		SemaphoreCount:          rawClampedInt(fields["semaphoreCount"], 1, 50),
		SessionID:               rawTrimmedString(fields["sessionId"], 191),
		UserAgent:               rawTrimmedString(fields["userAgent"], 1024),
		Locale:                  rawTrimmedString(fields["locale"], 64),
		TimezoneID:              rawTrimmedString(fields["timezoneId"], 128),
		JSCode:                  rawStringList(fields["jsCode"], 5, 2000),
		JSOnly:                  rawBool(fields["jsOnly"]),
		WaitForSelector:         rawTrimmedString(fields["waitForSelector"], 512),
		WaitForScript:           rawTrimmedString(fields["waitForScript"], 4096),
		TableScoreThreshold:     rawClampedFloat(fields["tableScoreThreshold"], 0, 10),
		BrowserHeaders:          rawBrowserHeaders(fields["browserHeaders"]),
		VirtualScroll:           parseVirtualScroll(fields["virtualScroll"]),
		MarkdownFilter:          parseMarkdownFilter(fields["markdownFilter"]),
		CleanMarkdown:           parseCleanMarkdown(fields["cleanMarkdown"]),
		LinkPreview:             parseLinkPreview(fields["linkPreview"]),
		DeepCrawlStrategy:       cloneRawMessage(fields["deepCrawlStrategy"]),
		MarkdownStrategy:        parseMarkdownStrategy(fields["markdownStrategy"]),
	}
	return options, nil
}

func parseVirtualScroll(raw json.RawMessage) *crawl4ai.VirtualScroll {
	fields, ok := decodeRawObject(raw)
	if !ok {
		return nil
	}
	config := &crawl4ai.VirtualScroll{}
	if value, ok := rawStringValue(fields["containerSelector"]); ok {
		config.ContainerSelector = value
	}
	if value, ok := rawIntValue(fields["scrollCount"]); ok {
		config.ScrollCount = value
	}
	if value, ok := rawStringValue(fields["scrollBy"]); ok {
		config.ScrollBy = value
	}
	if value, ok := rawIntValue(fields["waitAfterScrollMs"]); ok {
		config.WaitAfterScrollMs = &value
	}
	if config.ContainerSelector == "" && config.ScrollCount == 0 && config.ScrollBy == "" && config.WaitAfterScrollMs == nil {
		return nil
	}
	return config
}

func parseMarkdownFilter(raw json.RawMessage) *crawl4ai.MarkdownFilter {
	fields, ok := decodeRawObject(raw)
	if !ok {
		return nil
	}
	filter := &crawl4ai.MarkdownFilter{}
	if value, ok := rawStringValue(fields["type"]); ok {
		filter.Type = strings.ToLower(strings.TrimSpace(value))
	}
	if filter.Type != "pruning" && filter.Type != "bm25" {
		return nil
	}
	filter.Threshold = rawClampedFloat(fields["threshold"], 0, 1)
	if value, ok := rawStringValue(fields["thresholdType"]); ok {
		filter.ThresholdType = &value
	}
	filter.MinWordThresh = rawClampedInt(fields["minWordThreshold"], 0, 5000)
	if value, ok := rawStringValue(fields["userQuery"]); ok {
		filter.UserQuery = &value
	}
	filter.BM25Threshold = rawClampedFloat(fields["bm25Threshold"], 0, 1)
	if value, ok := rawStringValue(fields["language"]); ok {
		filter.BM25Language = &value
	}
	return filter
}

func parseCleanMarkdown(raw json.RawMessage) *crawl4ai.CleanMarkdown {
	fields, ok := decodeRawObject(raw)
	if !ok {
		return nil
	}
	clean := &crawl4ai.CleanMarkdown{
		CSSSelector:           rawTrimmedString(fields["cssSelector"], 512),
		TargetElements:        rawStringList(fields["targetElements"], 50, 512),
		ExcludedTags:          rawSelectorList(fields["excludedTags"]),
		RemoveOverlayElements: rawBool(fields["removeOverlayElements"]),
		WordCountThreshold:    rawClampedInt(fields["wordCountThreshold"], 0, 5000),
	}
	if clean.CSSSelector == nil && len(clean.TargetElements) == 0 && len(clean.ExcludedTags) == 0 &&
		clean.RemoveOverlayElements == nil && clean.WordCountThreshold == nil {
		return nil
	}
	return clean
}

func parseLinkPreview(raw json.RawMessage) *crawl4ai.LinkPreview {
	fields, ok := decodeRawObject(raw)
	if !ok {
		return nil
	}
	preview := &crawl4ai.LinkPreview{
		IncludeInternal: rawBoolOrDefault(fields["includeInternal"], true),
		IncludeExternal: rawBoolOrDefault(fields["includeExternal"], true),
		MaxLinks:        rawClampedInt(fields["maxLinks"], 1, 5000),
		Concurrency:     rawClampedInt(fields["concurrency"], 1, 50),
		TimeoutSeconds:  rawClampedFloat(fields["timeout"], 0, 120),
		Query:           rawTrimmedString(fields["query"], 512),
		ScoreThreshold:  rawClampedFloat(fields["scoreThreshold"], 0, 1),
		Verbose:         rawBool(fields["verbose"]),
		IncludePatterns: rawStringList(fields["includePatterns"], 100, 512),
		ExcludePatterns: rawStringList(fields["excludePatterns"], 100, 512),
	}
	return preview
}

func parseMarkdownStrategy(raw json.RawMessage) *crawl4ai.MarkdownStrategy {
	fields, ok := decodeRawObject(raw)
	if !ok {
		return nil
	}
	strategyType, ok := rawStringValue(fields["type"])
	if !ok || strings.TrimSpace(strategyType) == "" {
		return nil
	}
	strategy := &crawl4ai.MarkdownStrategy{Type: strings.TrimSpace(strategyType)}
	if params, ok := decodeRawObject(fields["params"]); ok && len(params) > 0 {
		strategy.Params = cloneRawMessage(fields["params"])
	}
	return strategy
}

// ---- raw JSON field readers ----

func decodeRawObject(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	trimmed := strings.TrimSpace(string(raw))
	if !strings.HasPrefix(trimmed, "{") {
		return nil, false
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, false
	}
	return fields, true
}

// encodeRawObject renders a raw-field map back to one JSON object.
func encodeRawObject(fields map[string]json.RawMessage) json.RawMessage {
	encoded, err := json.Marshal(fields)
	if err != nil {
		return json.RawMessage("{}")
	}
	return encoded
}

func jsonIsObjectRaw(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	return strings.HasPrefix(trimmed, "{") && strings.HasSuffix(trimmed, "}")
}

func jsonIsArrayRaw(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	return strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]")
}

func cloneRawMessage(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 || strings.TrimSpace(string(raw)) == "null" {
		return nil
	}
	return raw
}

func rawString(raw json.RawMessage) *string {
	return rawTrimmedString(raw, 191)
}

func rawStringValue(raw json.RawMessage) (string, bool) {
	var value string
	if len(raw) == 0 {
		return "", false
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

func rawTrimmedString(raw json.RawMessage, max int) *string {
	value, ok := rawStringValue(raw)
	if !ok {
		return nil
	}
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	if jsLen(trimmed) > max {
		trimmed = sliceUTF16(trimmed, max)
	}
	return &trimmed
}

func rawBool(raw json.RawMessage) *bool {
	var value bool
	if len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return &value
}

func rawBoolOrDefault(raw json.RawMessage, fallback bool) bool {
	if value := rawBool(raw); value != nil {
		return *value
	}
	return fallback
}

func rawIntValue(raw json.RawMessage) (int, bool) {
	var value float64
	if len(raw) == 0 {
		return 0, false
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	if value != value {
		return 0, false
	}
	return int(value), true
}

func rawClampedInt(raw json.RawMessage, min, max int) *int {
	value, ok := rawNumberValue(raw)
	if !ok {
		return nil
	}
	rounded := int(jsRound(value))
	if rounded < min {
		rounded = min
	}
	if rounded > max {
		rounded = max
	}
	return &rounded
}

func rawNumberValue(raw json.RawMessage) (float64, bool) {
	var value float64
	if len(raw) == 0 {
		return 0, false
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	if value != value {
		return 0, false
	}
	return value, true
}

func jsRound(value float64) float64 {
	if value < 0 {
		return -jsRound(-value)
	}
	return float64(int64(value + 0.5))
}

func rawClampedFloat(raw json.RawMessage, min, max float64) *float64 {
	value, ok := rawNumberValue(raw)
	if !ok {
		return nil
	}
	if value < min {
		value = min
	}
	if value > max {
		value = max
	}
	return &value
}

func rawWaitUntil(raw json.RawMessage) *string {
	value, ok := rawStringValue(raw)
	if !ok {
		return nil
	}
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "domcontentloaded", "load", "networkidle", "commit":
		normalized := strings.ToLower(strings.TrimSpace(value))
		return &normalized
	}
	return nil
}

func rawStringList(raw json.RawMessage, max int, maxChars int) []string {
	if len(raw) == 0 || !strings.HasPrefix(strings.TrimSpace(string(raw)), "[") {
		return nil
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil
	}
	out := []string{}
	for _, item := range items {
		value, ok := rawStringValue(item)
		if !ok {
			continue
		}
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if jsLen(trimmed) > maxChars {
			trimmed = sliceUTF16(trimmed, maxChars)
		}
		out = append(out, trimmed)
		if len(out) >= max {
			break
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// rawSelectorList mirrors normalizeSelectorList: lowercase, keep the
// selector-shaped values only.
func rawSelectorList(raw json.RawMessage) []string {
	values := rawStringList(raw, 64, 128)
	if len(values) == 0 {
		return nil
	}
	out := []string{}
	for _, value := range values {
		normalized := strings.ToLower(strings.TrimSpace(value))
		if normalized == "" || !isSelectorShape(normalized) {
			continue
		}
		out = append(out, normalized)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func isSelectorShape(value string) bool {
	for index, char := range value {
		switch {
		case char >= 'a' && char <= 'z', char >= '0' && char <= '9':
			continue
		case index == 0:
			return false
		case char == '-', char == '_', char == ':', char == '.', char == '[',
			char == ']', char == '=', char == '#', char == ' ', char == '>',
			char == '+', char == '~', char == '*', char == '(', char == ')':
			continue
		default:
			return false
		}
	}
	return value != ""
}

// rawBrowserHeaders accepts the CrawlBrowserHeader[] shape ({name, value}) and
// the plain object form.
func rawBrowserHeaders(raw json.RawMessage) map[string]string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return nil
	}
	headers := map[string]string{}
	switch {
	case strings.HasPrefix(trimmed, "["):
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil {
			return nil
		}
		for _, item := range items {
			fields, ok := decodeRawObject(item)
			if !ok {
				continue
			}
			name, nameOK := rawStringValue(fields["name"])
			value, valueOK := rawStringValue(fields["value"])
			if !nameOK || !valueOK {
				continue
			}
			name = strings.TrimSpace(name)
			if name == "" {
				continue
			}
			headers[name] = strings.TrimSpace(value)
		}
	case strings.HasPrefix(trimmed, "{"):
		fields, ok := decodeRawObject(raw)
		if !ok {
			return nil
		}
		for name, valueRaw := range fields {
			value, ok := rawStringValue(valueRaw)
			if !ok {
				continue
			}
			normalizedName := strings.TrimSpace(name)
			if normalizedName == "" {
				continue
			}
			headers[normalizedName] = strings.TrimSpace(value)
		}
	}
	if len(headers) == 0 {
		return nil
	}
	return headers
}
