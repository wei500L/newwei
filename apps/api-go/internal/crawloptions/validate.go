package crawloptions

import (
	"context"
	"encoding/json"
	"math"
	"strings"
)

// This file ports the CreateCrawlTaskDto class-validator tree and the
// ValidationPipe error shape. Message text follows class-validator defaults and
// the ValidationPipe's nested-path prefixing exactly; the caller renders the
// list as a 400 Bad Request body.
//
// Decoding keeps every leaf as json.RawMessage so a wrong JSON type produces
// the class-validator message instead of a Go decoder error, and @Type(() =>
// Number) coercion can be modelled.

type createTaskRequest struct {
	URL           json.RawMessage `json:"url"`
	DisplayName   json.RawMessage `json:"displayName"`
	IngestToItems json.RawMessage `json:"ingestToItems"`
	TimeRangeFrom json.RawMessage `json:"timeRangeFrom"`
	TimeRangeTo   json.RawMessage `json:"timeRangeTo"`
	Concurrency   json.RawMessage `json:"concurrency"`
	Keywords      json.RawMessage `json:"keywords"`
	Options       json.RawMessage `json:"options"`
}

type optionsRequest struct {
	IncludeImages           json.RawMessage `json:"includeImages"`
	StoreMedia              json.RawMessage `json:"storeMedia"`
	OnlyMainContent         json.RawMessage `json:"onlyMainContent"`
	ExtractLinks            json.RawMessage `json:"extractLinks"`
	ScanFullPage            json.RawMessage `json:"scanFullPage"`
	AdjustViewportToContent json.RawMessage `json:"adjustViewportToContent"`
	ScrollDelayMs           json.RawMessage `json:"scrollDelayMs"`
	Headless                json.RawMessage `json:"headless"`
	EnableUndetectedBrowser json.RawMessage `json:"enableUndetectedBrowser"`
	EnableStealthMode       json.RawMessage `json:"enableStealthMode"`
	AntiBotMode             json.RawMessage `json:"antiBotMode"`
	UseManagedBrowser       json.RawMessage `json:"useManagedBrowser"`
	UserDataDir             json.RawMessage `json:"userDataDir"`
	SimulateUser            json.RawMessage `json:"simulateUser"`
	OverrideNavigator       json.RawMessage `json:"overrideNavigator"`
	JSCode                  json.RawMessage `json:"jsCode"`
	JSOnly                  json.RawMessage `json:"jsOnly"`
	WaitForSelector         json.RawMessage `json:"waitForSelector"`
	WaitForScript           json.RawMessage `json:"waitForScript"`
	WaitForTimeoutMs        json.RawMessage `json:"waitForTimeoutMs"`
	WaitUntil               json.RawMessage `json:"waitUntil"`
	PageTimeoutMs           json.RawMessage `json:"pageTimeoutMs"`
	DelayBeforeReturnHTMLMs json.RawMessage `json:"delayBeforeReturnHtmlMs"`
	MeanDelayMs             json.RawMessage `json:"meanDelayMs"`
	MaxDelayRangeMs         json.RawMessage `json:"maxDelayRangeMs"`
	SemaphoreCount          json.RawMessage `json:"semaphoreCount"`
	RemoveForms             json.RawMessage `json:"removeForms"`
	AdditionalURLs          json.RawMessage `json:"additionalUrls"`
	MultiURLConfigs         json.RawMessage `json:"multiUrlConfigs"`
	MarkdownOptions         json.RawMessage `json:"markdownOptions"`
	MarkdownFilter          json.RawMessage `json:"markdownFilter"`
	MarkdownStrategy        json.RawMessage `json:"markdownStrategy"`
	TableScoreThreshold     json.RawMessage `json:"tableScoreThreshold"`
	TableExtraction         json.RawMessage `json:"tableExtraction"`
	CleanMarkdown           json.RawMessage `json:"cleanMarkdown"`
	VirtualScroll           json.RawMessage `json:"virtualScroll"`
	ScoreLinks              json.RawMessage `json:"scoreLinks"`
	LinkPreview             json.RawMessage `json:"linkPreview"`
	BrowserHeaders          json.RawMessage `json:"browserHeaders"`
	BrowserCookies          json.RawMessage `json:"browserCookies"`
	UserAgent               json.RawMessage `json:"userAgent"`
	UserAgentMode           json.RawMessage `json:"userAgentMode"`
	UserAgentGenerator      json.RawMessage `json:"userAgentGenerator"`
	Locale                  json.RawMessage `json:"locale"`
	TimezoneID              json.RawMessage `json:"timezoneId"`
	Geolocation             json.RawMessage `json:"geolocation"`
	SessionID               json.RawMessage `json:"sessionId"`
	StorageState            json.RawMessage `json:"storageState"`
	WordCountThreshold      json.RawMessage `json:"wordCountThreshold"`
	ExcludeExternalLinks    json.RawMessage `json:"excludeExternalLinks"`
	ExcludeExternalImages   json.RawMessage `json:"excludeExternalImages"`
	WaitForImages           json.RawMessage `json:"waitForImages"`
	PageTypeHint            json.RawMessage `json:"pageTypeHint"`
	AutoExpandDetails       json.RawMessage `json:"autoExpandDetails"`
	DetailExpansion         json.RawMessage `json:"detailExpansion"`
	QualityProfile          json.RawMessage `json:"qualityProfile"`
	RemoveOverlayElements   json.RawMessage `json:"removeOverlayElements"`
	ProcessIframes          json.RawMessage `json:"processIframes"`
	TextMode                json.RawMessage `json:"textMode"`
	CaptureScreenshot       json.RawMessage `json:"captureScreenshot"`
	CSSSelector             json.RawMessage `json:"cssSelector"`
	ExcludedTags            json.RawMessage `json:"excludedTags"`
}

