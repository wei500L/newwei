package crawlfrontiernode

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
	"github.com/wei500L/newwei/apps/api-go/internal/crawloptions"
)

// This file ports the layered crawl-option builders of CrawlFrontierService
// (apps/api/src/modules/crawl/crawl-frontier.service.ts, main 170a95d8):
//
//	buildLayeredCrawlOptions       1949-2078
//	buildAutoMarkdownFilter        2080-2104
//	resolveMarkdownFilterLanguage  2106-2132
//	buildBrowserHeaders            2134-2165
//	buildUserAgentGenerator        2167-2193
//	buildAutoLinkPreviewConfig     2195-2243
//	buildDomPruneJsCode            2245-2261
//	resolveNativeCrawlComponents   2263-2329
//	resolveNativeStrategyType      2331-2365
//	buildNativeFilterChain         2367-2447
//	buildNativeUrlScorer           2449-2476
//
// Everything here is a pure function: the caller owns the request lifecycle,
// the crawl4ai client and the result service. The helpers the Nest functions
// call are reused, not re-ported:
//
//	mergeMetadataRecords -> crawlfrontierllm.MergeObjectsAll
//	uniqueStringList     -> crawlfrontierllm.UniqueStringList
//	clampInt             -> crawlfrontierllm.ClampInt
//	coerceStringArray    -> crawlfrontierllm.Object.Strings / ObjectStrings
//	Number(x.toFixed(n)) -> crawlfrontierllm.RoundToFixed
//	isPlainObject        -> crawlfrontierllm.Object.Object / ParseObject
//	toRegistrableDomain  -> frontierRegistrableDomain (discover.go)
//	resolveLocaleScopeLanguage -> frontierPreferredLanguage (discover.go)
//	new URL(...)         -> frontierParseAbsoluteURL (discover.go)
//	crawlOptions normalizer -> crawl4ai.NormalizeOptions (request) and
//	crawloptions.NormalizeOptions (persistResults)
//
// JSON member order is part of the contract: the crawl4ai request body is
// compared byte for byte, so every object below is built through the ordered
// crawlfrontierllm.Object instead of a map. A member whose JS value would be
// `undefined` is removed from the object, because JSON.stringify drops it while
// the property itself still shadows the crawlOptions/pageRules value it came
// from.

// layeredCrawlOptions is CrawlTaskOptions for one node: the crawl4ai request
// options plus the normalized options persistResults reads.
type layeredCrawlOptions struct {
	// Request is the input of crawl4ai.CrawlRequest.Options for the node URL.
	Request crawl4ai.CrawlOptions
	// Persist is the normalized CrawlTaskOptions document
	// CrawlResultService.persistResults receives (crawl-result.service.ts:181).
	Persist crawloptions.Options
	// Config is the ordered raw CrawlTaskOptions object Nest passes around as
	// `crawlOptions`: every member the layering produced, including the
	// crawlOptions/pageRules members this file does not re-derive.
	Config *crawlfrontierllm.Object

	// The members below are the resolved diagnostics view of
	// buildCrawlOptionsDiagnostics (2887-2977). Only those seven values are read
	// there, and NestJS tests them for truthiness, so they are pre-extracted: a
	// nil pointer or an empty string is the `undefined`/falsy case.
	LinkPreview     *layeredLinkPreview
	CSSSelector     string
	WaitForSelector string
	WaitForScript   string
	MarkdownFilter  *layeredMarkdownFilter
	// Locale is the exact member value. NestJS tests `crawlOptions.locale`
	// itself, so a whitespace-only fallback locale is truthy there and is a
	// non-empty string here; do not trim it before the truthiness test.
	Locale         string
	BrowserHeaders []crawloptions.BrowserHeader
}

// layeredLinkPreview is the linkPreview member buildCrawlOptionsDiagnostics
// reads (`crawlOptions.linkPreview?.query`). Nil means the member is undefined.
type layeredLinkPreview struct {
	// Query is the trimmed query; the empty string covers "no query", which
	// NestJS reports as null.
	Query string
}

// layeredMarkdownFilter is the markdownFilter member
// buildCrawlOptionsDiagnostics reads (`crawlOptions.markdownFilter?.type`).
type layeredMarkdownFilter struct {
	// Type is the trimmed filter type; the empty string covers "no type".
	Type string
}

// crawlDeepCrawlComponent is CrawlDeepCrawlComponent: a crawl4ai deep-crawl
// component (strategy, filter or scorer) with its ordered params object.
type crawlDeepCrawlComponent struct {
	Type string `json:"type"`
	// Params is nil when the profile omitted it, which is the JS `undefined`
	// member JSON.stringify drops (`params?: Record<string, unknown>`).
	Params *crawlfrontierllm.Object `json:"params,omitempty"`
}

// nativeCrawlComponents is resolveNativeCrawlComponents' result object
// (2266-2275). Nil pointers are the JS `undefined` members JSON.stringify
// drops; the three booleans are always present.
type nativeCrawlComponents struct {
	DeepCrawlStrategy      *crawlDeepCrawlComponent `json:"deepCrawlStrategy,omitempty"`
	FilterChain            *crawlDeepCrawlComponent `json:"filterChain,omitempty"`
	URLScorer              *crawlDeepCrawlComponent `json:"urlScorer,omitempty"`
	AdaptiveCrawling       *crawlDeepCrawlComponent `json:"adaptiveCrawling,omitempty"`
	StrategyResolvedFrom   *string                  `json:"strategyResolvedFrom,omitempty"`
	StrategyAutoResolved   bool                     `json:"strategyAutoResolved"`
	FilterChainSynthesized bool                     `json:"filterChainSynthesized"`
	URLScorerSynthesized   bool                     `json:"urlScorerSynthesized"`
}

