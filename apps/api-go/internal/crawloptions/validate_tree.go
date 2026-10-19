package crawloptions

import (
	"encoding/json"
	"strings"
)

// This file is the CreateCrawlTaskDto nested tree. Property order follows the
// DTO declaration order, and each property runs its decorators in declaration
// order, which is how class-validator orders the message array.

// validateCreateTask walks CreateCrawlTaskDto.
func (v *restValidator) validateCreateTask(request *createTaskRequest) CreateTaskInput {
	input := CreateTaskInput{}

	// url: @IsUrl() then @IsSafeUrl().
	var urlValue string
	urlIsString := !nullish(request.URL) && json.Unmarshal(request.URL, &urlValue) == nil
	if !urlIsString || !looksLikeURL(urlValue) {
		v.add("url", "must be a URL address")
	}
	if !urlIsString {
		v.addDynamic("url", "URL must be a string")
	} else if v.urls != nil {
		if message := v.urls.Validate(v.ctx, urlValue); message != "" {
			v.addDynamic("url", message)
		}
	}
	input.URL = urlValue

	input.DisplayName = v.optionalString(request.DisplayName, "displayName", 0)
	input.IngestToItems = v.optionalBool(request.IngestToItems, "ingestToItems")
	input.TimeRangeFrom = v.optionalISO8601(request.TimeRangeFrom, "timeRangeFrom")
	input.TimeRangeTo = v.optionalISO8601(request.TimeRangeTo, "timeRangeTo")
	input.Concurrency = v.optionalInt(request.Concurrency, "concurrency", intPtr(1), intPtr(10))
	if !nullish(request.Keywords) {
		input.Keywords = v.stringArray(request.Keywords, "keywords", 0, 25)
	}
	input.Options = v.validateOptions(request.Options, "options")
	return input
}