type multiURLConfigRequest struct {
	Name    json.RawMessage `json:"name"`
	URLs    json.RawMessage `json:"urls"`
	Matcher json.RawMessage `json:"matcher"`
	Options json.RawMessage `json:"options"`
}

type urlMatcherRequest struct {
	MatchMode json.RawMessage `json:"matchMode"`
	Patterns  json.RawMessage `json:"patterns"`
}

type strategyOverridesRequest struct {
	ScanFullPage            json.RawMessage `json:"scanFullPage"`
	AdjustViewportToContent json.RawMessage `json:"adjustViewportToContent"`
	ScrollDelayMs           json.RawMessage `json:"scrollDelayMs"`
	OnlyMainContent         json.RawMessage `json:"onlyMainContent"`
	ExtractLinks            json.RawMessage `json:"extractLinks"`
	SimulateUser            json.RawMessage `json:"simulateUser"`
	OverrideNavigator       json.RawMessage `json:"overrideNavigator"`
	JSCode                  json.RawMessage `json:"jsCode"`
	JSOnly                  json.RawMessage `json:"jsOnly"`
	WaitForSelector         json.RawMessage `json:"waitForSelector"`
	WaitForScript           json.RawMessage `json:"waitForScript"`
	WaitForTimeoutMs        json.RawMessage `json:"waitForTimeoutMs"`
	WaitUntil               json.RawMessage `json:"waitUntil"`
	PageTimeoutMs           json.RawMessage `json:"pageTimeoutMs"`
	DelayBeforeReturnHTMLMs json.RawMessage `json:"delayBeforeReturnHtmlMs"`
	MeanDelayMs             json.RawMessage `json:"meanDelayMs"`
	MaxDelayRangeMs         json.RawMessage `json:"maxDelayRangeMs"`
	SemaphoreCount          json.RawMessage `json:"semaphoreCount"`
	RemoveForms             json.RawMessage `json:"removeForms"`
	CacheMode               json.RawMessage `json:"cacheMode"`
	SessionID               json.RawMessage `json:"sessionId"`
	StorageState            json.RawMessage `json:"storageState"`
	WordCountThreshold      json.RawMessage `json:"wordCountThreshold"`
	ExcludeExternalLinks    json.RawMessage `json:"excludeExternalLinks"`
	RemoveOverlayElements   json.RawMessage `json:"removeOverlayElements"`
	ProcessIframes          json.RawMessage `json:"processIframes"`
	TextMode                json.RawMessage `json:"textMode"`
	CaptureScreenshot       json.RawMessage `json:"captureScreenshot"`
	CSSSelector             json.RawMessage `json:"cssSelector"`
	ExcludedTags            json.RawMessage `json:"excludedTags"`
	VirtualScroll           json.RawMessage `json:"virtualScroll"`
	WaitForImages           json.RawMessage `json:"waitForImages"`
	PageTypeHint            json.RawMessage `json:"pageTypeHint"`
	AutoExpandDetails       json.RawMessage `json:"autoExpandDetails"`
	DetailExpansion         json.RawMessage `json:"detailExpansion"`
	QualityProfile          json.RawMessage `json:"qualityProfile"`
}