// nativeStrategyResolution is resolveNativeStrategyType's result object
// (2334-2338). ResolvedType is always present; StrategyResolvedFrom is nil for
// an explicitly configured strategy type.
type nativeStrategyResolution struct {
	ResolvedType         string
	StrategyResolvedFrom *string
	StrategyAutoResolved bool
}

// crawlKeywordSources is the keyword surface buildAutoMarkdownFilter,
// buildAutoLinkPreviewConfig and buildNativeUrlScorer merge. Each list is
// already trimmed and empty-free, exactly like coerceStringArray.
type crawlKeywordSources struct {
	Priority []string
	Keywords []string
	Category []string
	List     []string
	Article  []string
}

// buildLayeredCrawlOptions ports buildLayeredCrawlOptions (1949-2078): the
// CrawlTaskOptions of one Frontier node, layering the profile crawlOptions, the
// page-type pageRules entry and the Frontier-derived defaults.
func buildLayeredCrawlOptions(config *crawlfrontierllm.Object, pageType string) (layeredCrawlOptions, error) {
	base := layeredObject(config, "crawlOptions")
	pageRule := layeredObject(layeredObject(config, "pageRules"), pageType)
	localeScope := layeredObject(config, "localeScope")

	// `{...(isPlainObject(base.cleanMarkdown) ? base.cleanMarkdown : {}),
	//   ...(isPlainObject(pageRule.cleanMarkdown) ? pageRule.cleanMarkdown : {})}`
	cleanMarkdown := crawlfrontierllm.MergeObjectsAll(
		layeredObject(base, "cleanMarkdown"),
		layeredObject(pageRule, "cleanMarkdown"),
	)

	fallbackWordCount := 30
	switch pageType {
	case "article":
		fallbackWordCount = 140
	case "list":
		fallbackWordCount = 60
	}
	shouldApplyFrontierDomScoping := pageType == "category" || pageType == "list"

	explicitCSSSelector := layeredExplicitString(pageRule, "cssSelector")
	if explicitCSSSelector == nil {
		explicitCSSSelector = layeredExplicitString(base, "cssSelector")
	}

	var defaultDomScopeSelector *string
	var generatedDomPruneScript *string
	if shouldApplyFrontierDomScoping {
		if scopes := crawlfrontierllm.UniqueStringList(crawlfrontierllm.ObjectStrings(config, "domLinkScopes")); len(scopes) > 0 {
			joined := strings.Join(scopes, ", ")
			defaultDomScopeSelector = &joined
		}
		generatedDomPruneScript = buildDomPruneJsCode(crawlfrontierllm.ObjectStrings(config, "domLinkExcludeSelectors"))
	}

	explicitWaitForSelector := layeredExplicitString(pageRule, "waitForSelector")
	if explicitWaitForSelector == nil {
		explicitWaitForSelector = layeredExplicitString(base, "waitForSelector")
	}
	explicitWaitForScript := layeredExplicitString(pageRule, "waitForScript")
	if explicitWaitForScript == nil {
		explicitWaitForScript = layeredExplicitString(base, "waitForScript")
	}

	explicitLinkPreview := layeredObject(pageRule, "linkPreview")
	if explicitLinkPreview == nil {
		explicitLinkPreview = layeredObject(base, "linkPreview")
	}
	explicitMarkdownFilter := layeredObject(pageRule, "markdownFilter")
	if explicitMarkdownFilter == nil {
		explicitMarkdownFilter = layeredObject(base, "markdownFilter")
	}
	explicitLocale := layeredExplicitString(pageRule, "locale")
	if explicitLocale == nil {
		explicitLocale = layeredExplicitString(base, "locale")
	}

	// `explicitLinkPreview || pageType === "article"
	//    ? undefined
	//    : this.buildAutoLinkPreviewConfig(config, pageType)`
	var autoLinkPreview *crawlfrontierllm.Object
	if explicitLinkPreview == nil && pageType != "article" {
		autoLinkPreview = buildAutoLinkPreviewConfig(config, pageType)
	}
	linkPreview := explicitLinkPreview
	if linkPreview == nil {
		linkPreview = autoLinkPreview
	}

	// `explicitMarkdownFilter ?? this.buildAutoMarkdownFilter(config, pageType)`
	// — `??` short-circuits, so the auto filter is only built when the profile
	// did not provide one.
	markdownFilter := explicitMarkdownFilter
	if markdownFilter == nil {
		markdownFilter = buildAutoMarkdownFilter(config, pageType)
	}

	// uniqueStringList(coerceStringArray(base.jsCode),
	//   coerceStringArray(pageRule.jsCode),
	//   generatedDomPruneScript ? [generatedDomPruneScript] : undefined)
	baseJSCode := crawlfrontierllm.ObjectStrings(base, "jsCode")
	pageRuleJSCode := crawlfrontierllm.ObjectStrings(pageRule, "jsCode")
	var pruneScripts []string
	if generatedDomPruneScript != nil {
		pruneScripts = []string{*generatedDomPruneScript}
	}
	jsCode := crawlfrontierllm.UniqueStringList(baseJSCode, pageRuleJSCode, pruneScripts)

	browserHeaders := buildBrowserHeaders(config, base, pageRule)

	// `explicitLocale ?? config.localeScope?.locale` — the fallback is the raw
	// member, untrimmed and possibly empty, so a present empty string stays.
	locale := explicitLocale
	if locale == nil {
		if value, ok := localeScope.UntrimmedString("locale"); ok {
			locale = &value
		}
	}

	userAgentGenerator := buildUserAgentGenerator(config, base, pageRule)

	// `this.clampInt(pageRule.wordCountThreshold ?? base.wordCountThreshold,
	//   0, 5000, fallbackWordCount)`
	wordCountThreshold := fallbackWordCount
	if raw, ok := layeredMember(pageRule, "wordCountThreshold"); ok {
		wordCountThreshold = crawlfrontierllm.ClampInt(raw, 0, 5000, fallbackWordCount)
	} else if raw, ok := layeredMember(base, "wordCountThreshold"); ok {
		wordCountThreshold = crawlfrontierllm.ClampInt(raw, 0, 5000, fallbackWordCount)
	}

	// `{...base, ...pageRule, <the literal keys below>}`. The merge keeps the
	// base member positions and appends the pageRule-only members in their own
	// order; assigning a member that already exists keeps its position, which
	// Ordered Object.Set does.
	options := crawlfrontierllm.MergeObjectsAll(base, pageRule)
	if options == nil {
		options = crawlfrontierllm.NewObject()
	}
	options.SetString("cacheMode", "bypass")
	options.SetBool("extractLinks", pageType != "article")
	options.SetBool("scoreLinks", pageType != "article")
	layeredPutObject(options, "linkPreview", linkPreview)
	options.SetBool("excludeExternalLinks", true)
	options.SetBool("onlyMainContent", pageType == "article")
	pageTypeHint := "list"
	if pageType == "article" {
		pageTypeHint = "detail"
	}
	options.SetString("pageTypeHint", pageTypeHint)
	options.SetBool("autoExpandDetails", false)

	cssSelector := explicitCSSSelector
	if cssSelector == nil {
		cssSelector = defaultDomScopeSelector
	}
	layeredPutString(options, "cssSelector", cssSelector)

	// `explicitWaitForScript || explicitWaitForSelector
	//    ? explicitWaitForSelector
	//    : defaultDomScopeSelector`
	// — a page rule that only sets waitForScript leaves waitForSelector
	// undefined, which also clears a waitForSelector inherited from base.
	waitForSelector := defaultDomScopeSelector
	if explicitWaitForScript != nil || explicitWaitForSelector != nil {
		waitForSelector = explicitWaitForSelector
	}
	layeredPutString(options, "waitForSelector", waitForSelector)
	layeredPutString(options, "waitForScript", explicitWaitForScript)
	layeredPutStrings(options, "jsCode", jsCode)
	layeredPutObject(options, "markdownFilter", markdownFilter)
	layeredPutHeaders(options, "browserHeaders", browserHeaders)
	layeredPutString(options, "locale", locale)
	layeredPutGenerator(options, "userAgentGenerator", userAgentGenerator)
	options.SetNumber("wordCountThreshold", float64(wordCountThreshold))
	layeredPutObject(options, "cleanMarkdown", cleanMarkdown)
	options.Delete("additionalUrls")
	options.Delete("multiUrlConfigs")
	options.Delete("proxyUrl")
	options.Delete("proxyConfig")

	raw, err := options.MarshalJSON()
	if err != nil {
		return layeredCrawlOptions{}, fmt.Errorf("crawlfrontiernode: encode layered crawl options: %w", err)
	}
	var persistInput crawloptions.OptionsInput
	if err := json.Unmarshal(raw, &persistInput); err != nil {
		// pageRules accepts a free-form record, so a stored profile can carry a
		// leaf the typed CrawlTaskOptions projection cannot hold (for example
		// linkPreview.timeoutSeconds: 2.5). encoding/json decodes every other
		// member and only reports the offending leaf, and NestJS — being
		// dynamically typed — just reads it. A node must not fail on such an
		// optional override, so a type error keeps the decoded members; only a
		// structural failure aborts.
		var typeError *json.UnmarshalTypeError
		if !errors.As(err, &typeError) {
			return layeredCrawlOptions{}, fmt.Errorf("crawlfrontiernode: decode layered crawl options: %w", err)
		}
	}

	var linkPreviewView *layeredLinkPreview
	if linkPreview != nil {
		query, _ := linkPreview.String("query")
		linkPreviewView = &layeredLinkPreview{Query: query}
	}
	var markdownFilterView *layeredMarkdownFilter
	if markdownFilter != nil {
		filterType, _ := markdownFilter.String("type")
		markdownFilterView = &layeredMarkdownFilter{Type: filterType}
	}

	return layeredCrawlOptions{
		Request:         crawl4ai.NormalizeOptions(raw),
		Persist:         crawloptions.NormalizeOptions(&persistInput),
		Config:          options,
		LinkPreview:     linkPreviewView,
		CSSSelector:     derefString(cssSelector),
		WaitForSelector: derefString(waitForSelector),
		WaitForScript:   derefString(explicitWaitForScript),
		MarkdownFilter:  markdownFilterView,
		Locale:          derefString(locale),
		BrowserHeaders:  browserHeaders,
	}, nil
}

