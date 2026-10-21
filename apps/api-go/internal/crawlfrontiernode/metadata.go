package crawlfrontiernode

// metadata.go ports the runtime metadata and the crawl-option diagnostics the
// layered branch records for one Frontier node:
//
//	createPageTypeCountRecord      crawl-frontier.service.ts 2548-2556
//	buildNodeRuntimeMetadata       2770-2848
//	resolveCanonicalUrlMatchKey    2850-2857
//	isCanonicalUrlMatch            2858-2885
//	buildCrawlOptionsDiagnostics   2887-2977
//	estimateFreshnessScore         crawl-frontier.utils.ts 1253-1284
//
// The JavaScript `undefined` / `null` distinction is the reason every value is
// built with crawlfrontierllm.Object instead of a Go map: mergeMetadataRecords
// and JSON.stringify drop an `undefined` member, so `failureKind`,
// `canonicalUrl` and `urlFingerprint` must be absent from the JSON when NestJS
// has no value, while `httpStatus` and `crawlError` must be present with an
// explicit JSON null. The diagnostics object never omits a key: all nine of its
// members are `string | null` and are written as null when absent.
//
// Note on reading the raw profile config: NestJS reads `config.pageRules[type]`
// and `config.crawlOptions` as `Record<string, unknown>` and tests leaves with
// typeof / isPlainObject, so the Go side reads the ordered config Object leaf by
// leaf and never assumes a typed profile shape.

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
)

// createPageTypeCountRecord is createPageTypeCountRecord (2548-2556): the four
// frontier page types in the fixed home/category/list/article order, all zero.
// The record is a counter bucket, so the key order is the persisted JSON order.
func createPageTypeCountRecord() *crawlfrontierllm.Object {
	counts := crawlfrontierllm.NewObject()
	counts.SetNumber("home", 0)
	counts.SetNumber("category", 0)
	counts.SetNumber("list", 0)
	counts.SetNumber("article", 0)
	return counts
}

// estimateFreshnessScore is estimateFreshnessScore
// (crawl-frontier.utils.ts 1253-1284): the /YYYY/M/D/ path segment is the
// article date and the age band picks 1 / 0.75 / 0.4 / 0.1, everything else is
// 0.
//
// The banding itself is the package port the discovery branch already uses
// (frontierEstimateFreshnessScore in discover.go, same rules and the same
// 24/168/720 hour fallbacks). This wrapper only supplies what NestJS reads
// inside the function body: `new Date()` at call time. Callers that hold the
// service clock pass s.now() instead so tests can pin it, which is what
// buildNodeRuntimeMetadata does.
func estimateFreshnessScore(nodeURL string, config *crawlfrontierllm.Object) float64 {
	return frontierEstimateFreshnessScore(nodeURL, config, time.Now())
}