// optionalISO8601 validates @IsISO8601().
func (v *restValidator) optionalISO8601(raw json.RawMessage, path string) *string {
	if nullish(raw) {
		return nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil || !looksLikeISO8601(value) {
		v.add(path, "must be a valid ISO 8601 date string")
		return nil
	}
	return &value
}

// looksLikeISO8601 accepts the date-time shapes validator.js isISO8601 accepts
// with its default options (strict=false, strictSeparator=false).
func looksLikeISO8601(value string) bool {
	if _, ok := parseJSDate(value); ok {
		return true
	}
	for _, layout := range []string{
		"2006-01-02T15:04Z07:00",
		"2006-01-02T15:04:05Z07:00",
		"2006-01-02T15:04:05.999Z07:00",
		"2006-01-02T15:04:05.999999999Z07:00",
		"2006-01-02T15:04:05.999999",
		"2006-01-02T15:04:05,999",
	} {
		if _, ok := parseLayout(layout, value); ok {
			return true
		}
	}
	return false
}

// validateOptions walks CrawlOptionsDto.
func (v *restValidator) validateOptions(raw json.RawMessage, path string) *OptionsInput {
	if nullish(raw) {
		return nil
	}
	if !isJSONObject(raw) {
		v.validateNestedValue(raw, path, func(entry json.RawMessage, entryPath string) {
			v.validateOptionsObject(entry, entryPath)
		})
		return nil
	}
	return v.validateOptionsObject(raw, path)
}

func (v *restValidator) validateOptionsObject(raw json.RawMessage, path string) *OptionsInput {
	v.rejectUnknown(raw, "options", path)
	var request optionsRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		return nil
	}
	out := &OptionsInput{}
	out.IncludeImages = v.optionalBool(request.IncludeImages, path+".includeImages")
	out.StoreMedia = v.optionalBool(request.StoreMedia, path+".storeMedia")
	out.OnlyMainContent = v.optionalBool(request.OnlyMainContent, path+".onlyMainContent")
	out.ExtractLinks = v.optionalBool(request.ExtractLinks, path+".extractLinks")
	out.ScanFullPage = v.optionalBool(request.ScanFullPage, path+".scanFullPage")
	out.AdjustViewportToContent = v.optionalBool(request.AdjustViewportToContent, path+".adjustViewportToContent")
	out.ScrollDelayMs = v.optionalInt(request.ScrollDelayMs, path+".scrollDelayMs", intPtr(0), intPtr(5000))
	out.Headless = v.optionalBool(request.Headless, path+".headless")
	out.EnableUndetectedBrowser = v.optionalBool(request.EnableUndetectedBrowser, path+".enableUndetectedBrowser")
	out.EnableStealthMode = v.optionalBool(request.EnableStealthMode, path+".enableStealthMode")
	out.AntiBotMode = v.optionalEnum(request.AntiBotMode, path+".antiBotMode", "auto", "enabled", "disabled")
	out.UseManagedBrowser = v.optionalBool(request.UseManagedBrowser, path+".useManagedBrowser")
	out.UserDataDir = v.optionalString(request.UserDataDir, path+".userDataDir", 512)
	out.SimulateUser = v.optionalBool(request.SimulateUser, path+".simulateUser")
	out.OverrideNavigator = v.optionalBool(request.OverrideNavigator, path+".overrideNavigator")
	out.JSCode = v.validateJSCodeArray(request.JSCode, path+".jsCode")
	out.JSOnly = v.optionalBool(request.JSOnly, path+".jsOnly")
	out.WaitForSelector = v.optionalString(request.WaitForSelector, path+".waitForSelector", 1024)
	out.WaitForScript = v.optionalString(request.WaitForScript, path+".waitForScript", 4000)
	out.WaitForTimeoutMs = v.optionalInt(request.WaitForTimeoutMs, path+".waitForTimeoutMs", intPtr(500), intPtr(60000))
	out.WaitUntil = v.optionalEnum(request.WaitUntil, path+".waitUntil", "domcontentloaded", "load", "networkidle", "commit")
	out.PageTimeoutMs = v.optionalInt(request.PageTimeoutMs, path+".pageTimeoutMs", intPtr(1000), intPtr(180000))
	out.DelayBeforeReturnHTMLMs = v.optionalInt(request.DelayBeforeReturnHTMLMs, path+".delayBeforeReturnHtmlMs", intPtr(0), intPtr(30000))
	out.MeanDelayMs = v.optionalInt(request.MeanDelayMs, path+".meanDelayMs", intPtr(0), intPtr(10000))
	out.MaxDelayRangeMs = v.optionalInt(request.MaxDelayRangeMs, path+".maxDelayRangeMs", intPtr(0), intPtr(10000))
	out.SemaphoreCount = v.optionalInt(request.SemaphoreCount, path+".semaphoreCount", intPtr(1), intPtr(50))
	out.RemoveForms = v.optionalBool(request.RemoveForms, path+".removeForms")
	if !nullish(request.AdditionalURLs) {
		out.AdditionalURLs = v.urlArray(request.AdditionalURLs, path+".additionalUrls", 25)
	}
	out.MultiURLConfigs = v.validateMultiURLConfigs(request.MultiURLConfigs, path+".multiUrlConfigs")
	out.MarkdownOptions = v.validateMarkdownOptions(request.MarkdownOptions, path+".markdownOptions")
	out.MarkdownFilter = v.validateMarkdownFilter(request.MarkdownFilter, path+".markdownFilter")
	out.MarkdownStrategy = v.validateMarkdownStrategy(request.MarkdownStrategy, path+".markdownStrategy")
	out.TableScoreThreshold = v.optionalNumber(request.TableScoreThreshold, path+".tableScoreThreshold", floatPtr(0), floatPtr(10), "tableScoreThreshold must be a number")
	out.TableExtraction = v.validateTableExtraction(request.TableExtraction, path+".tableExtraction")
	out.CleanMarkdown = v.validateCleanMarkdown(request.CleanMarkdown, path+".cleanMarkdown")
	out.VirtualScroll = v.validateVirtualScroll(request.VirtualScroll, path+".virtualScroll")
	out.ScoreLinks = v.optionalBool(request.ScoreLinks, path+".scoreLinks")
	out.LinkPreview = v.validateLinkPreview(request.LinkPreview, path+".linkPreview")
	out.BrowserHeaders = v.validateBrowserHeaders(request.BrowserHeaders, path+".browserHeaders")
	out.BrowserCookies = v.validateBrowserCookies(request.BrowserCookies, path+".browserCookies")
	out.UserAgent = v.optionalString(request.UserAgent, path+".userAgent", 768)
	out.UserAgentMode = v.optionalEnum(request.UserAgentMode, path+".userAgentMode", "random")
	out.UserAgentGenerator = v.validateUserAgentGenerator(request.UserAgentGenerator, path+".userAgentGenerator")
	out.Locale = v.optionalString(request.Locale, path+".locale", 16)
	out.TimezoneID = v.optionalString(request.TimezoneID, path+".timezoneId", 64)
	out.Geolocation = v.validateGeolocation(request.Geolocation, path+".geolocation")
	out.SessionID = v.optionalString(request.SessionID, path+".sessionId", 160)
	out.StorageState = v.optionalString(request.StorageState, path+".storageState", 12000)
	out.WordCountThreshold = v.optionalInt(request.WordCountThreshold, path+".wordCountThreshold", intPtr(0), intPtr(5000))
	out.ExcludeExternalLinks = v.optionalBool(request.ExcludeExternalLinks, path+".excludeExternalLinks")
	out.ExcludeExternalImages = v.optionalBool(request.ExcludeExternalImages, path+".excludeExternalImages")
	out.WaitForImages = v.optionalBool(request.WaitForImages, path+".waitForImages")
	out.PageTypeHint = v.optionalEnum(request.PageTypeHint, path+".pageTypeHint", "auto", "list", "detail")
	out.AutoExpandDetails = v.optionalBool(request.AutoExpandDetails, path+".autoExpandDetails")
	out.DetailExpansion = v.validateDetailExpansion(request.DetailExpansion, path+".detailExpansion")
	out.QualityProfile = v.optionalEnum(request.QualityProfile, path+".qualityProfile", "balanced", "quality_first", "speed_first")
	out.RemoveOverlayElements = v.optionalBool(request.RemoveOverlayElements, path+".removeOverlayElements")
	out.ProcessIframes = v.optionalBool(request.ProcessIframes, path+".processIframes")
	out.TextMode = v.optionalBool(request.TextMode, path+".textMode")
	out.CaptureScreenshot = v.optionalBool(request.CaptureScreenshot, path+".captureScreenshot")
	out.CSSSelector = v.optionalString(request.CSSSelector, path+".cssSelector", 512)
	if !nullish(request.ExcludedTags) {
		out.ExcludedTags = v.stringArray(request.ExcludedTags, path+".excludedTags", 0, 10)
	}
	return out
}