type markdownOptionsRequest struct {
	ContentSource json.RawMessage `json:"contentSource"`
	IgnoreLinks   json.RawMessage `json:"ignoreLinks"`
	EscapeHTML    json.RawMessage `json:"escapeHtml"`
	Citations     json.RawMessage `json:"citations"`
	BodyWidth     json.RawMessage `json:"bodyWidth"`
}

type markdownFilterRequest struct {
	Type             json.RawMessage `json:"type"`
	Threshold        json.RawMessage `json:"threshold"`
	ThresholdType    json.RawMessage `json:"thresholdType"`
	MinWordThreshold json.RawMessage `json:"minWordThreshold"`
	UserQuery        json.RawMessage `json:"userQuery"`
	BM25Threshold    json.RawMessage `json:"bm25Threshold"`
	Language         json.RawMessage `json:"language"`
}

type strategyRequest struct {
	Type   json.RawMessage `json:"type"`
	Params json.RawMessage `json:"params"`
}

type cleanMarkdownRequest struct {
	CSSSelector           json.RawMessage `json:"cssSelector"`
	TargetElements        json.RawMessage `json:"targetElements"`
	ExcludedTags          json.RawMessage `json:"excludedTags"`
	RemoveOverlayElements json.RawMessage `json:"removeOverlayElements"`
	WordCountThreshold    json.RawMessage `json:"wordCountThreshold"`
}

type virtualScrollRequest struct {
	ContainerSelector json.RawMessage `json:"containerSelector"`
	ScrollCount       json.RawMessage `json:"scrollCount"`
	ScrollBy          json.RawMessage `json:"scrollBy"`
	ScrollByPixels    json.RawMessage `json:"scrollByPixels"`
	WaitAfterScrollMs json.RawMessage `json:"waitAfterScrollMs"`
}

type linkPreviewRequest struct {
	IncludeInternal json.RawMessage `json:"includeInternal"`
	IncludeExternal json.RawMessage `json:"includeExternal"`
	IncludeSocial   json.RawMessage `json:"includeSocial"`
	MaxLinks        json.RawMessage `json:"maxLinks"`
	Concurrency     json.RawMessage `json:"concurrency"`
	TimeoutSeconds  json.RawMessage `json:"timeoutSeconds"`
	Query           json.RawMessage `json:"query"`
	ScoreThreshold  json.RawMessage `json:"scoreThreshold"`
	Verbose         json.RawMessage `json:"verbose"`
	IncludePatterns json.RawMessage `json:"includePatterns"`
	ExcludePatterns json.RawMessage `json:"excludePatterns"`
}

type browserHeaderRequest struct {
	Name  json.RawMessage `json:"name"`
	Value json.RawMessage `json:"value"`
}

type browserCookieRequest struct {
	Name   json.RawMessage `json:"name"`
	Value  json.RawMessage `json:"value"`
	Domain json.RawMessage `json:"domain"`
	Path   json.RawMessage `json:"path"`
}

type userAgentGeneratorRequest struct {
	Platform   json.RawMessage `json:"platform"`
	Browser    json.RawMessage `json:"browser"`
	DeviceType json.RawMessage `json:"deviceType"`
	Locale     json.RawMessage `json:"locale"`
}

type geolocationRequest struct {
	Latitude  json.RawMessage `json:"latitude"`
	Longitude json.RawMessage `json:"longitude"`
	Accuracy  json.RawMessage `json:"accuracy"`
}

type detailExpansionRequest struct {
	MaxDetailUrls               json.RawMessage `json:"maxDetailUrls"`
	MinRelevanceScore           json.RawMessage `json:"minRelevanceScore"`
	RequireSameDomain           json.RawMessage `json:"requireSameDomain"`
	AllowExternalLinks          json.RawMessage `json:"allowExternalLinks"`
	ExcludeURLPatterns          json.RawMessage `json:"excludeUrlPatterns"`
	IncludeURLPatterns          json.RawMessage `json:"includeUrlPatterns"`
	MinPublishTimeConfidence    json.RawMessage `json:"minPublishTimeConfidence"`
	PreferFitMarkdownForQuality json.RawMessage `json:"preferFitMarkdownForQuality"`
}