// buildNodeRuntimeMetadata is buildNodeRuntimeMetadata (2770-2848).
//
// The returned object literal has a fixed key order:
//
//	sourceTier, failureKind?, warningFlags, httpStatus, crawlError,
//	freshnessBucket, discoveryPath, frontierPath, canonicalUrl?, urlFingerprint?,
//	...buildCrawlOptionsDiagnostics
//
// The spread appends the nine diagnostics keys in their own order and would
// overwrite a same-named key in place; no name collides today, but the merge is
// written with SetRaw so the order stays exactly the NestJS order.
func (s *Service) buildNodeRuntimeMetadata(input nodeRuntimeMetadataInput) *crawlfrontierllm.Object {
	// NestJS dereferences options.node / options.profile unconditionally; the Go
	// input carries pointers, so the zero record stands in for a nil node and a
	// nil config behaves like an unconfigured profile (every reader falls back).
	var node crawlfrontierllm.NodeRecord
	if input.Node != nil {
		node = *input.Node
	}
	var config *crawlfrontierllm.Object
	if input.Profile != nil {
		config = input.Profile.Config
	}

	// selfResponse = response.results.find(entry => isCanonicalUrlMatch(
	//   entry.url, node.url, profile.config)) ?? null.
	var selfResponse *crawl4ai.PipelineArticle
	for index := range input.Response.Results {
		entry := &input.Response.Results[index]
		if s.isCanonicalURLMatch(entry.URL, node.URL, config) {
			selfResponse = entry
			break
		}
	}

	// statusCode = typeof selfResponse?.statusCode === "number"
	//   ? selfResponse.statusCode
	//   : typeof selfResponse?.status_code === "number" ? selfResponse.status_code : null.
	// crawl4ai.PipelineArticle applies that camel-then-snake precedence once,
	// when it decodes the response, so the pointer already is the resolved value.
	var statusCode *int
	if selfResponse != nil {
		statusCode = selfResponse.StatusCode
	}

	// crawlError = typeof selfResponse?.error === "string" ? error
	//   : typeof selfResponse?.errorMessage === "string" ? errorMessage
	//   : typeof selfResponse?.error_message === "string" ? error_message : null.
	//
	// crawl4ai.PipelineArticle collapses the three spellings into one string
	// field, so "" is the only available "no message" form here. NestJS would
	// keep an explicitly empty `error: ""` as crawlError:"" and this port writes
	// crawlError:null for it; classifyFrontierFailureKind treats both the same.
	var crawlError *string
	if selfResponse != nil && selfResponse.Error != "" {
		value := selfResponse.Error
		crawlError = &value
	}

	// warningFlags order: failureKind first, then http_<status> when the status
	// is a failure, then self_result_mismatch when no result belongs to this
	// node. The slice is allocated so an empty list serializes as [] (NestJS
	// always returns the array it pushed into).
	warningFlags := make([]string, 0, 3)
	failureKind := crawlfrontierllm.ClassifyFrontierFailureKind(crawlError)
	if failureKind == nil && statusCode != nil &&
		(*statusCode == 401 || *statusCode == 403 || *statusCode == 429) {
		detected := "challenge_detected"
		failureKind = &detected
	}
	if failureKind != nil {
		warningFlags = append(warningFlags, *failureKind)
	}
	if statusCode != nil && *statusCode >= 400 {
		warningFlags = append(warningFlags, "http_"+strconv.Itoa(*statusCode))
	}
	if selfResponse == nil && len(input.Response.Results) > 0 {
		warningFlags = append(warningFlags, "self_result_mismatch")
	}

	// const freshnessScore = estimateFreshnessScore(node.url, profile.config);
	// The service clock replaces the `new Date()` inside that helper, matching
	// the discovery branch.
	freshnessScore := frontierEstimateFreshnessScore(node.URL, config, s.now())

	// buildCrawlOptionsDiagnostics needs config, not a typed profile: the
	// pageRules/crawlOptions leaves are read raw, exactly like NestJS.
	crawlOptionsDiagnostics := s.buildCrawlOptionsDiagnostics(config, node.PageType, input.CrawlOptions)

	metadata := crawlfrontierllm.NewObject()

	// sourceTier: options.profile.config.sourceTier ?? "tier2". `??` only falls
	// back for undefined/null, so a present string is kept verbatim — including
	// an empty one (CrawlSourceTier is a tier1/tier2/tier3 enum, so this only
	// fires for a hand-written profile). metadataStringLeaf is the typeof test
	// that keeps null out; UntrimmedString alone reports JSON null as "".
	sourceTier := "tier2"
	if value := metadataStringLeaf(config, "sourceTier"); value != nil {
		sourceTier = *value
	}
	metadata.SetString("sourceTier", sourceTier)

	// failureKind is `string | undefined`: an undefined value must not reach the
	// JSON, which is why the key is skipped instead of set to null.
	if failureKind != nil {
		metadata.SetString("failureKind", *failureKind)
	}
	metadata.Set("warningFlags", warningFlags)
	if statusCode != nil {
		metadata.SetNumber("httpStatus", float64(*statusCode))
	} else {
		metadata.SetNull("httpStatus")
	}
	if crawlError != nil {
		metadata.SetString("crawlError", *crawlError)
	} else {
		metadata.SetNull("crawlError")
	}
	metadata.SetString("freshnessBucket", crawlfrontierllm.ResolveFreshnessBucket(freshnessScore))

	// discoveryPath / frontierPath: the node's own metadata array wins verbatim
	// (Array.isArray check, not a copy), otherwise a new [node.pageType].
	metadata.SetRaw("discoveryPath", metadataNodePath(node.Metadata, "discoveryPath", node.PageType))
	metadata.SetRaw("frontierPath", metadataNodePath(node.Metadata, "frontierPath", node.PageType))

	// canonicalUrl / urlFingerprint: `typeof selfMetadata?.key === "string"`.
	// The typeof test keeps an empty string but drops null, so both members are
	// only written when they hold a string (an absent member is what the JSON
	// needs, not a null one).
	if canonicalURL := metadataStringLeaf(input.SelfMetadata, "canonicalUrl"); canonicalURL != nil {
		metadata.SetString("canonicalUrl", *canonicalURL)
	}
	if urlFingerprint := metadataStringLeaf(input.SelfMetadata, "urlFingerprint"); urlFingerprint != nil {
		metadata.SetString("urlFingerprint", *urlFingerprint)
	}

	// ...crawlOptionsDiagnostics: object spread appends every new key in the
	// diagnostics order and replaces an existing key in place.
	for _, key := range crawlOptionsDiagnostics.Keys() {
		raw, ok := crawlOptionsDiagnostics.Raw(key)
		if !ok {
			continue
		}
		metadata.SetRaw(key, raw)
	}
	return metadata
}

