package crawlfrontiernode

// metadata_test.go covers the metadata half of the node chain:
//
//   - the crawl-result metadata enrichment persistFrontierResponse performs
//     before it hands the results to CrawlResultService.persistResults
//     (crawl-frontier.service.ts 2478-2510);
//   - buildNodeRuntimeMetadata (2770-2848) and buildCrawlOptionsDiagnostics
//     (2887-2977), the two objects the layered/native branches merge onto the
//     node row;
//   - isCanonicalUrlMatch / resolveCanonicalUrlMatchKey (2850-2885), the
//     self-result selection rule;
//   - estimateFreshnessScore (crawl-frontier.utils.ts 1253-1284);
//   - the candidate budgets and ordering the materialization step depends on
//     (computeFrontierPageTypeBudgets / prioritizeFrontierCandidates in
//     crawl-frontier.utils.ts 1053-1088 / 1192-1215, and
//     CrawlFrontierLlmService.resolveCandidateBudget, crawl-frontier-llm.service.ts
//     642-660).
//
// Everything here is DB-free: the Service value only carries the clock.

import (
	"encoding/json"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
	"github.com/wei500L/newwei/apps/api-go/internal/crawloptions"
)

// testDiagnosticsTail is the nine buildCrawlOptionsDiagnostics members in the
// NestJS literal order, all null for a profile without layered overrides.
const testDiagnosticsTail = `"linkPreviewMode":null,"linkPreviewQuery":null,"domScopeMode":null,` +
	`"waitForMode":null,"markdownFilterMode":null,"markdownFilterType":null,` +
	`"localeMode":null,"localeValue":null,"acceptLanguageMode":null`

// testMarshalObject renders an ordered object for byte comparison.
func testMarshalObject(t *testing.T, object *crawlfrontierllm.Object) string {
	t.Helper()
	if object == nil {
		t.Fatal("object is nil")
	}
	encoded, err := object.MarshalJSON()
	if err != nil {
		t.Fatalf("marshal object: %v", err)
	}
	return string(encoded)
}

func TestCreatePageTypeCountRecord(t *testing.T) {
	// createPageTypeCountRecord (:2548-2556) is
	// `{home: 0, category: 0, list: 0, article: 0}`. The key order is the
	// persisted JSON order of the counters that end up in the run metadata.
	counts := createPageTypeCountRecord()
	want := `{"home":0,"category":0,"list":0,"article":0}`
	if got := testMarshalObject(t, counts); got != want {
		t.Fatalf("page type counts = %s, want %s", got, want)
	}
	if counts.Len() != 4 {
		t.Fatalf("key count = %d, want 4", counts.Len())
	}
}

func TestEstimateFreshnessScorePathDateBands(t *testing.T) {
	// estimateFreshnessScore (crawl-frontier.utils.ts 1253-1284) only reads the
	// /YYYY/M/D/ path segment; a URL without it scores 0 whatever the clock is.
	// The package-level helper uses the wall clock (metadata.go), so the cases
	// here are the clock-independent ones; the band boundaries themselves are
	// covered through buildNodeRuntimeMetadata with the pinned service clock.
	cases := []struct {
		name string
		url  string
		want float64
	}{
		{"no date segment", "https://example.com/news/world", 0},
		{"date without trailing slash", "https://example.com/2025/03/04", 0},
		{"future date is the freshest band", "https://example.com/2999/01/01/story", 1},
		{"2000 date is the stale band", "https://example.com/2000/01/01/story", 0.1},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := estimateFreshnessScore(testCase.url, nil); got != testCase.want {
				t.Fatalf("estimateFreshnessScore(%q) = %v, want %v", testCase.url, got, testCase.want)
			}
		})
	}
}

