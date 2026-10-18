package crawlmetadata

import (
	"math"
	"net"
	"net/url"
	"regexp"
	"strings"
)

// InputError is a 400 input failure. Its message matches the NestJS text: the
// class-validator ValidationPipe output for the REST DTO, or the
// BadRequestException text raised by normalizeInput.
type InputError struct {
	Message string
}

func (e *InputError) Error() string { return e.Message }

// ErrSitemapDomainRequired and ErrURLsRequired are the two normalizeInput
// failures shared by both entries.
var (
	ErrSitemapDomainRequired = &InputError{Message: "domain is required when source is sitemap"}
	ErrURLsRequired          = &InputError{Message: "urls are required when source is urls"}
)

const (
	// maxPatternLength and maxWildcards reject an unusable pattern by ignoring
	// it, exactly like CrawlMetadataService.normalizePattern. The REST DTO
	// additionally caps the raw pattern at 255 characters before it gets here.
	maxPatternLength = 512
	maxWildcards     = 32
	// defaultMaxURLs, defaultConcurrency and requestTimeoutMs are the source
	// defaults. requestTimeoutMs is fixed and not exposed as a parameter.
	defaultMaxURLs      = 50
	defaultConcurrency  = 5
	requestTimeoutMs    = 15_000
	metadataMaxRedirect = 5
)

// defaultSitemapSeeds is DEFAULT_SITEMAP_SEEDS: the ordered common paths tried
// only when robots.txt yields no Sitemap line.
var defaultSitemapSeeds = []string{
	"sitemap.xml",
	"sitemap_index.xml",
	"sitemap-index.xml",
	"sitemap-news.xml",
	"news-sitemap.xml",
	"sitemap_news.xml",
	"sitemap-news-index.xml",
	"news-sitemap-index.xml",
	"wp-sitemap.xml",
	"arc/outboundfeeds/news-sitemap-index/?outputType=xml",
	"arc/outboundfeeds/sitemap-index/?outputType=xml",
}

// normalizeInput resolves source, domain, URL list, pattern, limits, extract
// switches, query tokens and score threshold. It is the single normalization
// shared by the REST and GraphQL entries; their validation differs, the
// resolved configuration does not.
func normalizeInput(input ExtractionInput) (normalizedConfig, error) {
	config := normalizedConfig{
		source:           SourceSitemap,
		requestTimeoutMs: requestTimeoutMs,
	}
	if input.Source == string(SourceURLs) {
		config.source = SourceURLs
	}
	config.domain, _ = normalizeDomain(input.Domain)
	config.urls = normalizeURLList(input.URLs)
	config.patternMatcher = normalizePattern(input.Pattern)
	config.maxURLs = clampNumber(input.MaxURLs, 1, 200, defaultMaxURLs)
	config.includeJSONLd = boolDefault(input.ExtractJSONLd, true)
	config.includeOpenGraph = boolDefault(input.ExtractOpenGraph, true)
	config.includeMeta = boolDefault(input.ExtractStandardMeta, true)
	config.concurrency = clampNumber(input.Concurrency, 1, 10, defaultConcurrency)
	config.queryTokens = tokenizeQuery(input.Query)
	if input.ScoreThreshold != nil && !math.IsNaN(*input.ScoreThreshold) && !math.IsInf(*input.ScoreThreshold, 0) {
		config.scoreThreshold = math.Max(0, math.Min(1, roundTo(*input.ScoreThreshold, 3)))
	}

	if config.source == SourceSitemap && config.domain == "" {
		return normalizedConfig{}, ErrSitemapDomainRequired
	}
	if config.source == SourceURLs && len(config.urls) == 0 {
		return normalizedConfig{}, ErrURLsRequired
	}
	return config, nil
}

// boolDefault implements the `?? true` nullish default: a nil pointer keeps the
// default, an explicit false is preserved.
func boolDefault(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return *value
}