// resolveCanonicalURLMatchKey is resolveCanonicalUrlMatchKey (2850-2857).
//
//	fingerprint?.fingerprint ?? fingerprint?.canonicalUrl ?? null
//
// The allowlist parameter is adapted to the shape
// crawlfrontierllm.BuildCanonicalURLFingerprint takes: NestJS passes `unknown`
// (undefined, or the resolved string[]), and the Go fingerprint helper takes the
// already-normalized []string where nil means undefined and therefore falls back
// to DEFAULT_URL_QUERY_PARAM_ALLOWLIST. An explicitly empty, non-nil slice keeps
// its "strip every query parameter" meaning.
func (s *Service) resolveCanonicalURLMatchKey(value string, queryParamAllowlist []string) *string {
	fingerprint := crawlfrontierllm.BuildCanonicalURLFingerprint(value, queryParamAllowlist)
	if fingerprint == nil {
		// canonicalizeUrlWithQueryAllowlist returned "" (unparseable URL).
		return nil
	}
	if fingerprint.Fingerprint != "" {
		return stringPointer(fingerprint.Fingerprint)
	}
	if fingerprint.CanonicalURL != "" {
		return stringPointer(fingerprint.CanonicalURL)
	}
	return nil
}

// isCanonicalURLMatch is isCanonicalUrlMatch (2858-2885): two URLs are the same
// node when their canonical fingerprints (equal after the allowlisted query is
// kept) match, with a plain trimmed-equality fallback when either side has no
// fingerprint.
//
// sourceURL/nodeURL are the Go form of NestJS `string | null | undefined`: null
// and undefined both read as "" and return false, exactly like the early return
// at 2865. config is the `configOrMetadata?: unknown` argument; a nil config is
// the isPlainObject check failing, which leaves the allowlist undefined.
func (s *Service) isCanonicalURLMatch(sourceURL, nodeURL string, config *crawlfrontierllm.Object) bool {
	leftURL := crawlfrontierllm.JsTrim(sourceURL)
	rightURL := crawlfrontierllm.JsTrim(nodeURL)
	if leftURL == "" || rightURL == "" {
		return false
	}

	// const queryParamAllowlist = isPlainObject(configOrMetadata)
	//   ? resolveQueryParamAllowlist(configOrMetadata.urlQueryParamAllowlist)
	//   : undefined;
	var queryParamAllowlist []string
	if config != nil {
		queryParamAllowlist = metadataResolveQueryParamAllowlist(config)
	}

	leftKey := s.resolveCanonicalURLMatchKey(leftURL, queryParamAllowlist)
	rightKey := s.resolveCanonicalURLMatchKey(rightURL, queryParamAllowlist)
	// `if (leftKey && rightKey)`: an empty key is falsy, so the fallback runs.
	if leftKey != nil && rightKey != nil && *leftKey != "" && *rightKey != "" {
		return *leftKey == *rightKey
	}
	return leftURL == rightURL
}