func TestBuildNodeRuntimeMetadataKeyOrder(t *testing.T) {
	// buildNodeRuntimeMetadata (:2770-2848) returns the literal
	//
	//	{sourceTier, failureKind?, warningFlags, httpStatus, crawlError,
	//	 freshnessBucket, discoveryPath, frontierPath, canonicalUrl?,
	//	 urlFingerprint?, ...crawlOptionsDiagnostics}
	//
	// where `failureKind`, `canonicalUrl` and `urlFingerprint` are `string |
	// undefined` (the key disappears when NestJS has no value) while
	// httpStatus/crawlError are always present and explicitly null when absent.
	// The byte-for-byte expectations below are exactly the difference between
	// "undefined" (dropped) and null (kept).
	service := testService()
	cases := []struct {
		name     string
		nodeURL  string
		pageType string
		metadata string
		config   string
		results  []crawl4ai.PipelineArticle
		self     string
		want     string
	}{
		{
			name:     "successful self result",
			nodeURL:  "https://example.com",
			pageType: "home",
			config:   `{"sourceTier":"tier1"}`,
			results:  []crawl4ai.PipelineArticle{{URL: "https://example.com", StatusCode: testIntPointer(200)}},
			want: `{"sourceTier":"tier1","warningFlags":[],"httpStatus":200,"crawlError":null,` +
				`"freshnessBucket":"unknown","discoveryPath":["home"],"frontierPath":["home"],` +
				testDiagnosticsTail + `}`,
		},
		{
			name:     "challenge status is classified without a crawl error",
			nodeURL:  "https://example.com",
			pageType: "home",
			results:  []crawl4ai.PipelineArticle{{URL: "https://example.com", StatusCode: testIntPointer(403)}},
			want: `{"sourceTier":"tier2","failureKind":"challenge_detected",` +
				`"warningFlags":["challenge_detected","http_403"],"httpStatus":403,"crawlError":null,` +
				`"freshnessBucket":"unknown","discoveryPath":["home"],"frontierPath":["home"],` +
				testDiagnosticsTail + `}`,
		},
		{
			name:     "crawl error text is classified",
			nodeURL:  "https://example.com",
			pageType: "home",
			results: []crawl4ai.PipelineArticle{{
				URL: "https://example.com", Error: "captcha required before content",
			}},
			want: `{"sourceTier":"tier2","failureKind":"challenge_detected",` +
				`"warningFlags":["challenge_detected"],"httpStatus":null,` +
				`"crawlError":"captcha required before content","freshnessBucket":"unknown",` +
				`"discoveryPath":["home"],"frontierPath":["home"],` + testDiagnosticsTail + `}`,
		},
		{
			name:     "no result belongs to the node",
			nodeURL:  "https://example.com",
			pageType: "home",
			results:  []crawl4ai.PipelineArticle{{URL: "https://example.com/other", StatusCode: testIntPointer(200)}},
			want: `{"sourceTier":"tier2","warningFlags":["self_result_mismatch"],` +
				`"httpStatus":null,"crawlError":null,"freshnessBucket":"unknown",` +
				`"discoveryPath":["home"],"frontierPath":["home"],` + testDiagnosticsTail + `}`,
		},
		{
			name:     "paths come from the node metadata and self metadata is appended",
			nodeURL:  "https://example.com",
			pageType: "category",
			metadata: `{"discoveryPath":["home","category"],"frontierPath":["home","/news/"]}`,
			self:     `{"canonicalUrl":"https://example.com/news","urlFingerprint":"fp-1"}`,
			results:  []crawl4ai.PipelineArticle{{URL: "https://example.com", StatusCode: testIntPointer(200)}},
			want: `{"sourceTier":"tier2","warningFlags":[],"httpStatus":200,"crawlError":null,` +
				`"freshnessBucket":"unknown","discoveryPath":["home","category"],` +
				`"frontierPath":["home","/news/"],"canonicalUrl":"https://example.com/news",` +
				`"urlFingerprint":"fp-1",` + testDiagnosticsTail + `}`,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			input := nodeRuntimeMetadataInput{
				Node: &crawlfrontierllm.NodeRecord{
					ID: "node-1", URL: testCase.nodeURL, PageType: testCase.pageType,
				},
				Response: crawl4ai.PipelineResponse{Results: testCase.results},
			}
			if testCase.config != "" {
				input.Profile = &crawlfrontierllm.ProfileRecord{Config: testObject(t, testCase.config)}
			}
			if testCase.metadata != "" {
				input.Node.Metadata = testObject(t, testCase.metadata)
			}
			if testCase.self != "" {
				input.SelfMetadata = testObject(t, testCase.self)
			}
			metadata := service.buildNodeRuntimeMetadata(input)
			if got := testMarshalObject(t, metadata); got != testCase.want {
				t.Fatalf("runtime metadata = %s\nwant = %s", got, testCase.want)
			}
		})
	}
}