// optionalEnum validates @IsIn and returns the raw string.
func (v *restValidator) optionalEnum(raw json.RawMessage, path string, options ...string) *string {
	if nullish(raw) {
		return nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		v.add(path, "must be one of the following values: "+strings.Join(options, ","))
		return nil
	}
	if !oneOf(value, options...) {
		v.add(path, "must be one of the following values: "+strings.Join(options, ","))
		return nil
	}
	return &value
}

// validateJSCodeArray validates @IsArray + @ArrayMaxSize(5) + @IsString(each) +
// @MaxLength(2000, each) + @IsAllowedJsCode(each).
//
// Deliberate deviation: the NestJS IsAllowedJsCode constraint expects the whole
// array even when registered with { each: true }, so class-validator calls it
// once per string and every non-empty jsCode array is rejected with
// "Expected an array of strings". That is an implementation bug (it makes the
// admin JS exemption unreachable over REST), and the product contract in this
// batch requires the strip/admin path to work. Go therefore validates each
// script against the same allowlist, which accepts the scripts the NestJS
// validator intends to accept.
func (v *restValidator) validateJSCodeArray(raw json.RawMessage, path string) []string {
	if nullish(raw) {
		return nil
	}
	entries, ok := v.arrayItems(raw, path, nil, intPtr(MaxScriptsCount))
	if !ok {
		return nil
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		var value string
		if err := json.Unmarshal(entry, &value); err != nil {
			v.addEach(path, "must be a string")
			continue
		}
		if utf16Length(value) > MaxScriptLength {
			v.addEach(path, "must be shorter than or equal to 2000 characters")
			continue
		}
		if blocked := ValidateJSCode(value); len(blocked) > 0 {
			v.addDynamic(path, JSCodeConstraintMessage(leafName(path), blocked))
			continue
		}
		out = append(out, value)
	}
	return out
}

// validateNestedValue applies @ValidateNested() to a value. Arrays validate
// every element (class-validator behaviour); primitives produce the nested
// message.
func (v *restValidator) validateNestedValue(raw json.RawMessage, path string, validate func(json.RawMessage, string)) {
	if isJSONArray(raw) {
		var entries []json.RawMessage
		if err := json.Unmarshal(raw, &entries); err != nil {
			v.add(path, "must be either object or array")
			return
		}
		for index, entry := range entries {
			entryPath := path + "." + formatInt(index)
			if !isJSONObject(entry) {
				v.add(entryPath, "must be either object or array")
				continue
			}
			validate(entry, entryPath)
		}
		return
	}
	if isJSONObject(raw) {
		validate(raw, path)
		return
	}
	v.add(path, "must be either object or array")
}

// validateNestedEach applies @IsArray + @ArrayMaxSize + @ValidateNested(each).
func (v *restValidator) validateNestedEach(
	raw json.RawMessage,
	path, schemaName string,
	max int,
	validate func(json.RawMessage, string),
) {
	if nullish(raw) {
		return
	}
	if isJSONArray(raw) {
		entries, ok := v.arrayItems(raw, path, nil, optionalLimit(max))
		if !ok {
			return
		}
		for index, entry := range entries {
			entryPath := path + "." + formatInt(index)
			if !isJSONObject(entry) {
				v.add(entryPath, "must be either object or array")
				continue
			}
			validate(entry, entryPath)
		}
		return
	}
	v.add(path, "must be an array")
	v.validateNestedValue(raw, path, validate)
}

