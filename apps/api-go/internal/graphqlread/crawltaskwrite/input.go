package crawltaskwrite

import (
	"encoding/json"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/crawloptions"
)

// This file maps the GraphQL CreateCrawlTaskInput onto the shared
// crawloptions.CreateTaskInput. The GraphQL input type is a subset of the REST
// DTO: its scalar/array/object shapes are enforced by the schema, and the few
// class-validator decorators that exist on the input type (concurrency Min(1),
// keywords each string) are re-checked here.

// inputFailure is the class-validator-compatible failure of a GraphQL input.
type inputFailure struct{ messages []string }

// Error implements error.
func (e *inputFailure) Error() string { return strings.Join(e.messages, "; ") }

// Messages exposes the joined class-validator strings.
func (e *inputFailure) Messages() []string { return e.messages }

// createInputFromGraphQL builds CreateTaskInput from the resolver argument map.
func createInputFromGraphQL(args map[string]any) (crawloptions.CreateTaskInput, error) {
	raw, ok := args["input"].(map[string]any)
	if !ok {
		return crawloptions.CreateTaskInput{}, &inputFailure{messages: []string{"input must be an object"}}
	}
	input := crawloptions.CreateTaskInput{}
	if value, ok := raw["url"].(string); ok {
		input.URL = value
	}
	input.DisplayName = stringPtr(raw["displayName"])
	if value, ok := raw["ingestToItems"].(bool); ok {
		input.IngestToItems = &value
	}
	if timeRange, ok := raw["timeRange"].(map[string]any); ok {
		input.TimeRangeFrom = stringPtr(timeRange["from"])
		input.TimeRangeTo = stringPtr(timeRange["to"])
	}
	if value, ok := intValue(raw["concurrency"]); ok {
		if value < 1 {
			return crawloptions.CreateTaskInput{}, &inputFailure{messages: []string{"concurrency must not be less than 1"}}
		}
		input.Concurrency = &value
	}
	if keywords, ok := raw["keywords"].([]any); ok {
		input.Keywords = stringList(keywords)
	}
	if options, ok := raw["options"].(map[string]any); ok {
		input.Options = optionsFromMap(options)
	}
	// GraphQL has no proxy fields, so the proxy document is the mapped input.
	encoded, err := json.Marshal(input.Options)
	if err != nil {
		return crawloptions.CreateTaskInput{}, err
	}
	input.RawOptions = encoded
	return input, nil
}