func TestBuildNodeRuntimeMetadataFreshnessBucket(t *testing.T) {
	// The band boundaries come from estimateFreshnessScore with the service
	// clock (2025-03-04T05:06:07.891Z): <=24h -> 1/24h, <=168h -> 0.75/7d,
	// <=720h -> 0.4/30d, otherwise 0.1/stale and 0/unknown without a date.
	service := testService()
	cases := []struct {
		name    string
		nodeURL string
		want    string
	}{
		{"same day", "https://example.com/2025/03/04/story", "24h"},
		{"three days old", "https://example.com/2025/03/01/story", "7d"},
		{"twelve days old", "https://example.com/2025/02/20/story", "30d"},
		{"three months old", "https://example.com/2024/12/01/story", "stale"},
		{"no date", "https://example.com/news", "unknown"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			metadata := service.buildNodeRuntimeMetadata(nodeRuntimeMetadataInput{
				Node: &crawlfrontierllm.NodeRecord{ID: "node-1", URL: testCase.nodeURL, PageType: "article"},
				Response: crawl4ai.PipelineResponse{Results: []crawl4ai.PipelineArticle{{
					URL: testCase.nodeURL, StatusCode: testIntPointer(200),
				}}},
			})
			bucket, ok := metadata.String("freshnessBucket")
			if !ok {
				t.Fatalf("freshnessBucket missing: %s", testMarshalObject(t, metadata))
			}
			if bucket != testCase.want {
				t.Fatalf("freshnessBucket = %q, want %q", bucket, testCase.want)
			}
		})
	}
}