// validateMultiURLConfigs walks CrawlMultiUrlConfigDto.
func (v *restValidator) validateMultiURLConfigs(raw json.RawMessage, path string) []MultiURLConfig {
	if nullish(raw) {
		return nil
	}
	out := make([]MultiURLConfig, 0)
	v.validateNestedEach(raw, path, "multiUrlConfig", 25, func(entry json.RawMessage, entryPath string) {
		v.rejectUnknown(entry, "multiUrlConfig", entryPath)
		var request multiURLConfigRequest
		if err := json.Unmarshal(entry, &request); err != nil {
			return
		}
		config := MultiURLConfig{}
		config.Name = v.optionalString(request.Name, entryPath+".name", 120)
		if !nullish(request.URLs) {
			config.URLs = v.urlArray(request.URLs, entryPath+".urls", 25)
		}
		config.Matcher = v.validateURLMatcher(request.Matcher, entryPath+".matcher")
		config.Options = v.validateStrategyOverrides(request.Options, entryPath+".options")
		out = append(out, config)
	})
	if len(out) == 0 {
		return nil
	}
	return out
}

// validateURLMatcher walks CrawlUrlMatcherDto.
func (v *restValidator) validateURLMatcher(raw json.RawMessage, path string) *URLMatcher {
	if nullish(raw) {
		return nil
	}
	var matcher *URLMatcher
	v.validateNestedValue(raw, path, func(entry json.RawMessage, entryPath string) {
		v.rejectUnknown(entry, "urlMatcher", entryPath)
		var request urlMatcherRequest
		if err := json.Unmarshal(entry, &request); err != nil {
			return
		}
		matcher = &URLMatcher{
			MatchMode: v.optionalEnum(request.MatchMode, entryPath+".matchMode", "glob", "regex", "substring", "prefix"),
		}
		if !nullish(request.Patterns) {
			matcher.Patterns = v.stringArray(request.Patterns, entryPath+".patterns", 1, 0)
		}
	})
	return matcher
}

// validateStrategyOverrides walks CrawlStrategyOverridesDto.
func (v *restValidator) validateStrategyOverrides(raw json.RawMessage, path string) *StrategyOverrides {
	if nullish(raw) {
		return nil
	}
	var overrides *StrategyOverrides
	v.validateNestedValue(raw, path, func(entry json.RawMessage, entryPath string) {
		v.rejectUnknown(entry, "strategyOverrides", entryPath)
		var request strategyOverridesRequest
		if err := json.Unmarshal(entry, &request); err != nil {
			return
		}
		overrides = &StrategyOverrides{
			ScanFullPage:            v.optionalBool(request.ScanFullPage, entryPath+".scanFullPage"),
			AdjustViewportToContent: v.optionalBool(request.AdjustViewportToContent, entryPath+".adjustViewportToContent"),
			ScrollDelayMs:           v.optionalInt(request.ScrollDelayMs, entryPath+".scrollDelayMs", intPtr(0), intPtr(5000)),
			OnlyMainContent:         v.optionalBool(request.OnlyMainContent, entryPath+".onlyMainContent"),
			ExtractLinks:            v.optionalBool(request.ExtractLinks, entryPath+".extractLinks"),
			SimulateUser:            v.optionalBool(request.SimulateUser, entryPath+".simulateUser"),
			OverrideNavigator:       v.optionalBool(request.OverrideNavigator, entryPath+".overrideNavigator"),
			JSCode:                  v.validateJSCodeArray(request.JSCode, entryPath+".jsCode"),
			JSOnly:                  v.optionalBool(request.JSOnly, entryPath+".jsOnly"),
			WaitForSelector:         v.optionalString(request.WaitForSelector, entryPath+".waitForSelector", 1024),
			WaitForScript:           v.optionalString(request.WaitForScript, entryPath+".waitForScript", 4000),
			WaitForTimeoutMs:        v.optionalInt(request.WaitForTimeoutMs, entryPath+".waitForTimeoutMs", intPtr(500), intPtr(60000)),
			WaitUntil:               v.optionalEnum(request.WaitUntil, entryPath+".waitUntil", "domcontentloaded", "load", "networkidle", "commit"),
			PageTimeoutMs:           v.optionalInt(request.PageTimeoutMs, entryPath+".pageTimeoutMs", intPtr(1000), intPtr(180000)),
			DelayBeforeReturnHTMLMs: v.optionalInt(request.DelayBeforeReturnHTMLMs, entryPath+".delayBeforeReturnHtmlMs", intPtr(0), intPtr(30000)),
			MeanDelayMs:             v.optionalInt(request.MeanDelayMs, entryPath+".meanDelayMs", intPtr(0), intPtr(10000)),
			MaxDelayRangeMs:         v.optionalInt(request.MaxDelayRangeMs, entryPath+".maxDelayRangeMs", intPtr(0), intPtr(10000)),
			SemaphoreCount:          v.optionalInt(request.SemaphoreCount, entryPath+".semaphoreCount", intPtr(1), intPtr(50)),
			RemoveForms:             v.optionalBool(request.RemoveForms, entryPath+".removeForms"),
			CacheMode:               v.optionalEnum(request.CacheMode, entryPath+".cacheMode", "bypass", "prefer_cache", "force_cache"),
			WordCountThreshold:      v.optionalInt(request.WordCountThreshold, entryPath+".wordCountThreshold", intPtr(0), intPtr(5000)),
			ExcludeExternalLinks:    v.optionalBool(request.ExcludeExternalLinks, entryPath+".excludeExternalLinks"),
			RemoveOverlayElements:   v.optionalBool(request.RemoveOverlayElements, entryPath+".removeOverlayElements"),
			ProcessIframes:          v.optionalBool(request.ProcessIframes, entryPath+".processIframes"),
			TextMode:                v.optionalBool(request.TextMode, entryPath+".textMode"),
			CaptureScreenshot:       v.optionalBool(request.CaptureScreenshot, entryPath+".captureScreenshot"),
			CSSSelector:             v.optionalString(request.CSSSelector, entryPath+".cssSelector", 512),
			VirtualScroll:           v.validateVirtualScroll(request.VirtualScroll, entryPath+".virtualScroll"),
			WaitForImages:           v.optionalBool(request.WaitForImages, entryPath+".waitForImages"),
			PageTypeHint:            v.optionalEnum(request.PageTypeHint, entryPath+".pageTypeHint", "auto", "list", "detail"),
			AutoExpandDetails:       v.optionalBool(request.AutoExpandDetails, entryPath+".autoExpandDetails"),
			DetailExpansion:         v.validateDetailExpansion(request.DetailExpansion, entryPath+".detailExpansion"),
			QualityProfile:          v.optionalEnum(request.QualityProfile, entryPath+".qualityProfile", "balanced", "quality_first", "speed_first"),
		}
		if !nullish(request.ExcludedTags) {
			overrides.ExcludedTags = v.stringArray(request.ExcludedTags, entryPath+".excludedTags", 0, 10)
		}
	})
	return overrides
}