var createTaskKeys = []string{
	"url", "displayName", "ingestToItems", "timeRangeFrom", "timeRangeTo",
	"concurrency", "keywords", "options",
}

var optionsKeys = []string{
	"includeImages", "storeMedia", "onlyMainContent", "extractLinks",
	"scanFullPage", "adjustViewportToContent", "scrollDelayMs", "headless",
	"enableUndetectedBrowser", "enableStealthMode", "antiBotMode",
	"useManagedBrowser", "userDataDir", "simulateUser", "overrideNavigator",
	"jsCode", "jsOnly", "waitForSelector", "waitForScript", "waitForTimeoutMs",
	"waitUntil", "pageTimeoutMs", "delayBeforeReturnHtmlMs", "meanDelayMs",
	"maxDelayRangeMs", "semaphoreCount", "removeForms", "additionalUrls",
	"multiUrlConfigs", "markdownOptions", "markdownFilter", "markdownStrategy",
	"tableScoreThreshold", "tableExtraction", "cleanMarkdown", "virtualScroll",
	"scoreLinks", "linkPreview", "browserHeaders", "browserCookies", "userAgent",
	"userAgentMode", "userAgentGenerator", "locale", "timezoneId", "geolocation",
	"sessionId", "storageState", "wordCountThreshold", "excludeExternalLinks",
	"excludeExternalImages", "waitForImages", "pageTypeHint", "autoExpandDetails",
	"detailExpansion", "qualityProfile", "removeOverlayElements",
	"processIframes", "textMode", "captureScreenshot", "cssSelector",
	"excludedTags",
}

var multiURLConfigKeys = []string{"name", "urls", "matcher", "options"}
var urlMatcherKeys = []string{"matchMode", "patterns"}
var strategyOverridesKeys = []string{
	"scanFullPage", "adjustViewportToContent", "scrollDelayMs",
	"onlyMainContent", "extractLinks", "simulateUser", "overrideNavigator",
	"jsCode", "jsOnly", "waitForSelector", "waitForScript", "waitForTimeoutMs",
	"waitUntil", "pageTimeoutMs", "delayBeforeReturnHtmlMs", "meanDelayMs",
	"maxDelayRangeMs", "semaphoreCount", "removeForms", "cacheMode",
	"sessionId", "storageState", "wordCountThreshold", "excludeExternalLinks",
	"removeOverlayElements", "processIframes", "textMode", "captureScreenshot",
	"cssSelector", "excludedTags", "virtualScroll", "waitForImages",
	"pageTypeHint", "autoExpandDetails", "detailExpansion", "qualityProfile",
}
var markdownOptionsKeys = []string{"contentSource", "ignoreLinks", "escapeHtml", "citations", "bodyWidth"}
var markdownFilterKeys = []string{"type", "threshold", "thresholdType", "minWordThreshold", "userQuery", "bm25Threshold", "language"}
var strategyKeys = []string{"type", "params"}
var cleanMarkdownKeys = []string{"cssSelector", "targetElements", "excludedTags", "removeOverlayElements", "wordCountThreshold"}
var virtualScrollKeys = []string{"containerSelector", "scrollCount", "scrollBy", "scrollByPixels", "waitAfterScrollMs"}
var linkPreviewKeys = []string{
	"includeInternal", "includeExternal", "includeSocial", "maxLinks",
	"concurrency", "timeoutSeconds", "query", "scoreThreshold", "verbose",
	"includePatterns", "excludePatterns",
}
var browserHeaderKeys = []string{"name", "value"}
var browserCookieKeys = []string{"name", "value", "domain", "path"}
var userAgentGeneratorKeys = []string{"platform", "browser", "deviceType", "locale"}
var geolocationKeys = []string{"latitude", "longitude", "accuracy"}
var detailExpansionKeys = []string{
	"maxDetailUrls", "minRelevanceScore", "requireSameDomain",
	"allowExternalLinks", "excludeUrlPatterns", "includeUrlPatterns",
	"minPublishTimeConfidence", "preferFitMarkdownForQuality",
}

var allowedKeySets = map[string]map[string]bool{}