func TestBuildCrawlOptionsDiagnostics(t *testing.T) {
	// buildCrawlOptionsDiagnostics (:2887-2977) reports, for each layered option,
	// whether it came from the profile ("manual") or from the automatic builder
	// ("auto"), plus the resolved values. All nine members are `string | null`,
	// so all nine keys are always present and null when the option is unused.
	service := testService()
	cases := []struct {
		name         string
		config       string
		pageType     string
		crawlOptions layeredCrawlOptions
		want         string
	}{
		{
			name:     "no options resolved",
			pageType: "home",
			want: `{"linkPreviewMode":null,"linkPreviewQuery":null,"domScopeMode":null,` +
				`"waitForMode":null,"markdownFilterMode":null,"markdownFilterType":null,` +
				`"localeMode":null,"localeValue":null,"acceptLanguageMode":null}`,
		},
		{
			name:     "automatic link preview keeps the trimmed query",
			pageType: "home",
			crawlOptions: layeredCrawlOptions{
				LinkPreview: &layeredLinkPreview{Query: " relevant news "},
			},
			want: `{"linkPreviewMode":"auto","linkPreviewQuery":"relevant news","domScopeMode":null,` +
				`"waitForMode":null,"markdownFilterMode":null,"markdownFilterType":null,` +
				`"localeMode":null,"localeValue":null,"acceptLanguageMode":null}`,
		},
		{
			name:     "profile link preview is manual",
			pageType: "home",
			config:   `{"pageRules":{"home":{"linkPreview":{}}}}`,
			crawlOptions: layeredCrawlOptions{
				LinkPreview: &layeredLinkPreview{Query: "news"},
			},
			want: `{"linkPreviewMode":"manual","linkPreviewQuery":"news","domScopeMode":null,` +
				`"waitForMode":null,"markdownFilterMode":null,"markdownFilterType":null,` +
				`"localeMode":null,"localeValue":null,"acceptLanguageMode":null}`,
		},
		{
			name:     "automatic dom scope, wait and markdown filter",
			pageType: "category",
			config:   `{}`,
			crawlOptions: layeredCrawlOptions{
				CSSSelector: "main", WaitForSelector: "#app", WaitForScript: "window.ready()",
				MarkdownFilter: &layeredMarkdownFilter{Type: "pruning"}, Locale: " en-US ",
			},
			want: `{"linkPreviewMode":null,"linkPreviewQuery":null,"domScopeMode":"auto",` +
				`"waitForMode":"auto","markdownFilterMode":"auto","markdownFilterType":"pruning",` +
				`"localeMode":"auto","localeValue":"en-US","acceptLanguageMode":null}`,
		},
		{
			name:     "profile overrides are manual",
			pageType: "category",
			config: `{"crawlOptions":{"cssSelector":"main","waitForScript":"go()",` +
				`"markdownFilter":{},"locale":"en"}}`,
			crawlOptions: layeredCrawlOptions{
				CSSSelector: "main", WaitForScript: "go()",
				MarkdownFilter: &layeredMarkdownFilter{Type: "pruning"}, Locale: "en",
			},
			want: `{"linkPreviewMode":null,"linkPreviewQuery":null,"domScopeMode":"manual",` +
				`"waitForMode":"manual","markdownFilterMode":"manual","markdownFilterType":"pruning",` +
				`"localeMode":"manual","localeValue":"en","acceptLanguageMode":null}`,
		},
		{
			name:     "resolved accept-language header is automatic",
			pageType: "home",
			crawlOptions: layeredCrawlOptions{
				BrowserHeaders: []crawloptions.BrowserHeader{{Name: "accept-language", Value: "en-US"}},
			},
			want: `{"linkPreviewMode":null,"linkPreviewQuery":null,"domScopeMode":null,` +
				`"waitForMode":null,"markdownFilterMode":null,"markdownFilterType":null,` +
				`"localeMode":null,"localeValue":null,"acceptLanguageMode":"auto"}`,
		},
		{
			name:     "profile accept-language header is manual",
			pageType: "home",
			config:   `{"crawlOptions":{"browserHeaders":[{"name":"Accept-Language","value":"en"}]}}`,
			crawlOptions: layeredCrawlOptions{
				BrowserHeaders: []crawloptions.BrowserHeader{{Name: "accept-language", Value: "en-US"}},
			},
			want: `{"linkPreviewMode":null,"linkPreviewQuery":null,"domScopeMode":null,` +
				`"waitForMode":null,"markdownFilterMode":null,"markdownFilterType":null,` +
				`"localeMode":null,"localeValue":null,"acceptLanguageMode":"manual"}`,
		},
		{
			name:     "an empty header value is not a manual override",
			pageType: "home",
			config:   `{"crawlOptions":{"browserHeaders":[{"name":"accept-language","value":""}]}}`,
			crawlOptions: layeredCrawlOptions{
				BrowserHeaders: []crawloptions.BrowserHeader{{Name: "accept-language", Value: ""}},
			},
			want: `{"linkPreviewMode":null,"linkPreviewQuery":null,"domScopeMode":null,` +
				`"waitForMode":null,"markdownFilterMode":null,"markdownFilterType":null,` +
				`"localeMode":null,"localeValue":null,"acceptLanguageMode":"auto"}`,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			var config *crawlfrontierllm.Object
			if testCase.config != "" {
				config = testObject(t, testCase.config)
			}
			diagnostics := service.buildCrawlOptionsDiagnostics(config, testCase.pageType, testCase.crawlOptions)
			if got := testMarshalObject(t, diagnostics); got != testCase.want {
				t.Fatalf("diagnostics = %s\nwant = %s", got, testCase.want)
			}
		})
	}
}

