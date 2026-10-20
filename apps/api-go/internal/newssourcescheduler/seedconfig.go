package newssourcescheduler

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"strings"
)

// This file ports normalizeSeedConfig, mergeWorkflowSourceConfig, the seed
// clamps, the RSS fetch policy normalization and buildSeedDiscoveryCacheKey.
// The seed block is an extension JSON leaf inside NewsSource.config, so it is
// traversed with the object helpers; the resolved values are the typed
// seedConfig used by the discovery chain.

// workflowOverlay is CrawlStrategyCompiledNewsSourceOverlay projected to the
// three fields normalizeSeedConfig merges.
type workflowOverlay struct {
	CrawlOptions json.RawMessage
	Seed         json.RawMessage
	Keywords     []string
}

// mergeWorkflowSourceConfig is mergeWorkflowSourceConfig.
func mergeWorkflowSourceConfig(config jsonObject, overlay *workflowOverlay) jsonObject {
	if overlay == nil {
		return config
	}
	merged := jsonObject{}
	for key, value := range config {
		merged[key] = value
	}
	if len(overlay.Keywords) > 0 {
		merged["keywords"] = rawValue(overlay.Keywords)
	}
	existingCrawlOptions, _ := config.objectField("crawlOptions")
	overlayCrawlOptions, _ := decodeObject(overlay.CrawlOptions)
	merged["crawlOptions"] = rawValue(mergeObjects(existingCrawlOptions, overlayCrawlOptions))
	existingSeed, _ := config.objectField("seed")
	overlaySeed, _ := decodeObject(overlay.Seed)
	merged["seed"] = rawValue(mergeObjects(existingSeed, overlaySeed))
	return merged
}

// normalizeSeedConfig is normalizeSeedConfig.
func normalizeSeedConfig(source *source, runtimeSettings seedRuntimeSettings, overlay *workflowOverlay) *seedConfig {
	config, _ := decodeObject(source.Config)
	merged := mergeWorkflowSourceConfig(config, overlay)
	if merged == nil {
		return nil
	}
	seed, ok := merged.objectField("seed")
	if !ok {
		return nil
	}
	if enabled, ok := seed.boolField("enabled"); !ok || !enabled {
		return nil
	}
	modeRaw, _ := seed.stringField("mode")
	var mode seedMode
	switch lowerTrim(modeRaw) {
	case "rss":
		mode = seedModeRSS
	case "list":
		mode = seedModeList
	case "deep":
		mode = seedModeDeep
	default:
		mode = seedModeSitemap
	}

	deepConfig, hasDeep := seed.objectField("deep")
	if mode != seedModeDeep || !hasDeep {
		deepConfig = nil
	}

	keywords := stringListField(merged["keywords"])
	query := ""
	if value, ok := seed.stringField("query"); ok && trimJS(value) != "" {
		query = trimJS(value)
	} else if len(keywords) > 0 {
		query = strings.Join(keywords, " ")
	}
	var queryTokens []string
	if query != "" {
		queryTokens = tokenizeQuery(query)
	}

	modeDefaultCacheTTL := runtimeSettings.SeedCacheTTLSecondsSitemapRSS
	if mode == seedModeList || mode == seedModeDeep {
		modeDefaultCacheTTL = runtimeSettings.SeedCacheTTLSecondsListDeep
	}
	sourceCacheTTL := toOptionalSeedCacheTTLSeconds(seed)
	policy := seedCacheTTLPolicyModeDefault
	cacheTTL := modeDefaultCacheTTL
	if runtimeSettings.SeedCacheTTLForceGlobal {
		policy = seedCacheTTLPolicyGlobalForced
	} else if sourceCacheTTL != nil {
		policy = seedCacheTTLPolicySourceOverride
		cacheTTL = *sourceCacheTTL
	}

	sourceAllowlist := seedQueryParamAllowlist(seed)
	allowlist := runtimeSettings.SeedURLQueryParamAllowlist
	if len(sourceAllowlist) > 0 {
		allowlist = sourceAllowlist
	}

	var rssFetch *rssFetchConfig
	if mode == seedModeRSS {
		fetch := normalizeSeedRSSFetchConfig(seed)
		rssFetch = &fetch
	}

	config2 := &seedConfig{
		Enabled:             true,
		Mode:                mode,
		RSSAdaptiveEnabled:  mode == seedModeRSS && seedRSSAdaptiveEnabled(seed),
		MaxURLs:             clampIntField(seed, "maxUrls", 1, 2_000, 200),
		MaxNewURLsPerRun:    clampIntField(seed, "maxNewUrlsPerRun", 1, 500, 80),
		ListMaxPages:        clampIntField(seed, "listMaxPages", 1, 20, 6),
		ListPageConcurrency: clampIntField(seed, "listPageConcurrency", 1, 5, 2),
		FollowPagination:    boolFieldDefault(seed, "followPagination", true),
		QueryTokens:         queryTokens,
		ScoreThreshold:      clampFloatField(seed, "scoreThreshold", 0, 1, 0),
		DedupeWindowHours:   clampIntField(seed, "dedupeWindowHours", 0, 24*30, 24),
		QueryParamAllowlist: allowlist,
		CacheTTLSeconds:     cacheTTL,
		CacheTTLPolicy:      policy,
		RSSFetch:            rssFetch,
	}
	if mode == seedModeSitemap || mode == seedModeList || mode == seedModeDeep {
		if domain, ok := normalizeSeedDomain(seed, source.URL); ok {
			config2.Domain = &domain
		}
		if pattern, ok := seed.stringField("pattern"); ok {
			trimmed := trimJS(pattern)
			if trimmed != "" {
				config2.Pattern = &trimmed
			}
		}
	}
	if mode == seedModeRSS {
		if feedURL, ok := normalizeSeedFeedURL(seed, source.URL); ok {
			config2.FeedURL = &feedURL
		}
	}
	if mode == seedModeDeep {
		config2.Deep = normalizeDeepSeedConfig(deepConfig)
	}
	return config2
}