// optionsFromMap converts CrawlOptionsInput.
func optionsFromMap(m map[string]any) *crawloptions.OptionsInput {
	out := &crawloptions.OptionsInput{
		IncludeImages:           boolPtr(m["includeImages"]),
		StoreMedia:              boolPtr(m["storeMedia"]),
		OnlyMainContent:         boolPtr(m["onlyMainContent"]),
		ExtractLinks:            boolPtr(m["extractLinks"]),
		ExcludeExternalImages:   boolPtr(m["excludeExternalImages"]),
		ScanFullPage:            boolPtr(m["scanFullPage"]),
		AdjustViewportToContent: boolPtr(m["adjustViewportToContent"]),
		ScrollDelayMs:           intPtr(m["scrollDelayMs"]),
		Headless:                boolPtr(m["headless"]),
		EnableUndetectedBrowser: boolPtr(m["enableUndetectedBrowser"]),
		EnableStealthMode:       boolPtr(m["enableStealthMode"]),
		AntiBotMode:             stringPtr(m["antiBotMode"]),
		UseManagedBrowser:       boolPtr(m["useManagedBrowser"]),
		UserDataDir:             stringPtr(m["userDataDir"]),
		SimulateUser:            boolPtr(m["simulateUser"]),
		OverrideNavigator:       boolPtr(m["overrideNavigator"]),
		JSCode:                  stringSlice(m["jsCode"]),
		JSOnly:                  boolPtr(m["jsOnly"]),
		WaitForSelector:         stringPtr(m["waitForSelector"]),
		WaitForScript:           stringPtr(m["waitForScript"]),
		WaitForTimeoutMs:        intPtr(m["waitForTimeoutMs"]),
		WaitUntil:               stringPtr(m["waitUntil"]),
		PageTimeoutMs:           intPtr(m["pageTimeoutMs"]),
		DelayBeforeReturnHTMLMs: intPtr(m["delayBeforeReturnHtmlMs"]),
		MeanDelayMs:             intPtr(m["meanDelayMs"]),
		MaxDelayRangeMs:         intPtr(m["maxDelayRangeMs"]),
		SemaphoreCount:          intPtr(m["semaphoreCount"]),
		RemoveForms:             boolPtr(m["removeForms"]),
		AdditionalURLs:          stringSlice(m["additionalUrls"]),
		MultiURLConfigs:         multiURLConfigs(m["multiUrlConfigs"]),
		MarkdownOptions:         markdownOptions(m["markdownOptions"]),
		MarkdownFilter:          markdownFilter(m["markdownFilter"]),
		MarkdownStrategy:        strategy(m["markdownStrategy"]),
		TableScoreThreshold:     floatPtr(m["tableScoreThreshold"]),
		TableExtraction:         tableExtraction(m["tableExtraction"]),
		CleanMarkdown:           cleanMarkdown(m["cleanMarkdown"]),
		ScoreLinks:              boolPtr(m["scoreLinks"]),
		LinkPreview:             linkPreview(m["linkPreview"]),
		BrowserHeaders:          browserHeaders(m["browserHeaders"]),
		BrowserCookies:          browserCookies(m["browserCookies"]),
		UserAgent:               stringPtr(m["userAgent"]),
		UserAgentMode:           stringPtr(m["userAgentMode"]),
		UserAgentGenerator:      userAgentGenerator(m["userAgentGenerator"]),
		Locale:                  stringPtr(m["locale"]),
		TimezoneID:              stringPtr(m["timezoneId"]),
		Geolocation:             geolocation(m["geolocation"]),
		SessionID:               stringPtr(m["sessionId"]),
		StorageState:            stringPtr(m["storageState"]),
		WaitForImages:           boolPtr(m["waitForImages"]),
		VirtualScroll:           virtualScroll(m["virtualScroll"]),
		PageTypeHint:            stringPtr(m["pageTypeHint"]),
		AutoExpandDetails:       boolPtr(m["autoExpandDetails"]),
		DetailExpansion:         detailExpansion(m["detailExpansion"]),
		QualityProfile:          stringPtr(m["qualityProfile"]),
	}
	return out
}

func multiURLConfigs(value any) []crawloptions.MultiURLConfig {
	entries, ok := value.([]any)
	if !ok {
		return nil
	}
	configs := make([]crawloptions.MultiURLConfig, 0, len(entries))
	for _, entry := range entries {
		record, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		config := crawloptions.MultiURLConfig{
			Name:    stringPtr(record["name"]),
			URLs:    stringSlice(record["urls"]),
			Matcher: urlMatcher(record["matcher"]),
			Options: strategyOverrides(record["options"]),
		}
		configs = append(configs, config)
	}
	return configs
}

func urlMatcher(value any) *crawloptions.URLMatcher {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return &crawloptions.URLMatcher{
		MatchMode: stringPtr(record["matchMode"]),
		Patterns:  stringSlice(record["patterns"]),
	}
}

func strategyOverrides(value any) *crawloptions.StrategyOverrides {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return &crawloptions.StrategyOverrides{
		ScanFullPage:            boolPtr(record["scanFullPage"]),
		AdjustViewportToContent: boolPtr(record["adjustViewportToContent"]),
		ScrollDelayMs:           intPtr(record["scrollDelayMs"]),
		OnlyMainContent:         boolPtr(record["onlyMainContent"]),
		ExtractLinks:            boolPtr(record["extractLinks"]),
		SimulateUser:            boolPtr(record["simulateUser"]),
		OverrideNavigator:       boolPtr(record["overrideNavigator"]),
		JSCode:                  stringSlice(record["jsCode"]),
		JSOnly:                  boolPtr(record["jsOnly"]),
		WaitForSelector:         stringPtr(record["waitForSelector"]),
		WaitForScript:           stringPtr(record["waitForScript"]),
		WaitForTimeoutMs:        intPtr(record["waitForTimeoutMs"]),
		WaitUntil:               stringPtr(record["waitUntil"]),
		PageTimeoutMs:           intPtr(record["pageTimeoutMs"]),
		DelayBeforeReturnHTMLMs: intPtr(record["delayBeforeReturnHtmlMs"]),
		MeanDelayMs:             intPtr(record["meanDelayMs"]),
		MaxDelayRangeMs:         intPtr(record["maxDelayRangeMs"]),
		SemaphoreCount:          intPtr(record["semaphoreCount"]),
		RemoveForms:             boolPtr(record["removeForms"]),
		CacheMode:               stringPtr(record["cacheMode"]),
		WordCountThreshold:      intPtr(record["wordCountThreshold"]),
		ExcludeExternalLinks:    boolPtr(record["excludeExternalLinks"]),
		RemoveOverlayElements:   boolPtr(record["removeOverlayElements"]),
		ProcessIframes:          boolPtr(record["processIframes"]),
		TextMode:                boolPtr(record["textMode"]),
		CaptureScreenshot:       boolPtr(record["captureScreenshot"]),
		CSSSelector:             stringPtr(record["cssSelector"]),
		ExcludedTags:            stringSlice(record["excludedTags"]),
		VirtualScroll:           virtualScroll(record["virtualScroll"]),
		WaitForImages:           boolPtr(record["waitForImages"]),
		PageTypeHint:            stringPtr(record["pageTypeHint"]),
		AutoExpandDetails:       boolPtr(record["autoExpandDetails"]),
		DetailExpansion:         detailExpansion(record["detailExpansion"]),
		QualityProfile:          stringPtr(record["qualityProfile"]),
	}
}