// buildAutoMarkdownFilter ports buildAutoMarkdownFilter (2080-2104): the
// bm25 markdown filter synthesized from the profile keyword surface.
func buildAutoMarkdownFilter(config *crawlfrontierllm.Object, pageType string) *crawlfrontierllm.Object {
	if pageType == "article" {
		return nil
	}
	sources := crawlKeywordSourcesOf(config)
	queryKeywords := layeredHead(crawlfrontierllm.UniqueStringList(
		sources.Priority,
		sources.Keywords,
		sources.Category,
		sources.List,
		sources.Article,
	), 10)
	if len(queryKeywords) == 0 {
		return nil
	}
	filter := crawlfrontierllm.NewObject()
	filter.SetString("type", "bm25")
	filter.SetString("userQuery", strings.Join(queryKeywords, " "))
	filter.SetNumber("bm25Threshold", 0.9)
	if language := resolveMarkdownFilterLanguage(config); language != nil {
		filter.SetString("language", *language)
	}
	return filter
}

// markdownFilterLanguages is the language mapping of
// resolveMarkdownFilterLanguage (2113-2130).
var markdownFilterLanguages = map[string]string{
	"en": "english",
	"zh": "chinese",
	"es": "spanish",
	"fr": "french",
	"de": "german",
	"pt": "portuguese",
	"ar": "arabic",
	"ru": "russian",
	"hi": "hindi",
	"ja": "japanese",
	"ko": "korean",
	"tr": "turkish",
	"it": "italian",
	"nl": "dutch",
	"id": "indonesian",
	"vi": "vietnamese",
}

