package crawlmetadata

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNormalizeDomainKeepsOrigin(t *testing.T) {
	cases := map[string]string{
		"example.com":                  "https://example.com",
		"HTTPS://Example.COM/path?x=1": "https://example.com",
		"https://example.com:8443/a":   "https://example.com:8443",
		"https://example.com:443/a":    "https://example.com",
	}
	for input, expected := range cases {
		got, ok := normalizeDomain(input)
		if !ok || got != expected {
			t.Fatalf("normalizeDomain(%q) = %q,%v want %q", input, got, ok, expected)
		}
	}
	for _, input := range []string{"", "   ", "ftp://example.com", "https://ftp://example.com"} {
		if got, ok := normalizeDomain(input); ok {
			t.Fatalf("normalizeDomain(%q) = %q want rejection", input, got)
		}
	}
}

func TestNormalizeURLAddsSchemeAndNormalizesListStrictly(t *testing.T) {
	if got, ok := normalizeURL("example.com/sitemap.xml"); !ok || got != "https://example.com/sitemap.xml" {
		t.Fatalf("normalizeURL = %q,%v", got, ok)
	}
	// normalizeUrlList never adds a scheme and drops the unparsable entries.
	list := normalizeURLList([]string{
		"https://Example.com/a",
		"https://example.com/a",
		"example.com/b",
		"ftp://example.com/c",
		"",
	})
	want := []string{"https://example.com/a", "ftp://example.com/c"}
	if len(list) != len(want) {
		t.Fatalf("normalizeURLList = %v want %v", list, want)
	}
	for i := range want {
		if list[i] != want[i] {
			t.Fatalf("normalizeURLList = %v want %v", list, want)
		}
	}
}

func TestNormalizeInputDefaultsAndClamps(t *testing.T) {
	config, err := normalizeInput(ExtractionInput{Source: "urls", URLs: []string{"https://example.com/a"}})
	if err != nil {
		t.Fatal(err)
	}
	if config.maxURLs != 50 || config.concurrency != 5 || config.requestTimeoutMs != 15000 {
		t.Fatalf("defaults = %+v", config)
	}
	if !config.includeJSONLd || !config.includeOpenGraph || !config.includeMeta {
		t.Fatalf("extract switches must default to true: %+v", config)
	}
	if config.scoreThreshold != 0 || config.queryTokens != nil {
		t.Fatalf("score/query defaults = %+v", config)
	}

	zero, ninetyNine, huge := 0, 99, 1000
	disabled := false
	config, err = normalizeInput(ExtractionInput{
		Source:         "urls",
		URLs:           []string{"https://example.com/a"},
		MaxURLs:        &huge,
		Concurrency:    &ninetyNine,
		ExtractJSONLd:  &disabled,
		ScoreThreshold: floatPtr(0.1239),
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.maxURLs != 200 || config.concurrency != 10 {
		t.Fatalf("clamps = %+v", config)
	}
	if config.includeJSONLd {
		t.Fatalf("explicit false must be preserved")
	}
	if config.scoreThreshold != 0.124 {
		t.Fatalf("scoreThreshold = %v", config.scoreThreshold)
	}
	if config, err = normalizeInput(ExtractionInput{Source: "urls", URLs: []string{"https://example.com/a"}, MaxURLs: &zero}); err != nil {
		t.Fatal(err)
	}
	if config.maxURLs != 1 {
		t.Fatalf("maxUrls clamp = %d", config.maxURLs)
	}
}

func TestNormalizeInputRejectsMissingSourceInputs(t *testing.T) {
	if _, err := normalizeInput(ExtractionInput{Source: "sitemap"}); err == nil || err.Error() != "domain is required when source is sitemap" {
		t.Fatalf("sitemap error = %v", err)
	}
	if _, err := normalizeInput(ExtractionInput{Source: "urls"}); err == nil || err.Error() != "urls are required when source is urls" {
		t.Fatalf("urls error = %v", err)
	}
}

func TestNormalizePatternWildcardSemantics(t *testing.T) {
	matcher := normalizePattern("*/news/*")
	if matcher == nil {
		t.Fatal("pattern should be accepted")
	}
	if !matcher("https://example.com/news/one") || matcher("https://example.com/blog/one") {
		t.Fatal("wildcard match mismatch")
	}
	if matcher := normalizePattern(strings.Repeat("a", 513)); matcher != nil {
		t.Fatal("over-long pattern must be ignored")
	}
	if matcher := normalizePattern(strings.Repeat("*", 33)); matcher != nil {
		t.Fatal("too many wildcards must be ignored")
	}
	if matcher := normalizePattern("   "); matcher != nil {
		t.Fatal("blank pattern must not filter")
	}
	if !wildcardMatch("a?c*", "abcdef") || wildcardMatch("a?c", "ac") {
		t.Fatal("? must match exactly one character")
	}
}

func TestTokenizeQueryKeepsDuplicates(t *testing.T) {
	tokens := tokenizeQuery("Alpha  beta alpha")
	want := []string{"alpha", "beta", "alpha"}
	if len(tokens) != len(want) {
		t.Fatalf("tokens = %v", tokens)
	}
	for i := range want {
		if tokens[i] != want[i] {
			t.Fatalf("tokens = %v want %v", tokens, want)
		}
	}
	if tokenizeQuery("") != nil || tokenizeQuery("   ") != nil {
		t.Fatal("blank query must produce no tokens")
	}
}

func TestDiscoveryHTTPStateCacheKey(t *testing.T) {
	key := discoveryHTTPStateCacheKey("https://example.com/sitemap.xml")
	if !strings.HasPrefix(key, "crawl:discover:http-state:") {
		t.Fatalf("key = %q", key)
	}
	if key != discoveryHTTPStateCacheKey("https://example.com/sitemap.xml") {
		t.Fatal("key must be stable")
	}
	if key == discoveryHTTPStateCacheKey("https://example.com/other.xml") {
		t.Fatal("key must depend on the url")
	}
}

func TestDiscoveryHTTPStateRoundTripsSharedShape(t *testing.T) {
	body := "<urlset/>"
	state := discoveryHTTPState{
		ETag:         `"abc"`,
		LastModified: "Mon, 02 Jan 2006 15:04:05 GMT",
		Body:         &body,
		ParsedSitemapPayload: &parsedSitemapPayload{
			URLs: []parsedSitemapURL{{Loc: "https://example.com/a", NewsPublishedAtTs: int64Ptr(1)}},
		},
		UpdatedAt: 42,
	}
	payload, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	// The shared cache contract: the NestJS discovery callers read these keys.
	for _, expected := range []string{`"etag"`, `"lastModified"`, `"body"`, `"parsedSitemapPayload"`, `"newsPublishedAtTs"`, `"childSitemaps"`, `"updatedAt"`} {
		if !strings.Contains(string(payload), expected) {
			t.Fatalf("state payload %s missing %s", payload, expected)
		}
	}
	var decoded discoveryHTTPState
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if cached, ok := decoded.cachedBody(); !ok || cached != body {
		t.Fatalf("decoded body = %v", decoded.Body)
	}
	if decoded.ParsedSitemapPayload == nil || len(decoded.ParsedSitemapPayload.URLs) != 1 {
		t.Fatalf("decoded payload = %+v", decoded.ParsedSitemapPayload)
	}
	if _, ok := (&discoveryHTTPState{}).cachedBody(); ok {
		t.Fatal("an empty state has no cached body")
	}
}

func floatPtr(value float64) *float64 { return &value }
func int64Ptr(value int64) *int64     { return &value }