// seedRSSAdaptiveEnabled is the `seed.rssAdaptive.enabled === true` check.
func seedRSSAdaptiveEnabled(seed jsonObject) bool {
	adaptive, ok := seed.objectField("rssAdaptive")
	if !ok {
		return false
	}
	enabled, ok := adaptive.boolField("enabled")
	return ok && enabled
}

// seedQueryParamAllowlist normalizes seed.queryParamAllowlist with an empty
// fallback (an explicit [] strips every parameter).
func seedQueryParamAllowlist(seed jsonObject) []string {
	raw, present := seed["queryParamAllowlist"]
	if !present || trimJS(string(raw)) == "null" {
		return nil
	}
	var entries []string
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil
	}
	return normalizeSeedQueryParamAllowlist(entries)
}

// clampIntField is clampInt.
func clampIntField(object jsonObject, key string, min, max, fallback int) int {
	value, ok := object.numberField(key)
	if !ok {
		return fallback
	}
	rounded := int(jsRound(value))
	if rounded < min {
		rounded = min
	}
	if rounded > max {
		rounded = max
	}
	return rounded
}

// clampFloatField is clampFloat.
func clampFloatField(object jsonObject, key string, min, max, fallback float64) float64 {
	value, ok := object.numberField(key)
	if !ok {
		return fallback
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// boolFieldDefault is `object[key] !== false`-style defaults.
func boolFieldDefault(object jsonObject, key string, fallback bool) bool {
	value, ok := object.boolField(key)
	if !ok {
		return fallback
	}
	return value
}

// toOptionalSeedCacheTtlSeconds is toOptionalSeedCacheTtlSeconds: only an
// in-range integer counts as a source override.
func toOptionalSeedCacheTTLSeconds(seed jsonObject) *int {
	value, ok := seed.numberField("cacheTtlSeconds")
	if !ok {
		return nil
	}
	rounded := int(jsRound(value))
	if rounded < minSeedCacheTTLSeconds || rounded > maxSeedCacheTTLSeconds {
		return nil
	}
	return &rounded
}

// normalizeSeedDomain is normalizeSeedDomain: the URL origin of the configured
// domain, falling back to the source URL origin.
func normalizeSeedDomain(seed jsonObject, fallbackURL string) (string, bool) {
	raw, _ := seed.stringField("domain")
	candidate := trimJS(raw)
	if candidate == "" {
		candidate = fallbackURL
	}
	withProtocol := candidate
	if !hasHTTPPrefix(candidate) {
		withProtocol = "https://" + candidate
	}
	if parsed, err := url.Parse(withProtocol); err == nil && parsed.Hostname() != "" {
		return originOf(parsed), true
	}
	if parsed, err := url.Parse(fallbackURL); err == nil && parsed.Hostname() != "" {
		return originOf(parsed), true
	}
	return "", false
}

// normalizeSeedFeedURL is normalizeSeedFeedUrl: the URL serialization of the
// configured feed with the source URL as the fallback.
func normalizeSeedFeedURL(seed jsonObject, fallbackURL string) (string, bool) {
	raw, _ := seed.stringField("feedUrl")
	candidate := trimJS(raw)
	if candidate == "" {
		candidate = fallbackURL
	}
	withProtocol := candidate
	if !hasHTTPPrefix(candidate) {
		withProtocol = "https://" + candidate
	}
	if parsed, err := url.Parse(withProtocol); err == nil && parsed.Hostname() != "" {
		return jsURLString(parsed), true
	}
	if parsed, err := url.Parse(fallbackURL); err == nil && parsed.Hostname() != "" {
		return jsURLString(parsed), true
	}
	return "", false
}

// hasHTTPPrefix is /^https?:\/\//i.
func hasHTTPPrefix(value string) bool {
	lowered := strings.ToLower(value)
	return strings.HasPrefix(lowered, "http://") || strings.HasPrefix(lowered, "https://")
}

// originOf is URL.origin.
func originOf(parsed *url.URL) string {
	return parsed.Scheme + "://" + strings.ToLower(parsed.Host)
}

// jsURLString is URL.prototype.toString for the scheme/host/path/query/fragment
// parts the seed config uses.
func jsURLString(parsed *url.URL) string {
	path := parsed.EscapedPath()
	if path == "" {
		path = "/"
	}
	out := parsed.Scheme + "://" + strings.ToLower(parsed.Host) + path
	if parsed.RawQuery != "" {
		out += "?" + parsed.RawQuery
	}
	if parsed.Fragment != "" {
		out += "#" + parsed.Fragment
	}
	return out
}

// normalizeDeepSeedConfig is the deep block of normalizeSeedConfig.
func normalizeDeepSeedConfig(deep jsonObject) *deepSeedConfig {
	return &deepSeedConfig{
		MaxPages:            clampIntField(deep, "maxPages", 5, 300, 80),
		MaxDepth:            clampIntField(deep, "maxDepth", 1, 4, 2),
		TimeBudgetSeconds:   clampIntField(deep, "timeBudgetSeconds", 10, 180, 60),
		PageConcurrency:     clampIntField(deep, "pageConcurrency", 1, 6, 2),
		ScoreThreshold:      clampFloatField(deep, "scoreThreshold", 0, 1, 0.2),
		CandidatePoolSize:   clampIntField(deep, "candidatePoolSize", 20, 400, 120),
		HeadFetchTopK:       clampIntField(deep, "headFetchTopK", 10, 120, 40),
		PreferPathDate:      boolFieldDefault(deep, "preferPathDate", true),
		EnableSecondaryHubs: boolFieldDefault(deep, "enableSecondaryHubs", true),
		IgnoreRobotsTxt:     true,
	}
}

// normalizeSeedRSSFetchConfig is normalizeSeedRssFetchConfig.
func normalizeSeedRSSFetchConfig(seed jsonObject) rssFetchConfig {
	record, _ := seed.objectField("rssFetch")
	hasCustomFields := record != nil &&
		(hasObjectKey(record, "requestTimeoutMs") || hasObjectKey(record, "bodySourceStrategy") || hasObjectKey(record, "noBodyPolicy"))
	enabled := false
	if record != nil {
		if value, ok := record.boolField("enabled"); ok {
			// enabled === true turns the policy on; an explicit false keeps it
			// off even when the strategy fields are present.
			enabled = value
		} else {
			enabled = hasCustomFields
		}
	}
	if !enabled {
		return rssFetchConfig{
			Enabled:            false,
			RequestTimeoutMs:   15_000,
			BodySourceStrategy: "content_first",
			NoBodyPolicy:       "skip",
		}
	}
	bodySourceStrategyRaw, _ := record.stringField("bodySourceStrategy")
	bodySourceStrategy := "content_first"
	switch lowerTrim(bodySourceStrategyRaw) {
	case "content_only":
		bodySourceStrategy = "content_only"
	case "summary_only":
		bodySourceStrategy = "summary_only"
	}
	noBodyPolicyRaw, _ := record.stringField("noBodyPolicy")
	noBodyPolicy := "skip"
	if lowerTrim(noBodyPolicyRaw) == "title_description_stub" {
		noBodyPolicy = "title_description_stub"
	}
	return rssFetchConfig{
		Enabled:            true,
		RequestTimeoutMs:   clampIntField(record, "requestTimeoutMs", 1_000, 120_000, 15_000),
		BodySourceStrategy: bodySourceStrategy,
		NoBodyPolicy:       noBodyPolicy,
	}
}

// hasObjectKey reports whether the key is present (Object.prototype.hasOwnProperty).
func hasObjectKey(object jsonObject, key string) bool {
	_, present := object[key]
	return present
}

// tokenizeQuery is tokenizeQuery.
func tokenizeQuery(query string) []string {
	parts := strings.Fields(strings.ToLower(query))
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := trimJS(part)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// scoreURL is scoreUrl: the share of query tokens contained in the URL, rounded
// to three decimals.
func scoreURL(value string, tokens []string) *float64 {
	if len(tokens) == 0 {
		return nil
	}
	haystack := strings.ToLower(value)
	hits := 0
	for _, token := range tokens {
		if strings.Contains(haystack, token) {
			hits++
		}
	}
	score := roundTo(float64(hits)/float64(len(tokens)), 3)
	return &score
}

// roundTo rounds to the given number of decimals.
func roundTo(value float64, decimals int) float64 {
	factor := 1.0
	for i := 0; i < decimals; i++ {
		factor *= 10
	}
	return jsRound(value*factor) / factor
}

// buildSeedDiscoveryCacheKey is buildSeedDiscoveryCacheKey: a SHA-1 over the
// exact JSON.stringify fingerprint of the discovery inputs. The key namespaces
// the four modes so the settings invalidation prefixes keep working.
func buildSeedDiscoveryCacheKey(sourceID, sourceURL string, seed *seedConfig, cacheTTLSeconds int) string {
	fingerprintInput := seedDiscoveryFingerprint{
		Mode:                string(seed.Mode),
		SourceURL:           sourceURL,
		Domain:              seed.Domain,
		Pattern:             seed.Pattern,
		FeedURL:             seed.FeedURL,
		MaxURLs:             seed.MaxURLs,
		ListMaxPages:        seed.ListMaxPages,
		ListPageConcurrency: seed.ListPageConcurrency,
		FollowPagination:    seed.FollowPagination,
		QueryTokens:         seed.QueryTokens,
		ScoreThreshold:      seed.ScoreThreshold,
		CacheTTLSeconds:     cacheTTLSeconds,
		CacheTTLPolicy:      string(seed.CacheTTLPolicy),
		Deep:                nil,
	}
	if seed.Deep != nil {
		fingerprintInput.Deep = &seedDiscoveryFingerprintDeep{
			MaxPages:            seed.Deep.MaxPages,
			MaxDepth:            seed.Deep.MaxDepth,
			TimeBudgetSeconds:   seed.Deep.TimeBudgetSeconds,
			PageConcurrency:     seed.Deep.PageConcurrency,
			ScoreThreshold:      seed.Deep.ScoreThreshold,
			CandidatePoolSize:   seed.Deep.CandidatePoolSize,
			HeadFetchTopK:       seed.Deep.HeadFetchTopK,
			PreferPathDate:      seed.Deep.PreferPathDate,
			EnableSecondaryHubs: seed.Deep.EnableSecondaryHubs,
		}
	}
	if fingerprintInput.QueryTokens == nil {
		fingerprintInput.QueryTokens = []string{}
	}
	encoded := mustJSON(fingerprintInput)
	sum := sha1.Sum(encoded)
	return "news-source:" + string(seed.Mode) + ":" + sourceID + ":" + hex.EncodeToString(sum[:])
}

// seedDiscoveryFingerprint is the JSON.stringify object literal order.
type seedDiscoveryFingerprint struct {
	Mode                string                        `json:"mode"`
	SourceURL           string                        `json:"sourceUrl"`
	Domain              *string                       `json:"domain"`
	Pattern             *string                       `json:"pattern"`
	FeedURL             *string                       `json:"feedUrl"`
	MaxURLs             int                           `json:"maxUrls"`
	ListMaxPages        int                           `json:"listMaxPages"`
	ListPageConcurrency int                           `json:"listPageConcurrency"`
	FollowPagination    bool                          `json:"followPagination"`
	QueryTokens         []string                      `json:"queryTokens"`
	ScoreThreshold      float64                       `json:"scoreThreshold"`
	CacheTTLSeconds     int                           `json:"cacheTtlSeconds"`
	CacheTTLPolicy      string                        `json:"cacheTtlPolicy"`
	Deep                *seedDiscoveryFingerprintDeep `json:"deep"`
}

// seedDiscoveryFingerprintDeep is the nested deep object.
type seedDiscoveryFingerprintDeep struct {
	MaxPages            int     `json:"maxPages"`
	MaxDepth            int     `json:"maxDepth"`
	TimeBudgetSeconds   int     `json:"timeBudgetSeconds"`
	PageConcurrency     int     `json:"pageConcurrency"`
	ScoreThreshold      float64 `json:"scoreThreshold"`
	CandidatePoolSize   int     `json:"candidatePoolSize"`
	HeadFetchTopK       int     `json:"headFetchTopK"`
	PreferPathDate      bool    `json:"preferPathDate"`
	EnableSecondaryHubs bool    `json:"enableSecondaryHubs"`
}