// resolveMarkdownFilterLanguage ports resolveMarkdownFilterLanguage
// (2106-2132): the base language code of the profile locale scope, mapped to
// the crawl4ai markdown filter language name.
func resolveMarkdownFilterLanguage(config *crawlfrontierllm.Object) *string {
	language := frontierPreferredLanguage(config)
	if language == "" {
		return nil
	}
	mapped, ok := markdownFilterLanguages[language]
	if !ok {
		return nil
	}
	return &mapped
}

// buildBrowserHeaders ports buildBrowserHeaders (2134-2165): the explicit
// browserHeaders of crawlOptions and the page rule, plus the Accept-Language
// header derived from localeScope.acceptLanguages.
func buildBrowserHeaders(
	config *crawlfrontierllm.Object,
	base *crawlfrontierllm.Object,
	pageRule *crawlfrontierllm.Object,
) []crawloptions.BrowserHeader {
	explicitHeaders := layeredMergeBrowserHeaders(
		layeredBrowserHeaders(base, "browserHeaders"),
		layeredBrowserHeaders(pageRule, "browserHeaders"),
	)
	acceptLanguages := crawlfrontierllm.UniqueStringList(
		crawlfrontierllm.ObjectStrings(layeredObject(config, "localeScope"), "acceptLanguages"),
	)
	if len(acceptLanguages) == 0 {
		return explicitHeaders
	}
	// `explicitHeaders?.some(header =>
	//    normalizeHeaderName(header.name) === "accept-language")`
	for _, header := range explicitHeaders {
		if layeredNormalizeHeaderName(header.Name) == "accept-language" {
			return explicitHeaders
		}
	}
	return layeredMergeBrowserHeaders(explicitHeaders, []crawloptions.BrowserHeader{{
		Name:  "Accept-Language",
		Value: strings.Join(acceptLanguages, ","),
	}})
}

// buildUserAgentGenerator ports buildUserAgentGenerator (2167-2193): the page
// rule generator over the crawlOptions generator, plus the locale scope locale
// when neither set one.
//
// Two representation notes: the merged record is projected onto
// crawloptions.UserAgentGenerator (the typed CrawlUserAgentGeneratorConfig the
// persistResults document holds), so a non-string leaf is dropped, a string
// leaf is trimmed, an unknown key is dropped (a record whose known members are
// therefore all absent becomes undefined, although Nest would return the
// unknown-key record), and the members serialize in that struct's declared
// order instead of the caller's key order. None of that reaches the request:
// the Go CrawlOptions has no user agent generator field, and crawl4ai normalizes
// the generator to the same four keys anyway.
func buildUserAgentGenerator(
	config *crawlfrontierllm.Object,
	base *crawlfrontierllm.Object,
	pageRule *crawlfrontierllm.Object,
) *crawloptions.UserAgentGenerator {
	merged := crawlfrontierllm.MergeObjectsAll(
		layeredObject(base, "userAgentGenerator"),
		layeredObject(pageRule, "userAgentGenerator"),
	)
	// `config.localeScope?.locale?.trim()` — an absent or blank locale is
	// undefined here, unlike the untrimmed `locale` member of the options.
	locale, _ := layeredObject(config, "localeScope").String("locale")
	mergedHasLocale := false
	if merged != nil {
		if value, ok := merged.String("locale"); ok && value != "" {
			mergedHasLocale = true
		}
	}
	if locale == "" || mergedHasLocale {
		if merged == nil || merged.Len() == 0 {
			return nil
		}
		return layeredUserAgentGenerator(merged)
	}
	withLocale := merged
	if withLocale == nil {
		withLocale = crawlfrontierllm.NewObject()
	}
	withLocale.SetString("locale", locale)
	return layeredUserAgentGenerator(withLocale)
}

// buildAutoLinkPreviewConfig ports buildAutoLinkPreviewConfig (2195-2243): the
// link preview crawl4ai runs over a list-typed node.
func buildAutoLinkPreviewConfig(config *crawlfrontierllm.Object, pageType string) *crawlfrontierllm.Object {
	if pageType == "article" {
		return nil
	}
	sources := crawlKeywordSourcesOf(config)
	includePatterns := crawlfrontierllm.UniqueStringList(
		frontierURLPatterns(config, "category"),
		frontierURLPatterns(config, "list"),
		frontierURLPatterns(config, "article"),
	)
	excludePatterns := crawlfrontierllm.UniqueStringList(
		frontierURLPatterns(config, "exclude"),
		crawlfrontierllm.ObjectStrings(frontierPageTypeSignal(config, "deny"), "patterns"),
		crawlfrontierllm.ObjectStrings(layeredObject(config, "localeScope"), "denyUrlPatterns"),
	)
	queryKeywords := layeredHead(crawlfrontierllm.UniqueStringList(
		sources.Priority,
		sources.Keywords,
		sources.Category,
		sources.List,
		sources.Article,
	), 8)
	query := strings.Join(queryKeywords, " ")
	if len(includePatterns) == 0 && len(excludePatterns) == 0 && query == "" {
		return nil
	}

	maxLinks := 32
	switch pageType {
	case "home":
		maxLinks = 72
	case "category":
		maxLinks = 48
	}
	concurrency := 4
	if pageType == "home" {
		concurrency = 6
	}
	// `Number(Math.max(0.05, Math.min(0.4,
	//    (config.layeredOptions?.scoreThreshold ?? 0.35) - 0.1)).toFixed(3))`
	scoreThreshold := crawlfrontierllm.RoundToFixed(
		math.Max(0.05, math.Min(0.4, layeredOptionNumber(config, "scoreThreshold", 0.35)-0.1)),
		3,
	)

	preview := crawlfrontierllm.NewObject()
	preview.SetBool("includeInternal", true)
	preview.SetBool("includeExternal", false)
	preview.SetNumber("maxLinks", float64(maxLinks))
	preview.SetNumber("concurrency", float64(concurrency))
	preview.SetNumber("timeoutSeconds", 5)
	if query != "" {
		preview.SetString("query", query)
	}
	preview.SetNumber("scoreThreshold", scoreThreshold)
	layeredPutStrings(preview, "includePatterns", includePatterns)
	layeredPutStrings(preview, "excludePatterns", excludePatterns)
	return preview
}