// validateMarkdownOptions walks CrawlMarkdownOptionsDto.
func (v *restValidator) validateMarkdownOptions(raw json.RawMessage, path string) *MarkdownOptionsInput {
	if nullish(raw) {
		return nil
	}
	var options *MarkdownOptionsInput
	v.validateNestedValue(raw, path, func(entry json.RawMessage, entryPath string) {
		v.rejectUnknown(entry, "markdownOptions", entryPath)
		var request markdownOptionsRequest
		if err := json.Unmarshal(entry, &request); err != nil {
			return
		}
		options = &MarkdownOptionsInput{
			ContentSource: v.optionalEnum(request.ContentSource, entryPath+".contentSource", "raw_html", "cleaned_html", "fit_html"),
			IgnoreLinks:   v.optionalBool(request.IgnoreLinks, entryPath+".ignoreLinks"),
			EscapeHTML:    v.optionalBool(request.EscapeHTML, entryPath+".escapeHtml"),
			Citations:     v.optionalBool(request.Citations, entryPath+".citations"),
			BodyWidth:     v.optionalInt(request.BodyWidth, entryPath+".bodyWidth", intPtr(40), intPtr(200)),
		}
	})
	return options
}

// validateMarkdownFilter walks CrawlMarkdownFilterDto.
func (v *restValidator) validateMarkdownFilter(raw json.RawMessage, path string) *MarkdownFilter {
	if nullish(raw) {
		return nil
	}
	var filter *MarkdownFilter
	v.validateNestedValue(raw, path, func(entry json.RawMessage, entryPath string) {
		v.rejectUnknown(entry, "markdownFilter", entryPath)
		var request markdownFilterRequest
		if err := json.Unmarshal(entry, &request); err != nil {
			return
		}
		filter = &MarkdownFilter{
			Threshold:        v.optionalNumber(request.Threshold, entryPath+".threshold", floatPtr(0), floatPtr(1), "threshold must be a number"),
			ThresholdType:    v.optionalEnum(request.ThresholdType, entryPath+".thresholdType", "fixed", "dynamic"),
			MinWordThreshold: v.optionalInt(request.MinWordThreshold, entryPath+".minWordThreshold", intPtr(0), intPtr(500)),
			UserQuery:        v.optionalString(request.UserQuery, entryPath+".userQuery", 240),
			BM25Threshold:    v.optionalNumber(request.BM25Threshold, entryPath+".bm25Threshold", floatPtr(0), floatPtr(20), "bm25Threshold must be a number"),
			Language:         v.optionalString(request.Language, entryPath+".language", 32),
		}
		if kind := v.optionalEnum(request.Type, entryPath+".type", "pruning", "bm25"); kind != nil {
			filter.Type = *kind
		}
	})
	return filter
}