func TestIsCanonicalURLMatch(t *testing.T) {
	// isCanonicalUrlMatch (:2858-2885): compare the canonical fingerprints
	// (query parameters outside the allowlist stripped) and fall back to plain
	// trimmed equality when either side has no fingerprint. A null/undefined
	// side is the empty string and never matches.
	service := testService()
	cases := []struct {
		name      string
		sourceURL string
		nodeURL   string
		config    string
		configNil bool
		want      bool
	}{
		{name: "identical urls", sourceURL: "https://example.com/a", nodeURL: "https://example.com/a", configNil: true, want: true},
		{name: "trailing slash is normalized", sourceURL: "https://example.com/a/", nodeURL: "https://example.com/a", configNil: true, want: true},
		{name: "host case is normalized", sourceURL: "https://Example.COM/a", nodeURL: "https://example.com/a", configNil: true, want: true},
		{name: "fragment is dropped", sourceURL: "https://example.com/a#top", nodeURL: "https://example.com/a", configNil: true, want: true},
		{name: "non allowlisted query is stripped", sourceURL: "https://example.com/a?utm_source=x", nodeURL: "https://example.com/a", configNil: true, want: true},
		{name: "allowlisted query differs", sourceURL: "https://example.com/a?page=2", nodeURL: "https://example.com/a?page=3", configNil: true, want: false},
		{name: "different path", sourceURL: "https://example.com/a", nodeURL: "https://example.com/b", configNil: true, want: false},
		{name: "empty source", sourceURL: "", nodeURL: "https://example.com/a", configNil: true, want: false},
		{name: "empty node", sourceURL: "https://example.com/a", nodeURL: "", configNil: true, want: false},
		{name: "unparseable source falls back to equality", sourceURL: "not a url", nodeURL: "https://example.com/a", configNil: true, want: false},
		{
			name:      "profile allowlist widens the comparison",
			sourceURL: "https://example.com/a?ref=1",
			nodeURL:   "https://example.com/a",
			config:    `{"urlQueryParamAllowlist":[]}`,
			want:      true,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			var config *crawlfrontierllm.Object
			if !testCase.configNil {
				config = testObject(t, testCase.config)
			}
			if got := service.isCanonicalURLMatch(testCase.sourceURL, testCase.nodeURL, config); got != testCase.want {
				t.Fatalf("isCanonicalURLMatch(%q, %q) = %v, want %v", testCase.sourceURL, testCase.nodeURL, got, testCase.want)
			}
		})
	}
}

func TestResolveCanonicalURLMatchKey(t *testing.T) {
	// resolveCanonicalUrlMatchKey (:2850-2857) is
	// `fingerprint?.fingerprint ?? fingerprint?.canonicalUrl ?? null`; an
	// unparseable URL has no fingerprint at all and resolves to nil (the NestJS
	// null).
	service := testService()
	key := service.resolveCanonicalURLMatchKey("https://example.com/a/", nil)
	if key == nil {
		t.Fatal("canonical key is nil for a parseable URL")
	}
	if len(*key) != 64 {
		t.Fatalf("fingerprint length = %d, want 64 hex characters", len(*key))
	}
	if other := service.resolveCanonicalURLMatchKey("https://example.com/a", nil); other == nil || *other != *key {
		t.Fatalf("the trailing slash must not change the key: %v vs %v", other, key)
	}
	if diff := service.resolveCanonicalURLMatchKey("https://example.com/b", nil); diff == nil || *diff == *key {
		t.Fatalf("a different path must produce a different key: %v", diff)
	}
	if empty := service.resolveCanonicalURLMatchKey("not a url", nil); empty != nil {
		t.Fatalf("an unparseable URL must resolve to nil, got %q", *empty)
	}
}