// buildDomPruneJsCode ports buildDomPruneJsCode (2245-2261): the js code that
// removes the configured excluded selectors from the DOM before extraction.
func buildDomPruneJsCode(selectors []string) *string {
	normalized := crawlfrontierllm.UniqueStringList(selectors)
	if len(normalized) == 0 {
		return nil
	}
	encodedSelectors, err := layeredStringListJSON(normalized)
	if err != nil {
		return nil
	}
	script := "(() => {\n" +
		"  const selectors = " + encodedSelectors + ";\n" +
		"  for (const selector of selectors) {\n" +
		"    try {\n" +
		"      document.querySelectorAll(selector).forEach((node) => node.remove());\n" +
		"    } catch (error) {\n" +
		"      console.warn(\"crawl-frontier-dom-prune\", selector, error);\n" +
		"    }\n" +
		"  }\n" +
		"})();"
	return &script
}

// resolveNativeCrawlComponents ports resolveNativeCrawlComponents (2263-2329):
// the crawl4ai deep-crawl components of a native execution, with the strategy
// params completed from the layered options.
//
// The Nest code assumes a normalized profile config, so the four configured
// components are plain objects or absent and `strategy.type` is a string; a
// malformed component is treated as absent (or as an empty type) instead of
// throwing like `strategy.type.trim()` would.
func resolveNativeCrawlComponents(config *crawlfrontierllm.Object, nodeURL string) nativeCrawlComponents {
	nativeOptions := layeredObject(config, "nativeOptions")
	baseStrategy := crawlDeepCrawlComponentOf(nativeOptions, "deepCrawlStrategy")
	if baseStrategy == nil {
		return nativeCrawlComponents{}
	}
	resolution := resolveNativeStrategyType(baseStrategy, config)

	configuredFilterChain := crawlDeepCrawlComponentOf(nativeOptions, "filterChain")
	configuredURLScorer := crawlDeepCrawlComponentOf(nativeOptions, "urlScorer")
	adaptiveCrawling := crawlDeepCrawlComponentOf(nativeOptions, "adaptiveCrawling")

	var synthesizedFilterChain *crawlDeepCrawlComponent
	if configuredFilterChain == nil {
		synthesizedFilterChain = buildNativeFilterChain(config, nodeURL)
	}
	var synthesizedURLScorer *crawlDeepCrawlComponent
	if configuredURLScorer == nil {
		synthesizedURLScorer = buildNativeUrlScorer(config)
	}
	filterChain := configuredFilterChain
	if filterChain == nil {
		filterChain = synthesizedFilterChain
	}
	urlScorer := configuredURLScorer
	if urlScorer == nil {
		urlScorer = synthesizedURLScorer
	}

	// `const params = isPlainObject(baseStrategy.params)
	//    ? { ...baseStrategy.params } : {}`
	params := baseStrategy.Params
	if params == nil {
		params = crawlfrontierllm.NewObject()
	} else {
		params = params.Clone()
	}
	if !params.Has("max_depth") {
		params.SetNumber("max_depth", layeredOptionNumber(config, "maxDepth", 3))
	}
	if !params.Has("max_pages") {
		params.SetNumber("max_pages", layeredOptionNumber(config, "maxPages", 60))
	}
	if filterChain != nil && !params.Has("filter_chain") {
		params.Set("filter_chain", filterChain)
	}
	if urlScorer != nil && !params.Has("url_scorer") {
		params.Set("url_scorer", urlScorer)
	}
	if adaptiveCrawling != nil && !params.Has("adaptive_crawling") {
		params.Set("adaptive_crawling", adaptiveCrawling)
	}

	return nativeCrawlComponents{
		DeepCrawlStrategy: &crawlDeepCrawlComponent{
			Type:   resolution.ResolvedType,
			Params: params,
		},
		FilterChain:            filterChain,
		URLScorer:              urlScorer,
		AdaptiveCrawling:       adaptiveCrawling,
		StrategyResolvedFrom:   resolution.StrategyResolvedFrom,
		StrategyAutoResolved:   resolution.StrategyAutoResolved,
		FilterChainSynthesized: filterChain != nil && configuredFilterChain == nil,
		URLScorerSynthesized:   urlScorer != nil && configuredURLScorer == nil,
	}
}