func markdownOptions(value any) *crawloptions.MarkdownOptionsInput {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return &crawloptions.MarkdownOptionsInput{
		ContentSource: stringPtr(record["contentSource"]),
		IgnoreLinks:   boolPtr(record["ignoreLinks"]),
		EscapeHTML:    boolPtr(record["escapeHtml"]),
		Citations:     boolPtr(record["citations"]),
		BodyWidth:     intPtr(record["bodyWidth"]),
	}
}

func markdownFilter(value any) *crawloptions.MarkdownFilter {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	filter := &crawloptions.MarkdownFilter{
		Threshold:        floatPtr(record["threshold"]),
		ThresholdType:    stringPtr(record["thresholdType"]),
		MinWordThreshold: intPtr(record["minWordThreshold"]),
		UserQuery:        stringPtr(record["userQuery"]),
		BM25Threshold:    floatPtr(record["bm25Threshold"]),
		Language:         stringPtr(record["language"]),
	}
	if kind, ok := record["type"].(string); ok {
		filter.Type = kind
	}
	return filter
}

func strategy(value any) *crawloptions.MarkdownStrategyInput {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return &crawloptions.MarkdownStrategyInput{
		Type:   stringPtr(record["type"]),
		Params: objectJSON(record["params"]),
	}
}

func tableExtraction(value any) *crawloptions.TableExtractionInput {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return &crawloptions.TableExtractionInput{
		Type:   stringPtr(record["type"]),
		Params: objectJSON(record["params"]),
	}
}

func cleanMarkdown(value any) *crawloptions.CleanMarkdownInput {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return &crawloptions.CleanMarkdownInput{
		CSSSelector:           stringPtr(record["cssSelector"]),
		TargetElements:        stringSlice(record["targetElements"]),
		ExcludedTags:          stringSlice(record["excludedTags"]),
		RemoveOverlayElements: boolPtr(record["removeOverlayElements"]),
		WordCountThreshold:    intPtr(record["wordCountThreshold"]),
	}
}

func virtualScroll(value any) *crawloptions.VirtualScroll {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	container := ""
	if raw, ok := record["containerSelector"].(string); ok {
		container = raw
	}
	return &crawloptions.VirtualScroll{
		ContainerSelector: container,
		ScrollCount:       intPtr(record["scrollCount"]),
		ScrollBy:          scrollByJSON(record["scrollBy"]),
		WaitAfterScrollMs: intPtr(record["waitAfterScrollMs"]),
	}
}