func init() {
	for name, keys := range map[string][]string{
		"createTask":         createTaskKeys,
		"options":            optionsKeys,
		"multiUrlConfig":     multiURLConfigKeys,
		"urlMatcher":         urlMatcherKeys,
		"strategyOverrides":  strategyOverridesKeys,
		"markdownOptions":    markdownOptionsKeys,
		"markdownFilter":     markdownFilterKeys,
		"strategy":           strategyKeys,
		"cleanMarkdown":      cleanMarkdownKeys,
		"virtualScroll":      virtualScrollKeys,
		"linkPreview":        linkPreviewKeys,
		"browserHeader":      browserHeaderKeys,
		"browserCookie":      browserCookieKeys,
		"userAgentGenerator": userAgentGeneratorKeys,
		"geolocation":        geolocationKeys,
		"detailExpansion":    detailExpansionKeys,
	} {
		set := make(map[string]bool, len(keys))
		for _, key := range keys {
			set[key] = true
		}
		allowedKeySets[name] = set
	}
}

// Validation is the outcome of the DTO tree: the typed input and the
// class-validator message list.
type Validation struct {
	Input    CreateTaskInput
	Messages []string
}

// ValidateCreateTaskREST validates a JSON request body against
// CreateCrawlTaskDto. validator performs the IsSafeUrl DNS check.
func ValidateCreateTaskREST(ctx context.Context, body []byte, validator *URLValidator) Validation {
	v := &restValidator{ctx: ctx, urls: validator}
	var request createTaskRequest
	if !v.decodeRoot(body, &request) {
		return Validation{Messages: v.messages}
	}
	options := v.validateCreateTask(&request)
	return Validation{Input: options, Messages: v.messages}
}

// restValidator accumulates class-validator messages.
type restValidator struct {
	ctx      context.Context
	urls     *URLValidator
	messages []string
}

func (v *restValidator) add(path, constraint string) {
	v.messages = append(v.messages, path+" "+constraint)
}

// addEach renders an `each: true` constraint: the "each value in " prefix is
// inserted before the leaf property and after the parent path.
func (v *restValidator) addEach(path, constraint string) {
	index := strings.LastIndex(path, ".")
	parent := ""
	leaf := path
	if index >= 0 {
		parent = path[:index+1]
		leaf = path[index+1:]
	}
	v.messages = append(v.messages, parent+"each value in "+leaf+" "+constraint)
}

func (v *restValidator) addUnknown(parentPath, key string) {
	if parentPath == "" {
		v.messages = append(v.messages, "property "+key+" should not exist")
		return
	}
	v.messages = append(v.messages, parentPath+".property "+key+" should not exist")
}

// decodeRoot decodes the body and rejects top-level unknown keys.
func (v *restValidator) decodeRoot(body []byte, target *createTaskRequest) bool {
	if err := json.Unmarshal(body, target); err != nil {
		v.messages = append(v.messages, "Bad Request")
		return false
	}
	v.rejectUnknown(body, "createTask", "")
	return true
}

// rejectUnknown emits class-validator's whitelist message for every key that is
// not in the target DTO.
func (v *restValidator) rejectUnknown(raw json.RawMessage, schemaName, parentPath string) {
	node, ok := parseOrderedJSON(raw)
	if !ok || node.kind != kindObject {
		return
	}
	allowed := allowedKeySets[schemaName]
	for _, member := range node.object {
		if !allowed[member.key] {
			v.addUnknown(parentPath, member.key)
		}
	}
}

// ---------------------------------------------------------------------------
// leaf validators
// ---------------------------------------------------------------------------

// nullish reports @IsOptional's skip condition: absent or JSON null.
func nullish(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	return trimmed == "" || trimmed == "null"
}

func isJSONObject(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	return strings.HasPrefix(trimmed, "{")
}

func isJSONArray(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	return strings.HasPrefix(trimmed, "[")
}