// resolveNativeStrategyType ports resolveNativeStrategyType (2331-2365): "auto"
// and "AutoDeepCrawlStrategy" resolve to a concrete strategy from the profile
// signals; every other type is used verbatim.
func resolveNativeStrategyType(strategy *crawlDeepCrawlComponent, config *crawlfrontierllm.Object) nativeStrategyResolution {
	rawType := strings.TrimSpace(strategy.Type)
	normalizedType := strings.ToLower(rawType)
	if normalizedType != "auto" && normalizedType != "autodeepcrawlstrategy" {
		return nativeStrategyResolution{ResolvedType: rawType}
	}
	urlPatterns := layeredObject(config, "urlPatterns")
	articleSignal := frontierPageTypeSignal(config, "article")
	// `Boolean(config.urlPatterns?.article?.length ||
	//    config.pageTypeSignals?.article?.patterns?.length ||
	//    config.pageTypeSignals?.article?.keywords?.length)`
	hasArticleSignals := layeredArrayLength(urlPatterns, "article") > 0 ||
		layeredArrayLength(articleSignal, "patterns") > 0 ||
		layeredArrayLength(articleSignal, "keywords") > 0
	// `(config.priorityKeywords?.length ?? 0) >= 4 || Boolean(config.freshnessRules)
	//    || (config.layeredOptions?.scoreThreshold ?? 0.35) >= 0.45
	//    || (config.nativeOptions?.minArticleResults ?? 0) > 0`
	freshnessSensitive := layeredArrayLength(config, "priorityKeywords") >= 4 ||
		layeredObject(config, "freshnessRules") != nil ||
		layeredOptionNumber(config, "scoreThreshold", 0.35) >= 0.45 ||
		nativeOptionNumber(config, "minArticleResults", 0) > 0
	resolvedType := "BFSDeepCrawlStrategy"
	if freshnessSensitive && hasArticleSignals {
		resolvedType = "BestFirstCrawlingStrategy"
	}
	resolvedFrom := rawType
	return nativeStrategyResolution{
		ResolvedType:         resolvedType,
		StrategyResolvedFrom: &resolvedFrom,
		StrategyAutoResolved: true,
	}
}

// buildNativeFilterChain ports buildNativeFilterChain (2367-2447): the
// FilterChain crawl4ai applies to a native crawl. The chain always ends with a
// ContentTypeFilter, so the `filters.length > 0` guard can never make it
// undefined and the function always returns a component.
func buildNativeFilterChain(config *crawlfrontierllm.Object, rootURL string) *crawlDeepCrawlComponent {
	allowedDomains := crawlfrontierllm.UniqueStringList(crawlfrontierllm.ObjectStrings(config, "allowedDomains"))
	blockedDomains := crawlfrontierllm.UniqueStringList(crawlfrontierllm.ObjectStrings(config, "blockedDomains"))

	// `config.allowedHosts?.map(host => {
	//    const normalized = host.trim();
	//    return normalized.length > 0 ? `https://${normalized}/*` : "";
	//  })` — the empty entries are dropped by uniqueStringList, not by the map.
	allowedHosts := crawlfrontierllm.ObjectStrings(config, "allowedHosts")
	hostPatterns := make([]string, 0, len(allowedHosts))
	for _, host := range allowedHosts {
		trimmed := crawlfrontierllm.JsTrim(host)
		if trimmed == "" {
			hostPatterns = append(hostPatterns, "")
			continue
		}
		hostPatterns = append(hostPatterns, "https://"+trimmed+"/*")
	}
	allowedHostPatterns := crawlfrontierllm.UniqueStringList(hostPatterns)

	filters := make([]*crawlDeepCrawlComponent, 0, 4)
	// `config.hostScope` is read directly here, not through
	// resolveFrontierHostScope: NestJS compares the stored value, so an explicit
	// "registrable_domain" can still add the strict-host URLPatternFilter
	// through the allowedHosts branch below.
	hostScope, _ := config.String("hostScope")
	if parsedRoot, ok := frontierParseAbsoluteURL(rootURL); ok {
		baseHostPattern := strings.ToLower(parsedRoot.Scheme) + "://" + strings.ToLower(parsedRoot.Hostname()) + "/*"
		if hostScope == "strict_hosts" ||
			(layeredArrayLength(config, "allowedHosts") > 0 && layeredArrayLength(config, "allowedDomains") == 0) {
			filters = append(filters, &crawlDeepCrawlComponent{
				Type: "URLPatternFilter",
				Params: crawlfrontierllm.NewObjectFromPairs(
					"patterns",
					crawlfrontierllm.UniqueStringList(allowedHostPatterns, []string{baseHostPattern}),
				),
			})
		}
		if len(allowedDomains) == 0 && hostScope != "strict_hosts" {
			if registrable := frontierRegistrableDomain(parsedRoot.Hostname()); registrable != "" {
				filters = append(filters, &crawlDeepCrawlComponent{
					Type:   "DomainFilter",
					Params: layeredDomainFilterParams([]string{registrable}, blockedDomains),
				})
			}
		}
	}
	if len(allowedDomains) > 0 || len(blockedDomains) > 0 {
		filters = append(filters, &crawlDeepCrawlComponent{
			Type:   "DomainFilter",
			Params: layeredDomainFilterParams(allowedDomains, blockedDomains),
		})
	}
	filters = append(filters, &crawlDeepCrawlComponent{
		Type:   "ContentTypeFilter",
		Params: crawlfrontierllm.NewObjectFromPairs("allowed_types", []string{"text/html"}),
	})
	includePatterns := crawlfrontierllm.UniqueStringList(
		frontierURLPatterns(config, "home"),
		frontierURLPatterns(config, "category"),
		frontierURLPatterns(config, "list"),
		frontierURLPatterns(config, "article"),
	)
	if len(includePatterns) > 0 {
		filters = append(filters, &crawlDeepCrawlComponent{
			Type:   "URLPatternFilter",
			Params: crawlfrontierllm.NewObjectFromPairs("patterns", includePatterns),
		})
	}
	return &crawlDeepCrawlComponent{
		Type:   "FilterChain",
		Params: crawlfrontierllm.NewObjectFromPairs("filters", filters),
	}
}