// validateMarkdownStrategy walks CrawlMarkdownStrategyDto.
func (v *restValidator) validateMarkdownStrategy(raw json.RawMessage, path string) *MarkdownStrategyInput {
	kind, params, ok := v.validateStrategyObject(raw, path)
	if !ok {
		return nil
	}
	return &MarkdownStrategyInput{Type: kind, Params: params}
}

// validateTableExtraction walks CrawlTableExtractionStrategyDto.
func (v *restValidator) validateTableExtraction(raw json.RawMessage, path string) *TableExtractionInput {
	kind, params, ok := v.validateStrategyObject(raw, path)
	if !ok {
		return nil
	}
	return &TableExtractionInput{Type: kind, Params: params}
}

// validateStrategyObject validates the shared {type, params} shape.
func (v *restValidator) validateStrategyObject(raw json.RawMessage, path string) (*string, json.RawMessage, bool) {
	if nullish(raw) {
		return nil, nil, false
	}
	var kind *string
	var params json.RawMessage
	valid := false
	v.validateNestedValue(raw, path, func(entry json.RawMessage, entryPath string) {
		v.rejectUnknown(entry, "strategy", entryPath)
		var request strategyRequest
		if err := json.Unmarshal(entry, &request); err != nil {
			return
		}
		valid = true
		kind = v.requiredString(request.Type, entryPath+".type", 128)
		if !nullish(request.Params) && !isJSONObject(request.Params) {
			v.add(entryPath+".params", "must be an object")
			return
		}
		params = request.Params
	})
	return kind, params, valid
}

// requiredString validates a non-optional string.
func (v *restValidator) requiredString(raw json.RawMessage, path string, maxLen int) *string {
	if nullish(raw) {
		v.add(path, "must be a string")
		return nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		v.add(path, "must be a string")
		return nil
	}
	if maxLen > 0 && utf16Length(value) > maxLen {
		v.add(path, "must be shorter than or equal to "+formatInt(maxLen)+" characters")
		return nil
	}
	return &value
}

// validateCleanMarkdown walks CrawlCleanMarkdownOptionsDto.
func (v *restValidator) validateCleanMarkdown(raw json.RawMessage, path string) *CleanMarkdownInput {
	if nullish(raw) {
		return nil
	}
	var options *CleanMarkdownInput
	v.validateNestedValue(raw, path, func(entry json.RawMessage, entryPath string) {
		v.rejectUnknown(entry, "cleanMarkdown", entryPath)
		var request cleanMarkdownRequest
		if err := json.Unmarshal(entry, &request); err != nil {
			return
		}
		options = &CleanMarkdownInput{
			CSSSelector:           v.optionalString(request.CSSSelector, entryPath+".cssSelector", 512),
			RemoveOverlayElements: v.optionalBool(request.RemoveOverlayElements, entryPath+".removeOverlayElements"),
			WordCountThreshold:    v.optionalInt(request.WordCountThreshold, entryPath+".wordCountThreshold", intPtr(0), intPtr(2000)),
		}
		if !nullish(request.TargetElements) {
			options.TargetElements = v.stringArray(request.TargetElements, entryPath+".targetElements", 0, 10)
		}
		if !nullish(request.ExcludedTags) {
			options.ExcludedTags = v.stringArray(request.ExcludedTags, entryPath+".excludedTags", 0, 10)
		}
	})
	return options
}

// validateVirtualScroll walks CrawlVirtualScrollConfigDto.
func (v *restValidator) validateVirtualScroll(raw json.RawMessage, path string) *VirtualScroll {
	if nullish(raw) {
		return nil
	}
	var scroll *VirtualScroll
	v.validateNestedValue(raw, path, func(entry json.RawMessage, entryPath string) {
		v.rejectUnknown(entry, "virtualScroll", entryPath)
		var request virtualScrollRequest
		if err := json.Unmarshal(entry, &request); err != nil {
			return
		}
		scroll = &VirtualScroll{
			ContainerSelector: valueOrEmpty(v.optionalString(request.ContainerSelector, entryPath+".containerSelector", 512)),
			ScrollCount:       v.optionalInt(request.ScrollCount, entryPath+".scrollCount", intPtr(1), intPtr(1000)),
			WaitAfterScrollMs: v.optionalInt(request.WaitAfterScrollMs, entryPath+".waitAfterScrollMs", intPtr(0), intPtr(60000)),
		}
		scroll.ScrollBy = v.validateScrollBy(request.ScrollBy, entryPath+".scrollBy")
		if !nullish(request.ScrollByPixels) {
			_ = v.optionalInt(request.ScrollByPixels, entryPath+".scrollByPixels", intPtr(1), intPtr(20000))
		}
	})
	return scroll
}