// optionalString validates a string field without @IsOptional.
func (v *restValidator) optionalString(raw json.RawMessage, path string, maxLen int) *string {
	if nullish(raw) {
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

func (v *restValidator) optionalBool(raw json.RawMessage, path string) *bool {
	if nullish(raw) {
		return nil
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		v.add(path, "must be a boolean value")
		return nil
	}
	return &value
}

// optionalInt validates @Type(() => Number) @IsInt() with the optional bounds.
func (v *restValidator) optionalInt(raw json.RawMessage, path string, min, max *int) *int {
	if nullish(raw) {
		return nil
	}
	value, ok := jsToNumber(raw)
	if !ok || !isFinite(value) || value != math.Trunc(value) {
		v.add(path, "must be an integer number")
		return nil
	}
	if min != nil && value < float64(*min) {
		v.add(path, "must not be less than "+formatInt(*min))
		return nil
	}
	if max != nil && value > float64(*max) {
		v.add(path, "must not be greater than "+formatInt(*max))
		return nil
	}
	converted := int(value)
	return &converted
}

// optionalNumber validates @Type(() => Number) @IsNumber() with bounds.
func (v *restValidator) optionalNumber(raw json.RawMessage, path string, min, max *float64, customMessage string) *float64 {
	if nullish(raw) {
		return nil
	}
	value, ok := jsToNumber(raw)
	if !ok || !isFinite(value) {
		if customMessage != "" {
			// The DTO supplies the complete message; the pipe only prefixes the
			// parent path.
			v.addDynamic(path, customMessage)
		} else {
			v.add(path, "must be a number conforming to the specified constraints")
		}
		return nil
	}
	if min != nil && value < *min {
		v.add(path, "must not be less than "+formatFloat(*min))
		return nil
	}
	if max != nil && value > *max {
		v.add(path, "must not be greater than "+formatFloat(*max))
		return nil
	}
	return &value
}

// arrayItems validates @IsArray + optional @ArrayMinSize/@ArrayMaxSize and
// returns the element raws.
func (v *restValidator) arrayItems(raw json.RawMessage, path string, min, max *int) ([]json.RawMessage, bool) {
	if nullish(raw) {
		return nil, false
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		v.add(path, "must be an array")
		return nil, false
	}
	if min != nil && len(entries) < *min {
		v.add(path, "must contain at least "+formatInt(*min)+" elements")
	}
	if max != nil && len(entries) > *max {
		v.add(path, "must contain no more than "+formatInt(*max)+" elements")
	}
	return entries, true
}

// stringArray validates @IsArray + @IsString({each:true}).
func (v *restValidator) stringArray(raw json.RawMessage, path string, min, max int) []string {
	entries, ok := v.arrayItems(raw, path, optionalLimit(min), optionalLimit(max))
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
		out = append(out, value)
	}
	return out
}

// urlArray validates @IsUrl + @IsSafeUrl on every element.
func (v *restValidator) urlArray(raw json.RawMessage, path string, max int) []string {
	entries, ok := v.arrayItems(raw, path, nil, optionalLimit(max))
	if !ok {
		return nil
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		value, ok := v.validateURL(entry, path)
		if ok {
			out = append(out, value)
		}
	}
	return out
}

// validateURL runs @IsUrl then @IsSafeUrl for one element.
func (v *restValidator) validateURL(raw json.RawMessage, path string) (string, bool) {
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		v.addEach(path, "must be a URL address")
		v.addEach(path, "URL must be a string")
		return "", false
	}
	ok := true
	if !looksLikeURL(value) {
		v.addEach(path, "must be a URL address")
		ok = false
	}
	if v.urls != nil {
		if message := v.urls.Validate(v.ctx, value); message != "" {
			v.addDynamic(path, message)
			ok = false
		}
	}
	return value, ok
}

// addDynamic emits a custom-constraint message (IsSafeUrl, IsAllowedJsCode,
// CrawlVirtualScrollBy): those constraints return their text verbatim, without
// the $property or "each value in " prefix. Nested paths still receive the
// ValidationPipe's parent-path prefix.
func (v *restValidator) addDynamic(path, message string) {
	index := strings.LastIndex(path, ".")
	if index < 0 {
		v.messages = append(v.messages, message)
		return
	}
	v.messages = append(v.messages, path[:index+1]+message)
}

// looksLikeURL approximates validator.js isURL: an http(s)/ftp URL with a host
// or a protocol-relative host.
func looksLikeURL(value string) bool {
	parsed, err := parseURL(value)
	if err != nil || parsed.host == "" {
		return false
	}
	switch parsed.scheme {
	case "http", "https", "ftp":
		return true
	}
	return false
}

type parsedURL struct {
	scheme string
	host   string
	path   string
}

func parseURL(value string) (parsedURL, error) {
	// Reuse net/url through the SSRF validator's parser to keep one behaviour.
	u, err := urlParse(value)
	if err != nil {
		return parsedURL{}, err
	}
	return parsedURL{scheme: strings.ToLower(u.Scheme), host: u.Hostname(), path: u.Path}, nil
}

func optionalLimit(value int) *int {
	if value <= 0 {
		return nil
	}
	return &value
}