// buildNativeUrlScorer ports buildNativeUrlScorer (2449-2476): the keyword
// relevance scorer of a native crawl.
func buildNativeUrlScorer(config *crawlfrontierllm.Object) *crawlDeepCrawlComponent {
	sources := crawlKeywordSourcesOf(config)
	// Note the keyword order differs from the auto markdown filter: the article
	// signals come first here.
	keywords := layeredHead(crawlfrontierllm.UniqueStringList(
		sources.Priority,
		sources.Keywords,
		sources.Article,
		sources.List,
		sources.Category,
	), 32)
	if len(keywords) == 0 {
		return nil
	}
	sourceTier, _ := config.String("sourceTier")
	priorityKeywordCount := layeredArrayLength(config, "priorityKeywords")
	weight := 1.0
	switch {
	case sourceTier == "tier1":
		weight = 1.25
	case priorityKeywordCount >= 5:
		weight = 1.15
	}
	return &crawlDeepCrawlComponent{
		Type: "KeywordRelevanceScorer",
		Params: crawlfrontierllm.NewObjectFromPairs(
			"keywords", keywords,
			// `Number(weight.toFixed(2))`
			"weight", crawlfrontierllm.RoundToFixed(weight, 2),
		),
	}
}

// nativeDeepCrawlComponent is buildDeepCrawlStrategyPayload
// (crawl4ai.client.ts:1179-1205) for the resolved components: the crawl4ai
// request carries one deep_crawl_strategy component whose params already embed
// the filter chain, the URL scorer and the adaptive config (the strategy the
// payload builder reads is options.deepCrawlStrategy, whose params
// resolveNativeCrawlComponents already completed). The caller assigns it to
// crawl4ai.CrawlOptions.DeepCrawlStrategy for a native root execution.
func nativeDeepCrawlComponent(components nativeCrawlComponents) *crawl4ai.Component {
	strategy := components.DeepCrawlStrategy
	if strategy == nil {
		return nil
	}
	component := &crawl4ai.Component{Type: strategy.Type}
	if strategy.Params != nil {
		if encoded, err := strategy.Params.MarshalJSON(); err == nil {
			component.Params = encoded
		}
	}
	return component
}

// ---------------------------------------------------------------------------
// config reads

// layeredObject is isPlainObject(value[key]): the nested object, or nil when
// the member is absent or not a plain object. The nil object is safe: every
// crawlfrontierllm.Object read handles a nil receiver.
func layeredObject(object *crawlfrontierllm.Object, key string) *crawlfrontierllm.Object {
	value, ok := object.Object(key)
	if !ok {
		return nil
	}
	return value
}

// layeredExplicitString is the
// `typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined`
// guard every page-rule override uses.
func layeredExplicitString(object *crawlfrontierllm.Object, key string) *string {
	value, ok := object.String(key)
	if !ok {
		return nil
	}
	return &value
}

// layeredMember reads a raw member with `??` semantics: a missing key and an
// explicit JSON null are both absent.
func layeredMember(object *crawlfrontierllm.Object, key string) (json.RawMessage, bool) {
	raw, ok := object.Raw(key)
	if !ok || layeredIsJSONNull(raw) {
		return nil, false
	}
	return raw, true
}

// layeredNumberMember reads a numeric member with `??` and Number() semantics.
// A non-number leaf is coerced with Number() instead of being passed through
// like NestJS would (`params.max_depth = config.layeredOptions?.maxDepth ?? 3`
// copies the raw value); normalizeCrawlSiteProfileConfig guarantees numbers for
// the layeredOptions/nativeOptions blocks, so this only differs for a profile
// stored without normalization.
func layeredNumberMember(object *crawlfrontierllm.Object, key string) (float64, bool) {
	if _, ok := layeredMember(object, key); !ok {
		return 0, false
	}
	return object.Number(key)
}

// layeredIsJSONNull reports whether raw is the JSON null literal.
func layeredIsJSONNull(raw json.RawMessage) bool {
	return string(bytes.TrimSpace(raw)) == "null"
}

// layeredArrayLength is `value?.length ?? 0` for a JSON array member. It counts
// the raw entries, so duplicates and empty strings count, which is what the
// priorityKeywords length thresholds depend on.
func layeredArrayLength(object *crawlfrontierllm.Object, key string) int {
	raw, ok := object.Raw(key)
	if !ok {
		return 0
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return 0
	}
	return len(entries)
}

// layeredHead is Array.prototype.slice(0, limit).
func layeredHead(values []string, limit int) []string {
	if len(values) > limit {
		return values[:limit]
	}
	return values
}

// layeredOptionNumber is `config.layeredOptions?.[key] ?? fallback`.
func layeredOptionNumber(config *crawlfrontierllm.Object, key string, fallback float64) float64 {
	if value, ok := layeredNumberMember(layeredObject(config, "layeredOptions"), key); ok {
		return value
	}
	return fallback
}

// nativeOptionNumber is `config.nativeOptions?.[key] ?? fallback`.
func nativeOptionNumber(config *crawlfrontierllm.Object, key string, fallback float64) float64 {
	if value, ok := layeredNumberMember(layeredObject(config, "nativeOptions"), key); ok {
		return value
	}
	return fallback
}

// crawlKeywordSourcesOf reads the keyword lists uniqueStringList merges: the
// priority keywords, the keywords and the per-page-type signal keywords.
func crawlKeywordSourcesOf(config *crawlfrontierllm.Object) crawlKeywordSources {
	return crawlKeywordSources{
		Priority: crawlfrontierllm.ObjectStrings(config, "priorityKeywords"),
		Keywords: crawlfrontierllm.ObjectStrings(config, "keywords"),
		Category: crawlfrontierllm.ObjectStrings(frontierPageTypeSignal(config, "category"), "keywords"),
		List:     crawlfrontierllm.ObjectStrings(frontierPageTypeSignal(config, "list"), "keywords"),
		Article:  crawlfrontierllm.ObjectStrings(frontierPageTypeSignal(config, "article"), "keywords"),
	}
}