// buildCrawlOptionsDiagnostics is buildCrawlOptionsDiagnostics (2887-2977): it
// records whether each layered crawl option came from the profile ("manual") or
// from the automatic builder ("auto"), and the resolved values that matter for
// debugging. Every member is `string | null`, so all nine keys are always
// present.
//
// pageType is CrawlFrontierPageType; the pageRules leaf and the profile-wide
// crawlOptions leaf are read raw because the hasManual* flags test their
// members with isPlainObject / typeof.
func (s *Service) buildCrawlOptionsDiagnostics(config *crawlfrontierllm.Object, pageType string, crawlOptions layeredCrawlOptions) *crawlfrontierllm.Object {
	pageRule := metadataPageRule(config, pageType)
	base := metadataBaseCrawlOptions(config)

	hasManualLinkPreview := metadataPlainObjectLeaf(pageRule, "linkPreview") ||
		metadataPlainObjectLeaf(base, "linkPreview")
	hasManualCSSSelector := metadataNonEmptyStringLeaf(pageRule, "cssSelector") ||
		metadataNonEmptyStringLeaf(base, "cssSelector")
	hasManualWaitFor := metadataNonEmptyStringLeaf(pageRule, "waitForSelector") ||
		metadataNonEmptyStringLeaf(base, "waitForSelector") ||
		metadataNonEmptyStringLeaf(pageRule, "waitForScript") ||
		metadataNonEmptyStringLeaf(base, "waitForScript")
	hasManualMarkdownFilter := metadataPlainObjectLeaf(pageRule, "markdownFilter") ||
		metadataPlainObjectLeaf(base, "markdownFilter")
	hasManualLocale := metadataNonEmptyStringLeaf(pageRule, "locale") ||
		metadataNonEmptyStringLeaf(base, "locale")
	// mergeBrowserHeaders(base.browserHeaders, pageRule.browserHeaders) followed
	// by some(header => normalizeHeaderName(header.name) === "accept-language").
	// The merge dedupes by lowercased name, which cannot change membership, so
	// the two lists are tested independently.
	hasManualAcceptLanguage := metadataHeadersHaveAcceptLanguage(pageRule) ||
		metadataHeadersHaveAcceptLanguage(base)

	// The resolved options side of acceptLanguageMode tests the header NAME only
	// (2972-2974), unlike the merged manual test above which also requires a
	// non-empty value.
	resolvedAcceptLanguage := false
	for _, header := range crawlOptions.BrowserHeaders {
		if strings.ToLower(crawlfrontierllm.JsTrim(header.Name)) == "accept-language" {
			resolvedAcceptLanguage = true
			break
		}
	}

	diagnostics := crawlfrontierllm.NewObject()

	// linkPreviewMode: crawlOptions.linkPreview ? hasManualLinkPreview ? "manual"
	// : "auto" : null.
	if crawlOptions.LinkPreview != nil {
		if hasManualLinkPreview {
			diagnostics.SetString("linkPreviewMode", "manual")
		} else {
			diagnostics.SetString("linkPreviewMode", "auto")
		}
	} else {
		diagnostics.SetNull("linkPreviewMode")
	}

	// linkPreviewQuery: linkPreview?.query && query.trim().length > 0
	//   ? query.trim() : null.
	linkPreviewQuery := ""
	if crawlOptions.LinkPreview != nil {
		linkPreviewQuery = crawlfrontierllm.JsTrim(crawlOptions.LinkPreview.Query)
	}
	if linkPreviewQuery != "" {
		diagnostics.SetString("linkPreviewQuery", linkPreviewQuery)
	} else {
		diagnostics.SetNull("linkPreviewQuery")
	}

	// domScopeMode: crawlOptions.cssSelector ? ... : null. Truthiness of the
	// resolved string, not of the trimmed value.
	if crawlOptions.CSSSelector != "" {
		if hasManualCSSSelector {
			diagnostics.SetString("domScopeMode", "manual")
		} else {
			diagnostics.SetString("domScopeMode", "auto")
		}
	} else {
		diagnostics.SetNull("domScopeMode")
	}

	// waitForMode: (waitForSelector || waitForScript) ? ... : null.
	if crawlOptions.WaitForSelector != "" || crawlOptions.WaitForScript != "" {
		if hasManualWaitFor {
			diagnostics.SetString("waitForMode", "manual")
		} else {
			diagnostics.SetString("waitForMode", "auto")
		}
	} else {
		diagnostics.SetNull("waitForMode")
	}

	// markdownFilterMode: crawlOptions.markdownFilter ? ... : null.
	if crawlOptions.MarkdownFilter != nil {
		if hasManualMarkdownFilter {
			diagnostics.SetString("markdownFilterMode", "manual")
		} else {
			diagnostics.SetString("markdownFilterMode", "auto")
		}
	} else {
		diagnostics.SetNull("markdownFilterMode")
	}

	// markdownFilterType: markdownFilter?.type && type.trim().length > 0
	//   ? type.trim() : null.
	markdownFilterType := ""
	if crawlOptions.MarkdownFilter != nil {
		markdownFilterType = crawlfrontierllm.JsTrim(crawlOptions.MarkdownFilter.Type)
	}
	if markdownFilterType != "" {
		diagnostics.SetString("markdownFilterType", markdownFilterType)
	} else {
		diagnostics.SetNull("markdownFilterType")
	}

	// localeMode: crawlOptions.locale ? ... : null. The resolved locale is kept
	// untrimmed, so a whitespace-only locale is truthy here exactly like NestJS.
	if crawlOptions.Locale != "" {
		if hasManualLocale {
			diagnostics.SetString("localeMode", "manual")
		} else {
			diagnostics.SetString("localeMode", "auto")
		}
	} else {
		diagnostics.SetNull("localeMode")
	}

	// localeValue: typeof locale === "string" && locale.trim().length > 0
	//   ? locale.trim() : null. Locale is always a string here, so only the
	//   trimmed emptiness test is left.
	localeValue := crawlfrontierllm.JsTrim(crawlOptions.Locale)
	if localeValue != "" {
		diagnostics.SetString("localeValue", localeValue)
	} else {
		diagnostics.SetNull("localeValue")
	}

	// acceptLanguageMode: hasManualAcceptLanguage ? "manual"
	//   : resolvedHeaders.some(name === accept-language) ? "auto" : null.
	if hasManualAcceptLanguage {
		diagnostics.SetString("acceptLanguageMode", "manual")
	} else if resolvedAcceptLanguage {
		diagnostics.SetString("acceptLanguageMode", "auto")
	} else {
		diagnostics.SetNull("acceptLanguageMode")
	}

	return diagnostics
}