func TestFrontierResultMetadataAppendsKeys(t *testing.T) {
	// persistFrontierResponse (:2478-2510) enriches every crawl4ai result with
	//
	//	metadata: {...(result.metadata ?? {}), frontierRunId, frontierNodeId,
	//	           frontierPageType, frontierDepth, frontierExecutionMode}
	//
	// The enrichment is inline in record.go (a ParseObject -> Clone -> Set
	// sequence), so there is no helper to call; the test performs exactly those
	// operations and locks the three object-spread properties the persisted JSON
	// depends on:
	//
	//  1. the frontier keys are appended after the original keys;
	//  2. a pre-existing same-name key keeps its position and takes the new value
	//     (`{...base, frontierNodeId}` replaces in place);
	//  3. unknown keys survive untouched.
	//
	// MySQL JSON columns re-serialize objects sorted by key, so the byte order
	// below is the contract of the *pre-insert* document; the integration test
	// asserts the persisted values (MySQL normalizes the order).
	cases := []struct {
		name     string
		metadata string
		want     string
	}{
		{
			name:     "missing metadata behaves like an empty object",
			metadata: "",
			want: `{"frontierRunId":"run-1","frontierNodeId":"node-9","frontierPageType":"home",` +
				`"frontierDepth":0,"frontierExecutionMode":"layered"}`,
		},
		{
			name:     "non object metadata behaves like an empty object",
			metadata: `"just a string"`,
			want: `{"frontierRunId":"run-1","frontierNodeId":"node-9","frontierPageType":"home",` +
				`"frontierDepth":0,"frontierExecutionMode":"layered"}`,
		},
		{
			name:     "original keys keep their order and unknown keys survive",
			metadata: `{"title":"Hello","nested":{"a":1},"tags":["x","y"]}`,
			want: `{"title":"Hello","nested":{"a":1},"tags":["x","y"],"frontierRunId":"run-1",` +
				`"frontierNodeId":"node-9","frontierPageType":"home","frontierDepth":0,` +
				`"frontierExecutionMode":"layered"}`,
		},
		{
			name:     "a pre-existing frontier key keeps its position",
			metadata: `{"title":"Hello","frontierNodeId":"stale","unknownKey":true}`,
			want: `{"title":"Hello","frontierNodeId":"node-9","unknownKey":true,"frontierRunId":"run-1",` +
				`"frontierPageType":"home","frontierDepth":0,"frontierExecutionMode":"layered"}`,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			// The exact record.go sequence.
			metadata := crawlfrontierllm.NewObject()
			if existing, ok := crawlfrontierllm.ParseObject(json.RawMessage(testCase.metadata)); ok {
				metadata = existing.Clone()
			}
			metadata.Set("frontierRunId", "run-1")
			metadata.Set("frontierNodeId", "node-9")
			metadata.Set("frontierPageType", "home")
			metadata.Set("frontierDepth", 0)
			metadata.Set("frontierExecutionMode", "layered")
			if got := testMarshalObject(t, metadata); got != testCase.want {
				t.Fatalf("enriched metadata = %s\nwant = %s", got, testCase.want)
			}
		})
	}

	// The same spread semantics through the package merge helper the rest of the
	// chain uses for ordered merges: base keys first, overrides replaced in
	// place, new keys appended.
	base := testObject(t, `{"url":"https://example.com","pageType":"home","extra":1}`)
	override := testObject(t, `{"pageType":"category","eventKey":"e-1"}`)
	merged := crawlfrontierllm.MergeObjects(base, override)
	want := `{"url":"https://example.com","pageType":"category","extra":1,"eventKey":"e-1"}`
	if got := testMarshalObject(t, merged); got != want {
		t.Fatalf("merged = %s, want %s", got, want)
	}
}