func scrollByJSON(value any) json.RawMessage {
	if value == nil {
		return nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return encoded
}

func linkPreview(value any) *crawloptions.LinkPreviewOptionsInput {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return &crawloptions.LinkPreviewOptionsInput{
		IncludeInternal: boolPtr(record["includeInternal"]),
		IncludeExternal: boolPtr(record["includeExternal"]),
		IncludeSocial:   boolPtr(record["includeSocial"]),
		MaxLinks:        intPtr(record["maxLinks"]),
		Concurrency:     intPtr(record["concurrency"]),
		TimeoutSeconds:  intPtr(record["timeoutSeconds"]),
		Query:           stringPtr(record["query"]),
		ScoreThreshold:  floatPtr(record["scoreThreshold"]),
		Verbose:         boolPtr(record["verbose"]),
		IncludePatterns: stringSlice(record["includePatterns"]),
		ExcludePatterns: stringSlice(record["excludePatterns"]),
	}
}

func browserHeaders(value any) []crawloptions.BrowserHeader {
	entries, ok := value.([]any)
	if !ok {
		return nil
	}
	headers := make([]crawloptions.BrowserHeader, 0, len(entries))
	for _, entry := range entries {
		record, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		name, _ := record["name"].(string)
		headerValue, _ := record["value"].(string)
		headers = append(headers, crawloptions.BrowserHeader{Name: name, Value: headerValue})
	}
	return headers
}

func browserCookies(value any) []crawloptions.BrowserCookie {
	entries, ok := value.([]any)
	if !ok {
		return nil
	}
	cookies := make([]crawloptions.BrowserCookie, 0, len(entries))
	for _, entry := range entries {
		record, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		name, _ := record["name"].(string)
		cookieValue, _ := record["value"].(string)
		domain, _ := record["domain"].(string)
		cookies = append(cookies, crawloptions.BrowserCookie{
			Name:   name,
			Value:  cookieValue,
			Domain: domain,
			Path:   stringPtr(record["path"]),
		})
	}
	return cookies
}

func userAgentGenerator(value any) *crawloptions.UserAgentGenerator {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return &crawloptions.UserAgentGenerator{
		Platform:   stringPtr(record["platform"]),
		Browser:    stringPtr(record["browser"]),
		DeviceType: stringPtr(record["deviceType"]),
		Locale:     stringPtr(record["locale"]),
	}
}

func geolocation(value any) *crawloptions.Geolocation {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	latitude, okLatitude := floatValue(record["latitude"])
	longitude, okLongitude := floatValue(record["longitude"])
	if !okLatitude || !okLongitude {
		return nil
	}
	return &crawloptions.Geolocation{
		Latitude:  latitude,
		Longitude: longitude,
		Accuracy:  floatPtr(record["accuracy"]),
	}
}

func detailExpansion(value any) *crawloptions.DetailExpansion {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return &crawloptions.DetailExpansion{
		MaxDetailUrls:               intPtr(record["maxDetailUrls"]),
		MinRelevanceScore:           floatPtr(record["minRelevanceScore"]),
		RequireSameDomain:           boolPtr(record["requireSameDomain"]),
		AllowExternalLinks:          boolPtr(record["allowExternalLinks"]),
		IncludeURLPatterns:          stringSlice(record["includeUrlPatterns"]),
		ExcludeURLPatterns:          stringSlice(record["excludeUrlPatterns"]),
		MinPublishTimeConfidence:    floatPtr(record["minPublishTimeConfidence"]),
		PreferFitMarkdownForQuality: boolPtr(record["preferFitMarkdownForQuality"]),
	}
}

// objectJSON re-encodes a params map so normalizeStrategyParams can copy it.
func objectJSON(value any) json.RawMessage {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return nil
	}
	return encoded
}

func stringPtr(value any) *string {
	text, ok := value.(string)
	if !ok {
		return nil
	}
	return &text
}

func boolPtr(value any) *bool {
	flag, ok := value.(bool)
	if !ok {
		return nil
	}
	return &flag
}

func intPtr(value any) *int {
	number, ok := intValue(value)
	if !ok {
		return nil
	}
	return &number
}

func floatPtr(value any) *float64 {
	number, ok := floatValue(value)
	if !ok {
		return nil
	}
	return &number
}

func intValue(value any) (int, bool) {
	switch typed := value.(type) {
	case int:
		return typed, true
	case int64:
		return int(typed), true
	case float64:
		return int(typed), true
	}
	return 0, false
}

func floatValue(value any) (float64, bool) {
	switch typed := value.(type) {
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case float64:
		return typed, true
	}
	return 0, false
}

func stringSlice(value any) []string {
	entries, ok := value.([]any)
	if !ok {
		return nil
	}
	return stringList(entries)
}

func stringList(entries []any) []string {
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		if text, ok := entry.(string); ok {
			out = append(out, text)
		}
	}
	return out
}