// crawlDeepCrawlComponentOf is `isPlainObject(value[key]) ? value[key] : undefined`
// for one of the four nativeOptions components.
func crawlDeepCrawlComponentOf(object *crawlfrontierllm.Object, key string) *crawlDeepCrawlComponent {
	value := layeredObject(object, key)
	if value == nil {
		return nil
	}
	component := &crawlDeepCrawlComponent{}
	if componentType, ok := value.String("type"); ok {
		component.Type = componentType
	}
	if params := layeredObject(value, "params"); params != nil {
		component.Params = params.Clone()
	}
	return component
}

// layeredDomainFilterParams builds DomainFilter params. `allowed_domains` and
// `blocked_domains` are dropped when undefined and kept as empty arrays only
// when the caller passes one.
func layeredDomainFilterParams(allowedDomains, blockedDomains []string) *crawlfrontierllm.Object {
	params := crawlfrontierllm.NewObject()
	layeredPutStrings(params, "allowed_domains", allowedDomains)
	layeredPutStrings(params, "blocked_domains", blockedDomains)
	return params
}

// ---------------------------------------------------------------------------
// ordered-object writes

// layeredPutObject stores an optional object member. A nil value is the JS
// `undefined` member, which JSON.stringify drops, so the key is removed instead
// of being written as null.
func layeredPutObject(target *crawlfrontierllm.Object, key string, value *crawlfrontierllm.Object) {
	if value == nil {
		target.Delete(key)
		return
	}
	target.Set(key, value)
}

// layeredPutString stores an optional string member.
func layeredPutString(target *crawlfrontierllm.Object, key string, value *string) {
	if value == nil {
		target.Delete(key)
		return
	}
	target.SetString(key, *value)
}

// layeredPutStrings stores an optional string array member.
func layeredPutStrings(target *crawlfrontierllm.Object, key string, value []string) {
	if len(value) == 0 {
		target.Delete(key)
		return
	}
	target.Set(key, value)
}

// layeredPutHeaders stores an optional browser header array member.
func layeredPutHeaders(target *crawlfrontierllm.Object, key string, value []crawloptions.BrowserHeader) {
	if len(value) == 0 {
		target.Delete(key)
		return
	}
	target.Set(key, value)
}

// layeredPutGenerator stores the optional user agent generator member.
func layeredPutGenerator(target *crawlfrontierllm.Object, key string, value *crawloptions.UserAgentGenerator) {
	if value == nil {
		target.Delete(key)
		return
	}
	target.Set(key, value)
}

// ---------------------------------------------------------------------------
// browser headers

// layeredBrowserHeaders decodes a browserHeaders array. Entries that are not
// plain objects with a non-empty string name and value are dropped, which is
// what mergeBrowserHeaders' typeof guards do.
func layeredBrowserHeaders(object *crawlfrontierllm.Object, key string) []crawloptions.BrowserHeader {
	raw, ok := object.Raw(key)
	if !ok {
		return nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil
	}
	headers := make([]crawloptions.BrowserHeader, 0, len(entries))
	for _, entry := range entries {
		value, parsed := crawlfrontierllm.ParseObject(entry)
		if !parsed {
			continue
		}
		name, ok := value.String("name")
		if !ok {
			continue
		}
		headerValue, ok := value.String("value")
		if !ok {
			continue
		}
		headers = append(headers, crawloptions.BrowserHeader{Name: name, Value: headerValue})
	}
	return headers
}

// layeredMergeBrowserHeaders ports mergeBrowserHeaders (230-245): the sets are
// applied in order, a header replaces an earlier header with the same
// case-insensitive name but keeps the earlier position, and a set with no
// header is undefined.
func layeredMergeBrowserHeaders(sets ...[]crawloptions.BrowserHeader) []crawloptions.BrowserHeader {
	merged := make([]crawloptions.BrowserHeader, 0, 4)
	positions := map[string]int{}
	for _, set := range sets {
		for _, header := range set {
			name := crawlfrontierllm.JsTrim(header.Name)
			value := crawlfrontierllm.JsTrim(header.Value)
			if name == "" || value == "" {
				continue
			}
			key := layeredNormalizeHeaderName(name)
			if position, ok := positions[key]; ok {
				merged[position] = crawloptions.BrowserHeader{Name: name, Value: value}
				continue
			}
			positions[key] = len(merged)
			merged = append(merged, crawloptions.BrowserHeader{Name: name, Value: value})
		}
	}
	if len(merged) == 0 {
		return nil
	}
	return merged
}

// layeredNormalizeHeaderName is normalizeHeaderName (226-228): trim and
// lower-case.
func layeredNormalizeHeaderName(value string) string {
	return strings.ToLower(crawlfrontierllm.JsTrim(value))
}

// layeredUserAgentGenerator projects the merged user agent generator record
// onto the typed configuration, dropping absent and non-string members. A
// record with no known member is undefined.
func layeredUserAgentGenerator(object *crawlfrontierllm.Object) *crawloptions.UserAgentGenerator {
	generator := &crawloptions.UserAgentGenerator{
		Platform:   layeredExplicitString(object, "platform"),
		Browser:    layeredExplicitString(object, "browser"),
		DeviceType: layeredExplicitString(object, "deviceType"),
		Locale:     layeredExplicitString(object, "locale"),
	}
	if generator.Platform == nil && generator.Browser == nil &&
		generator.DeviceType == nil && generator.Locale == nil {
		return nil
	}
	return generator
}

// ---------------------------------------------------------------------------
// small serialization helpers

// layeredStringListJSON is JSON.stringify for a string array: no HTML escaping,
// no whitespace. The DOM prune script embeds the result verbatim.
func layeredStringListJSON(values []string) (string, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(values); err != nil {
		return "", err
	}
	return strings.TrimSuffix(buffer.String(), "\n"), nil
}