func TestComputeFrontierPageTypeBudgets(t *testing.T) {
	// computeFrontierPageTypeBudgets (crawl-frontier.utils.ts 1053-1088) reserves
	// one home node, then one node per active page type in category/list/article
	// order, then round-robins the rest over PAGE_TYPE_BUDGET_PRIORITY
	// (article, category, list). The materialization compares it against the
	// existing node counts, so these numbers decide how many children a node
	// spawns per page type.
	cases := []struct {
		name     string
		maxDepth int
		maxPages int
		want     string
	}{
		{"no depth", 0, 10, `{"home":1,"category":0,"list":0,"article":0}`},
		{"no pages", 3, 0, `{"home":0,"category":0,"list":0,"article":0}`},
		{"one page only covers home", 3, 1, `{"home":1,"category":0,"list":0,"article":0}`},
		{"category only run", 1, 5, `{"home":1,"category":4,"list":0,"article":0}`},
		{"category and list round robin", 2, 5, `{"home":1,"category":2,"list":2,"article":0}`},
		{"depth two with two pages", 2, 2, `{"home":1,"category":1,"list":0,"article":0}`},
		{"full run", 3, 10, `{"home":1,"category":3,"list":3,"article":3}`},
		{"full depth with few pages", 3, 3, `{"home":1,"category":1,"list":1,"article":0}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			budgets := crawlfrontierllm.ComputeFrontierPageTypeBudgets(testCase.maxDepth, testCase.maxPages)
			object := crawlfrontierllm.NewObject()
			object.SetNumber("home", float64(budgets.Home))
			object.SetNumber("category", float64(budgets.Category))
			object.SetNumber("list", float64(budgets.List))
			object.SetNumber("article", float64(budgets.Article))
			if got := testMarshalObject(t, object); got != testCase.want {
				t.Fatalf("budgets = %s, want %s", got, testCase.want)
			}
		})
	}
}

func TestResolveCandidateBudget(t *testing.T) {
	// resolveCandidateBudget (crawl-frontier-llm.service.ts 642-660): a
	// configured per-page-type budget is Math.round'ed and clamped to [0,64];
	// otherwise list defaults to 16, article to 0 and every other page type to
	// 24. The node chain uses it as the LLM candidate budget, not as the node
	// budget.
	configured := &crawlfrontierllm.LlmAssist{
		CandidateBudgetByPageType: testObject(t,
			`{"home":8,"category":100,"list":-3,"article":12.6}`),
	}
	cases := []struct {
		name     string
		assist   *crawlfrontierllm.LlmAssist
		pageType string
		want     int
	}{
		{"configured home", configured, "home", 8},
		{"configured category is clamped to 64", configured, "category", 64},
		{"configured list is clamped to 0", configured, "list", 0},
		{"configured article is rounded", configured, "article", 13},
		{"unconfigured list", &crawlfrontierllm.LlmAssist{}, "list", 16},
		{"unconfigured article", &crawlfrontierllm.LlmAssist{}, "article", 0},
		{"unconfigured home", &crawlfrontierllm.LlmAssist{}, "home", 24},
		{"unconfigured category", &crawlfrontierllm.LlmAssist{}, "category", 24},
		{"nil assist home", nil, "home", 24},
		{"nil assist list", nil, "list", 16},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := crawlfrontierllm.ResolveCandidateBudget(testCase.assist, testCase.pageType); got != testCase.want {
				t.Fatalf("ResolveCandidateBudget(%q) = %d, want %d", testCase.pageType, got, testCase.want)
			}
		})
	}
}

func TestPrioritizeCandidates(t *testing.T) {
	// prioritizeFrontierCandidates (crawl-frontier.utils.ts 1192-1215) sorts by
	// page-type rank from PAGE_TYPE_DISCOVERY_PRIORITY[parent], then score desc,
	// then freshness desc, then url localeCompare. The materialization walks the
	// result in order, so this ordering is the node creation order.
	candidates := []crawlfrontierllm.Candidate{
		{URL: "https://example.com/article/1", PageType: "article", Score: 0.9},
		{URL: "https://example.com/world", PageType: "category", Score: 0.5},
		{URL: "https://example.com/tech", PageType: "category", Score: 0.5},
		{URL: "https://example.com/latest", PageType: "list", Score: 0.5},
		{URL: "https://example.com", PageType: "home", Score: 0.99},
	}
	order := func(values []crawlfrontierllm.Candidate) []string {
		urls := make([]string, 0, len(values))
		for _, value := range values {
			urls = append(urls, value.URL)
		}
		return urls
	}
	cases := []struct {
		name           string
		parentPageType string
		want           []string
	}{
		{
			name:           "home parent prefers category then list then article",
			parentPageType: "home",
			want: []string{
				"https://example.com/tech", "https://example.com/world",
				"https://example.com/latest", "https://example.com/article/1",
				"https://example.com",
			},
		},
		{
			name:           "category parent prefers list then article",
			parentPageType: "category",
			want: []string{
				"https://example.com/latest", "https://example.com/article/1",
				"https://example.com/tech", "https://example.com/world",
				"https://example.com",
			},
		},
		{
			name:           "unknown parent falls back to the article priority",
			parentPageType: "unknown",
			want: []string{
				"https://example.com/article/1", "https://example.com/latest",
				"https://example.com/tech", "https://example.com/world",
				"https://example.com",
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			prioritized := crawlfrontierllm.PrioritizeCandidates(testCase.parentPageType, candidates)
			got := order(prioritized)
			if len(got) != len(testCase.want) {
				t.Fatalf("prioritized = %v, want %v", got, testCase.want)
			}
			for index := range got {
				if got[index] != testCase.want[index] {
					t.Fatalf("prioritized = %v, want %v", got, testCase.want)
				}
			}
			// The helper sorts a copy: the caller's slice keeps its order.
			if candidates[0].URL != "https://example.com/article/1" {
				t.Fatalf("input slice was reordered: %v", order(candidates))
			}
		})
	}
}

// testIntPointer returns a pointer to value for the optional crawl4ai fields.
func testIntPointer(value int) *int { return &value }