// clampNumber mirrors Math.min(max, Math.max(min, Math.round(value))): a
// non-numeric value (absent or null) keeps the fallback.
func clampNumber(value *int, min, max, fallback int) int {
	if value == nil {
		return fallback
	}
	return minInt(max, maxInt(min, *value))
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// roundTo implements JavaScript's Number(x.toFixed(digits)) for the finite
// positive range the score threshold uses.
func roundTo(value float64, digits int) float64 {
	factor := math.Pow(10, float64(digits))
	return math.Round(value*factor) / factor
}

// tokenizeQuery lowercases the query and splits it on whitespace. Duplicate
// tokens are kept because the relevance denominator is tokens.length.
func tokenizeQuery(query string) []string {
	if query == "" {
		return nil
	}
	tokens := []string{}
	for _, token := range strings.FieldsFunc(strings.ToLower(query), isJSWhitespace) {
		if token != "" {
			tokens = append(tokens, token)
		}
	}
	if len(tokens) == 0 {
		return nil
	}
	return tokens
}

// isJSWhitespace matches the JavaScript \s class closely enough for query
// tokenization: space, tab, newline, carriage return, form feed, vertical tab,
// non-breaking space and the Unicode space separators.
func isJSWhitespace(r rune) bool {
	switch r {
	case ' ', '\t', '\n', '\r', '\f', '\v', '\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	return r >= '\u2000' && r <= '\u200a'
}

// normalizePattern lowercases and validates the wildcard pattern. An over-long
// pattern or too many wildcards is ignored (no error), matching the source.
func normalizePattern(pattern string) func(string) bool {
	trimmed := strings.TrimSpace(pattern)
	if trimmed == "" {
		return nil
	}
	if jsLen(trimmed) > maxPatternLength {
		return nil
	}
	if strings.Count(trimmed, "*")+strings.Count(trimmed, "?") > maxWildcards {
		return nil
	}
	normalized := strings.ToLower(trimmed)
	return func(candidate string) bool {
		return wildcardMatch(normalized, strings.ToLower(candidate))
	}
}

// wildcardMatch is the source wildcard algorithm: '*' matches any run, '?'
// matches exactly one character. It is not a regular expression and not a path
// glob.
func wildcardMatch(pattern, input string) bool {
	patternIndex := 0
	inputIndex := 0
	starIndex := -1
	matchIndex := 0

	for inputIndex < len(input) {
		var patternChar byte
		if patternIndex < len(pattern) {
			patternChar = pattern[patternIndex]
		}
		if patternChar == '?' || patternChar == input[inputIndex] {
			patternIndex++
			inputIndex++
			continue
		}
		if patternChar == '*' {
			starIndex = patternIndex
			matchIndex = inputIndex
			patternIndex++
			continue
		}
		if starIndex != -1 {
			patternIndex = starIndex + 1
			matchIndex++
			inputIndex = matchIndex
			continue
		}
		return false
	}

	for patternIndex < len(pattern) && pattern[patternIndex] == '*' {
		patternIndex++
	}
	return patternIndex == len(pattern)
}

var schemePrefixPattern = regexp.MustCompile(`(?i)^https?://`)

// hasHTTPScheme mirrors /^https?:\/\//i.
func hasHTTPScheme(value string) bool {
	return schemePrefixPattern.MatchString(value)
}

// normalizeDomain mirrors CrawlMetadataService.normalizeDomain: accept a bare
// host or a full URL, add https:// when no scheme is present, and keep only the
// origin (scheme + host + non-default port).
func normalizeDomain(value string) (string, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", false
	}
	candidate := trimmed
	if !hasHTTPScheme(trimmed) {
		candidate = "https://" + trimmed
	}
	parsed, err := url.Parse(candidate)
	if err != nil {
		return "", false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", false
	}
	host, ok := canonicalHost(parsed)
	if !ok {
		return "", false
	}
	return parsed.Scheme + "://" + host, true
}

// canonicalHost lowercases the host, drops the default port and rejects host
// shapes Node's URL parser would refuse (which keeps a scheme/path string from
// being accepted as a REST domain).
func canonicalHost(parsed *url.URL) (string, bool) {
	hostname := strings.ToLower(parsed.Hostname())
	if hostname == "" {
		return "", false
	}
	ipv6 := strings.Contains(hostname, ":")
	if ipv6 {
		// net/url strips the brackets; an IPv6 literal must parse as an IP.
		if net.ParseIP(hostname) == nil {
			return "", false
		}
	} else if !hostPattern.MatchString(hostname) {
		return "", false
	}
	port := parsed.Port()
	if (parsed.Scheme == "http" && port == "80") || (parsed.Scheme == "https" && port == "443") {
		port = ""
	}
	if ipv6 {
		hostname = "[" + hostname + "]"
	}
	if port != "" {
		return hostname + ":" + port, true
	}
	return hostname, true
}

var hostPattern = regexp.MustCompile(`^[a-zA-Z0-9._~%\-]+$`)

// normalizeURL mirrors CrawlMetadataService.normalizeUrl: parse as-is and fall
// back to an https:// prefix. Used for sitemap loc values and robots.txt
// Sitemap lines.
func normalizeURL(value string) (string, bool) {
	trimmed := strings.TrimSpace(removeNodeWhitespace(value))
	if trimmed == "" {
		return "", false
	}
	candidate := trimmed
	if !hasHTTPScheme(trimmed) {
		candidate = "https://" + trimmed
	}
	return canonicalizeURL(candidate)
}

// normalizeURLList mirrors CrawlMetadataService.normalizeUrlList: every entry
// must parse on its own (no https fallback), unparsable entries are dropped and
// the first occurrence wins. Nil means "no usable URLs".
func normalizeURLList(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := map[string]bool{}
	normalized := []string{}
	for _, item := range values {
		if item == "" {
			continue
		}
		parsed, ok := canonicalizeURL(item)
		if !ok || seen[parsed] {
			continue
		}
		seen[parsed] = true
		normalized = append(normalized, parsed)
	}
	if len(normalized) == 0 {
		return nil
	}
	return normalized
}

// canonicalizeURL renders a URL the way Node's new URL(value).toString() does
// for the shapes this chain handles.
func canonicalizeURL(value string) (string, bool) {
	parsed, err := url.Parse(value)
	if err != nil {
		return "", false
	}
	if parsed.Scheme == "" {
		return "", false
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	if parsed.Opaque != "" {
		// mailto:/data: style URLs keep their opaque part; they are kept here
		// and rejected later by the per-hop SSRF check, exactly like the
		// source which only validates the scheme when fetching.
		return parsed.String(), true
	}
	host, ok := canonicalHost(parsed)
	if !ok {
		return "", false
	}
	parsed.Host = host
	if parsed.Path == "" {
		parsed.Path = "/"
	}
	return parsed.String(), true
}

// removeNodeWhitespace drops the tab/newline characters Node's URL parser
// strips before parsing.
func removeNodeWhitespace(value string) string {
	if !strings.ContainsAny(value, "\t\n\r") {
		return value
	}
	return strings.Map(func(r rune) rune {
		switch r {
		case '\t', '\n', '\r':
			return -1
		}
		return r
	}, value)
}

// joinURL is the source joinUrl helper: exactly one slash between the origin
// and the path.
func joinURL(origin, path string) string {
	return strings.TrimRight(origin, "/") + "/" + strings.TrimLeft(path, "/")
}