// metadataResolveQueryParamAllowlist is resolveQueryParamAllowlist
// (url-fingerprint.ts 25-28) =
// normalizeUrlQueryParamAllowlist(config.urlQueryParamAllowlist,
// DEFAULT_URL_QUERY_PARAM_ALLOWLIST).
//
// An absent or null value yields the default allowlist. Any other value is
// parsed first (array, or a comma/newline separated string); a value that parses
// to nothing — including an explicit empty array — yields an empty allowlist,
// which canonicalization reads as "strip every query parameter". The returned
// slice is non-nil for every explicit value so that distinction survives.
func metadataResolveQueryParamAllowlist(config *crawlfrontierllm.Object) []string {
	raw, ok := config.Raw("urlQueryParamAllowlist")
	if !ok || metadataIsJSONNull(raw) {
		return crawlfrontierllm.NormalizeURLQueryParamAllowlist(nil, crawlfrontierllm.DefaultURLQueryParamAllowlist)
	}
	return crawlfrontierllm.NormalizeURLQueryParamAllowlist(metadataAllowlistEntries(raw), nil)
}

// metadataAllowlistEntries is parseAllowlistInput (url-canonical.ts 41-53): an
// array is read element by element, a string is split on "," or "\n" with the
// empty segments dropped, and anything else parses to no entry.
func metadataAllowlistEntries(raw json.RawMessage) []string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return []string{}
	}
	switch trimmed[0] {
	case '[':
		var elements []json.RawMessage
		if err := json.Unmarshal(trimmed, &elements); err != nil {
			return []string{}
		}
		entries := make([]string, 0, len(elements))
		for _, element := range elements {
			// normalizeParamKey ignores non-strings (url-canonical.ts 22-24).
			var text string
			if err := json.Unmarshal(element, &text); err != nil {
				continue
			}
			entries = append(entries, text)
		}
		return entries
	case '"':
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return []string{}
		}
		segments := strings.FieldsFunc(text, func(char rune) bool {
			return char == ',' || char == '\n'
		})
		entries := make([]string, 0, len(segments))
		for _, segment := range segments {
			if trimmedSegment := crawlfrontierllm.JsTrim(segment); trimmedSegment != "" {
				entries = append(entries, trimmedSegment)
			}
		}
		return entries
	}
	return []string{}
}