// validateScrollBy is the CrawlVirtualScrollByValidator union.
func (v *restValidator) validateScrollBy(raw json.RawMessage, path string) json.RawMessage {
	if nullish(raw) {
		return nil
	}
	trimmed := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trimmed, `"`) {
		var value string
		if json.Unmarshal(raw, &value) == nil {
			if oneOf(value, "container_height", "page_height", "viewport", "pixels") {
				return raw
			}
		}
	} else {
		if value, ok := jsToNumber(raw); ok && isFinite(value) && value >= 1 && value <= 20000 {
			return raw
		}
	}
	v.addDynamic(path, "scrollBy must be a scroll mode or a pixel count between 1 and 20000")
	return nil
}

// validateLinkPreview walks CrawlLinkPreviewOptionsDto.
func (v *restValidator) validateLinkPreview(raw json.RawMessage, path string) *LinkPreviewOptionsInput {
	if nullish(raw) {
		return nil
	}
	var preview *LinkPreviewOptionsInput
	v.validateNestedValue(raw, path, func(entry json.RawMessage, entryPath string) {
		v.rejectUnknown(entry, "linkPreview", entryPath)
		var request linkPreviewRequest
		if err := json.Unmarshal(entry, &request); err != nil {
			return
		}
		preview = &LinkPreviewOptionsInput{
			IncludeInternal: v.optionalBool(request.IncludeInternal, entryPath+".includeInternal"),
			IncludeExternal: v.optionalBool(request.IncludeExternal, entryPath+".includeExternal"),
			IncludeSocial:   v.optionalBool(request.IncludeSocial, entryPath+".includeSocial"),
			MaxLinks:        v.optionalInt(request.MaxLinks, entryPath+".maxLinks", intPtr(1), intPtr(500)),
			Concurrency:     v.optionalInt(request.Concurrency, entryPath+".concurrency", intPtr(1), intPtr(50)),
			TimeoutSeconds:  v.optionalInt(request.TimeoutSeconds, entryPath+".timeoutSeconds", intPtr(1), intPtr(60)),
			Query:           v.optionalString(request.Query, entryPath+".query", 160),
			ScoreThreshold:  v.optionalNumber(request.ScoreThreshold, entryPath+".scoreThreshold", floatPtr(0), floatPtr(1), "scoreThreshold must be a number"),
			Verbose:         v.optionalBool(request.Verbose, entryPath+".verbose"),
		}
		if !nullish(request.IncludePatterns) {
			preview.IncludePatterns = v.stringArray(request.IncludePatterns, entryPath+".includePatterns", 0, 25)
		}
		if !nullish(request.ExcludePatterns) {
			preview.ExcludePatterns = v.stringArray(request.ExcludePatterns, entryPath+".excludePatterns", 0, 25)
		}
	})
	return preview
}

// validateBrowserHeaders walks CrawlBrowserHeaderDto.
func (v *restValidator) validateBrowserHeaders(raw json.RawMessage, path string) []BrowserHeader {
	if nullish(raw) {
		return nil
	}
	out := make([]BrowserHeader, 0)
	v.validateNestedEach(raw, path, "browserHeader", 20, func(entry json.RawMessage, entryPath string) {
		v.rejectUnknown(entry, "browserHeader", entryPath)
		var request browserHeaderRequest
		if err := json.Unmarshal(entry, &request); err != nil {
			return
		}
		header := BrowserHeader{}
		if name := v.requiredString(request.Name, entryPath+".name", 128); name != nil {
			header.Name = *name
		}
		if value := v.requiredString(request.Value, entryPath+".value", 512); value != nil {
			header.Value = *value
		}
		out = append(out, header)
	})
	if len(out) == 0 {
		return nil
	}
	return out
}

// validateBrowserCookies walks CrawlBrowserCookieDto.
func (v *restValidator) validateBrowserCookies(raw json.RawMessage, path string) []BrowserCookie {
	if nullish(raw) {
		return nil
	}
	out := make([]BrowserCookie, 0)
	v.validateNestedEach(raw, path, "browserCookie", 20, func(entry json.RawMessage, entryPath string) {
		v.rejectUnknown(entry, "browserCookie", entryPath)
		var request browserCookieRequest
		if err := json.Unmarshal(entry, &request); err != nil {
			return
		}
		cookie := BrowserCookie{}
		if name := v.requiredString(request.Name, entryPath+".name", 128); name != nil {
			cookie.Name = *name
		}
		if value := v.requiredString(request.Value, entryPath+".value", 4000); value != nil {
			cookie.Value = *value
		}
		if domain := v.requiredString(request.Domain, entryPath+".domain", 255); domain != nil {
			cookie.Domain = *domain
		}
		cookie.Path = v.optionalString(request.Path, entryPath+".path", 255)
		out = append(out, cookie)
	})
	if len(out) == 0 {
		return nil
	}
	return out
}