// metadataIsJSONNull reports a raw JSON null leaf.
func metadataIsJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// metadataIsJSONArray reports Array.isArray for a raw JSON leaf.
func metadataIsJSONArray(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '['
}

// metadataNodePath is
// `metadata && Array.isArray(metadata[key]) ? metadata[key] : [pageType]`.
// The node's array is used verbatim (any element type, any order); otherwise a
// fresh single-element array holding the page type is built.
func metadataNodePath(nodeMetadata *crawlfrontierllm.Object, key, pageType string) json.RawMessage {
	if nodeMetadata != nil {
		if raw, ok := nodeMetadata.Raw(key); ok && metadataIsJSONArray(raw) {
			return raw
		}
	}
	encodedPageType, err := json.Marshal(pageType)
	if err != nil {
		return json.RawMessage("[]")
	}
	array := crawlfrontierllm.NewArray()
	array.Append(encodedPageType)
	raw, err := array.MarshalJSON()
	if err != nil {
		return json.RawMessage("[]")
	}
	return raw
}

// metadataPageRule is `isPlainObject(config.pageRules?.[pageType]) ? that : {}`.
// A nil result behaves like the empty object: every leaf read on it is absent.
func metadataPageRule(config *crawlfrontierllm.Object, pageType string) *crawlfrontierllm.Object {
	if config == nil {
		return nil
	}
	pageRules, ok := config.Object("pageRules")
	if !ok {
		return nil
	}
	pageRule, ok := pageRules.Object(pageType)
	if !ok {
		return nil
	}
	return pageRule
}

// metadataBaseCrawlOptions is `isPlainObject(config.crawlOptions) ? that : {}`.
func metadataBaseCrawlOptions(config *crawlfrontierllm.Object) *crawlfrontierllm.Object {
	if config == nil {
		return nil
	}
	base, ok := config.Object("crawlOptions")
	if !ok {
		return nil
	}
	return base
}

// metadataPlainObjectLeaf is isPlainObject(object?.[key]).
func metadataPlainObjectLeaf(object *crawlfrontierllm.Object, key string) bool {
	if object == nil {
		return false
	}
	_, ok := object.Object(key)
	return ok
}

// metadataNonEmptyStringLeaf is
// `typeof object?.[key] === "string" && object[key].trim().length > 0`.
// Object.String trims and reports an all-whitespace string as absent.
func metadataNonEmptyStringLeaf(object *crawlfrontierllm.Object, key string) bool {
	if object == nil {
		return false
	}
	_, ok := object.String(key)
	return ok
}

// metadataStringLeaf is `typeof object?.[key] === "string" ? object[key] : undefined`:
// the value is returned untrimmed (an empty string is a present string) and a
// missing, null or non-string leaf is nil. Object.UntrimmedString alone cannot
// answer this, because unmarshalling a JSON null into a Go string succeeds and
// yields "" — JSON null is not a string in JavaScript.
func metadataStringLeaf(object *crawlfrontierllm.Object, key string) *string {
	if object == nil {
		return nil
	}
	raw, ok := object.Raw(key)
	if !ok || metadataIsJSONNull(raw) {
		return nil
	}
	value, ok := object.UntrimmedString(key)
	if !ok {
		return nil
	}
	return &value
}

// metadataHeadersHaveAcceptLanguage is the membership half of
// mergeBrowserHeaders(base.browserHeaders, pageRule.browserHeaders)?.some(
// header => normalizeHeaderName(header.name) === "accept-language") for one of
// the two header lists.
//
// mergeBrowserHeaders skips an entry whose trimmed name or trimmed value is
// empty, and keeps the trimmed name; membership therefore requires a non-empty
// trimmed name and value, and the lowercased name must be accept-language.
func metadataHeadersHaveAcceptLanguage(object *crawlfrontierllm.Object) bool {
	if object == nil {
		return false
	}
	raw, ok := object.Raw("browserHeaders")
	if !ok || !metadataIsJSONArray(raw) {
		return false
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return false
	}
	for _, entry := range entries {
		header, ok := crawlfrontierllm.ParseObject(entry)
		if !ok {
			continue
		}
		name, okName := header.String("name")
		if !okName {
			continue
		}
		if _, okValue := header.String("value"); !okValue {
			continue
		}
		if strings.ToLower(name) == "accept-language" {
			return true
		}
	}
	return false
}