// validateUserAgentGenerator walks CrawlUserAgentGeneratorDto.
func (v *restValidator) validateUserAgentGenerator(raw json.RawMessage, path string) *UserAgentGenerator {
	if nullish(raw) {
		return nil
	}
	var generator *UserAgentGenerator
	v.validateNestedValue(raw, path, func(entry json.RawMessage, entryPath string) {
		v.rejectUnknown(entry, "userAgentGenerator", entryPath)
		var request userAgentGeneratorRequest
		if err := json.Unmarshal(entry, &request); err != nil {
			return
		}
		generator = &UserAgentGenerator{
			Platform:   v.optionalEnum(request.Platform, entryPath+".platform", "windows", "macos", "linux", "android", "ios"),
			Browser:    v.optionalEnum(request.Browser, entryPath+".browser", "chrome", "firefox", "safari", "edge"),
			DeviceType: v.optionalEnum(request.DeviceType, entryPath+".deviceType", "desktop", "mobile", "tablet"),
			Locale:     v.optionalString(request.Locale, entryPath+".locale", 16),
		}
	})
	return generator
}

// validateGeolocation walks CrawlGeolocationDto.
func (v *restValidator) validateGeolocation(raw json.RawMessage, path string) *Geolocation {
	if nullish(raw) {
		return nil
	}
	var geolocation *Geolocation
	v.validateNestedValue(raw, path, func(entry json.RawMessage, entryPath string) {
		v.rejectUnknown(entry, "geolocation", entryPath)
		var request geolocationRequest
		if err := json.Unmarshal(entry, &request); err != nil {
			return
		}
		latitude := v.requiredNumber(request.Latitude, entryPath+".latitude", floatPtr(-90), floatPtr(90))
		longitude := v.requiredNumber(request.Longitude, entryPath+".longitude", floatPtr(-180), floatPtr(180))
		accuracy := v.optionalNumber(request.Accuracy, entryPath+".accuracy", floatPtr(1), floatPtr(5000), "")
		if latitude == nil || longitude == nil {
			return
		}
		geolocation = &Geolocation{Latitude: *latitude, Longitude: *longitude, Accuracy: accuracy}
	})
	return geolocation
}

// requiredNumber validates a non-optional numeric field.
func (v *restValidator) requiredNumber(raw json.RawMessage, path string, min, max *float64) *float64 {
	if nullish(raw) {
		v.add(path, "must be a number conforming to the specified constraints")
		return nil
	}
	return v.optionalNumber(raw, path, min, max, "")
}

// validateDetailExpansion walks CrawlDetailExpansionOptionsDto.
func (v *restValidator) validateDetailExpansion(raw json.RawMessage, path string) *DetailExpansion {
	if nullish(raw) {
		return nil
	}
	var expansion *DetailExpansion
	v.validateNestedValue(raw, path, func(entry json.RawMessage, entryPath string) {
		v.rejectUnknown(entry, "detailExpansion", entryPath)
		var request detailExpansionRequest
		if err := json.Unmarshal(entry, &request); err != nil {
			return
		}
		expansion = &DetailExpansion{
			MaxDetailUrls:               v.optionalInt(request.MaxDetailUrls, entryPath+".maxDetailUrls", intPtr(1), intPtr(30)),
			MinRelevanceScore:           v.optionalNumber(request.MinRelevanceScore, entryPath+".minRelevanceScore", floatPtr(0), floatPtr(1), "minRelevanceScore must be a number"),
			RequireSameDomain:           v.optionalBool(request.RequireSameDomain, entryPath+".requireSameDomain"),
			AllowExternalLinks:          v.optionalBool(request.AllowExternalLinks, entryPath+".allowExternalLinks"),
			MinPublishTimeConfidence:    v.optionalNumber(request.MinPublishTimeConfidence, entryPath+".minPublishTimeConfidence", floatPtr(0), floatPtr(1), "minPublishTimeConfidence must be a number"),
			PreferFitMarkdownForQuality: v.optionalBool(request.PreferFitMarkdownForQuality, entryPath+".preferFitMarkdownForQuality"),
		}
		if !nullish(request.ExcludeURLPatterns) {
			expansion.ExcludeURLPatterns = v.stringArray(request.ExcludeURLPatterns, entryPath+".excludeUrlPatterns", 0, 25)
		}
		if !nullish(request.IncludeURLPatterns) {
			expansion.IncludeURLPatterns = v.stringArray(request.IncludeURLPatterns, entryPath+".includeUrlPatterns", 0, 25)
		}
	})
	return expansion
}

// ---------------------------------------------------------------------------
// tiny pointer helpers
// ---------------------------------------------------------------------------

func intPtr(value int) *int { return &value }

func floatPtr(value float64) *float64 { return &value }

func leafName(path string) string {
	if index := strings.LastIndex(path, "."); index >= 0 {
		return path[index+1:]
	}
	return path
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
