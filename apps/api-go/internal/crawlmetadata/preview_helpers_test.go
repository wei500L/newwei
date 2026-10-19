package crawlmetadata

import (
	"encoding/json"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
)

// These tests cover the pure preview helpers that do not need MySQL: the seed
// configuration normalization, the workflow overlay merge and the deep failure
// statistics normalization. The full preview (news source/template/pipeline
// reads) is covered by the MySQL integration test.

func TestNormalizeSeedConfigDisabledOrMissing(t *testing.T) {
	if got := normalizeSeedConfig(nil, "https://news.example.com/"); got != nil {
		t.Fatalf("nil config = %+v", got)
	}
	if got := normalizeSeedConfig(json.RawMessage(`{"seed":{"mode":"rss"}}`), "https://news.example.com/"); got != nil {
		t.Fatalf("seed without enabled must be nil: %+v", got)
	}
	if got := normalizeSeedConfig(json.RawMessage(`{"seed":{"enabled":false}}`), "https://news.example.com/"); got != nil {
		t.Fatalf("disabled seed must be nil: %+v", got)
	}
}

func TestNormalizeSeedConfigRSSDefaults(t *testing.T) {
	raw := json.RawMessage(`{
	  "keywords": ["alpha", "beta"],
	  "seed": {"enabled": true, "mode": "RSS", "maxUrls": 5000, "dedupeWindowHours": -5, "rssFetch": {"bodySourceStrategy": "SUMMARY_ONLY"}}
	}`)
	seed := normalizeSeedConfig(raw, "https://news.example.com/feed.xml")
	if seed == nil {
		t.Fatal("seed missing")
	}
	if seed.Mode != SeedModeRSS {
		t.Errorf("mode = %q", seed.Mode)
	}
	if seed.MaxURLs != 2000 {
		t.Errorf("maxUrls = %d (clamped to 2000)", seed.MaxURLs)
	}
	if seed.DedupeWindowHours != 0 {
		t.Errorf("dedupeWindowHours = %d", seed.DedupeWindowHours)
	}
	if seed.Domain != nil {
		t.Errorf("rss mode must not set domain: %v", seed.Domain)
	}
	if seed.FeedURL == nil || *seed.FeedURL != "https://news.example.com/feed.xml" {
		t.Errorf("feedUrl = %v", seed.FeedURL)
	}
	if seed.Query == nil || *seed.Query != "alpha beta" {
		t.Errorf("query falls back to the keywords: %v", seed.Query)
	}
	if seed.RSSFetch == nil || !seed.RSSFetch.Enabled {
		t.Fatalf("rssFetch = %+v", seed.RSSFetch)
	}
	if seed.RSSFetch.BodySourceStrategy != RSSBodySourceSummaryOnly {
		t.Errorf("bodySourceStrategy = %q", seed.RSSFetch.BodySourceStrategy)
	}
	if seed.RSSFetch.NoBodyPolicy != RSSNoBodyPolicySkip {
		t.Errorf("noBodyPolicy = %q", seed.RSSFetch.NoBodyPolicy)
	}
}

func TestNormalizeSeedConfigListAndDeep(t *testing.T) {
	listRaw := json.RawMessage(`{"seed":{"enabled":true,"mode":"list","pattern":" *2026* ","domain":"news.example.com","followPagination":false,"maxNewUrlsPerRun":10}}`)
	list := normalizeSeedConfig(listRaw, "https://news.example.com/list")
	if list == nil || list.Mode != SeedModeList {
		t.Fatalf("list = %+v", list)
	}
	if list.Domain == nil || *list.Domain != "https://news.example.com" {
		t.Errorf("domain = %v", list.Domain)
	}
	if list.Pattern == nil || *list.Pattern != "*2026*" {
		t.Errorf("pattern = %v", list.Pattern)
	}
	if list.FollowPagination {
		t.Error("followPagination must honor an explicit false")
	}
	if list.MaxNewURLsPerRun != 10 {
		t.Errorf("maxNewUrlsPerRun = %d", list.MaxNewURLsPerRun)
	}
	if list.Deep != nil {
		t.Errorf("deep only belongs to deep mode: %+v", list.Deep)
	}

	deepRaw := json.RawMessage(`{"seed":{"enabled":true,"mode":"deep","query":" markets ","deep":{"maxPages":9999,"maxDepth":9,"scoreThreshold":1.7,"enableSecondaryHubs":false}}}`)
	deep := normalizeSeedConfig(deepRaw, "https://news.example.com/")
	if deep == nil || deep.Mode != SeedModeDeep {
		t.Fatalf("deep = %+v", deep)
	}
	if deep.Query == nil || *deep.Query != "markets" {
		t.Errorf("query = %v", deep.Query)
	}
	if deep.Deep == nil {
		t.Fatal("deep config missing")
	}
	if deep.Deep.MaxPages != 300 {
		t.Errorf("maxPages = %d", deep.Deep.MaxPages)
	}
	if deep.Deep.MaxDepth != 4 {
		t.Errorf("maxDepth = %d", deep.Deep.MaxDepth)
	}
	if deep.Deep.ScoreThreshold != 1 {
		t.Errorf("scoreThreshold = %v", deep.Deep.ScoreThreshold)
	}
	if deep.Deep.EnableSecondaryHubs {
		t.Error("enableSecondaryHubs must honor false")
	}
	if !deep.Deep.PreferPathDate || !deep.Deep.IgnoreRobotsTxt {
		t.Errorf("defaults = %+v", deep.Deep)
	}
}

func TestNormalizeSeedConfigSitemapDefaults(t *testing.T) {
	seed := normalizeSeedConfig(json.RawMessage(`{"seed":{"enabled":true}}`), "https://news.example.com/")
	if seed == nil || seed.Mode != SeedModeSitemap {
		t.Fatalf("seed = %+v", seed)
	}
	if seed.MaxURLs != 200 || seed.MaxNewURLsPerRun != 80 || seed.ListMaxPages != 6 || seed.Concurrency != 5 || seed.DedupeWindowHours != 24 {
		t.Fatalf("defaults = %+v", seed)
	}
	if seed.Domain == nil || *seed.Domain != "https://news.example.com" {
		t.Errorf("domain = %v", seed.Domain)
	}
	if !seed.FollowPagination {
		t.Error("followPagination defaults to true")
	}
	if seed.QueryParamAllowlist == nil || len(seed.QueryParamAllowlist) != 0 {
		t.Errorf("queryParamAllowlist = %v", seed.QueryParamAllowlist)
	}
}

func TestMergeWorkflowSourceConfigOverlayWins(t *testing.T) {
	base := json.RawMessage(`{"keywords":["old"],"crawlOptions":{"check_robots_txt":false,"locale":"en"},"seed":{"mode":"sitemap","maxUrls":10}}`)
	if got := string(mergeWorkflowSourceConfig(base, nil)); got != string(base) {
		t.Fatalf("a nil overlay must return the config untouched: %s", got)
	}
	overlay := &crawlworkflow.CompiledNewsSourceOverlay{
		CrawlOptions: json.RawMessage(`{"check_robots_txt":true}`),
		Seed:         json.RawMessage(`{"mode":"list","maxUrls":60}`),
		Keywords:     []string{"new"},
	}
	config, ok := decodeRawObject(mergeWorkflowSourceConfig(base, overlay))
	if !ok {
		t.Fatalf("merged config is not an object")
	}
	var keywords []string
	if err := json.Unmarshal(config["keywords"], &keywords); err != nil || len(keywords) != 1 || keywords[0] != "new" {
		t.Errorf("keywords = %v (%v)", keywords, err)
	}
	crawlOptions, _ := decodeRawObject(config["crawlOptions"])
	if string(crawlOptions["check_robots_txt"]) != "true" || string(crawlOptions["locale"]) != `"en"` {
		t.Errorf("crawlOptions = %s", config["crawlOptions"])
	}
	seed, _ := decodeRawObject(config["seed"])
	if string(seed["mode"]) != `"list"` || string(seed["maxUrls"]) != "60" {
		t.Errorf("seed = %s", config["seed"])
	}
}

func TestPreviewTimestampSourceOrder(t *testing.T) {
	published := "2026-10-19T00:00:00.000Z"
	crawled := "2026-10-20T00:00:00.000Z"
	if got := previewTimestampSource(&published, &crawled); got != TimestampSourcePublished {
		t.Errorf("published first: %s", got)
	}
	if got := previewTimestampSource(nil, &crawled); got != TimestampSourceCrawled {
		t.Errorf("crawled fallback: %s", got)
	}
	if got := previewTimestampSource(nil, nil); got != TimestampSourceNone {
		t.Errorf("none: %s", got)
	}
}

func TestDeepOptionsOfMapsTheNormalizedSeed(t *testing.T) {
	seed := &SeedDeepConfig{
		MaxPages: 120, MaxDepth: 3, TimeBudgetSeconds: 90, PageConcurrency: 4,
		ScoreThreshold: 0.4, CandidatePoolSize: 200, HeadFetchTopK: 60,
		PreferPathDate: false, EnableSecondaryHubs: true, IgnoreRobotsTxt: true,
	}
	options := deepOptionsOf(seed)
	if options == nil {
		t.Fatal("options missing")
	}
	if options.MaxPages != 120 || options.MaxDepth != 3 || options.ScoreThreshold != 0.4 || options.PreferPathDate {
		t.Fatalf("options = %+v", options)
	}
	if deepOptionsOf(nil) != nil {
		t.Fatal("nil seed must map to nil")
	}
}

func TestNormalizeDeepDiscoveryOptionsClamps(t *testing.T) {
	defaults := NormalizeDeepOptions(nil)
	if defaults.MaxPages != 80 || defaults.MaxDepth != 2 || defaults.TimeBudgetSeconds != 60 || defaults.ScoreThreshold != 0.2 {
		t.Fatalf("defaults = %+v", defaults)
	}
	custom := NormalizeDeepOptions(json.RawMessage(`{"maxPages":1,"maxDepth":99,"timeBudgetSeconds":0,"pageConcurrency":50,"scoreThreshold":0.12345,"candidatePoolSize":1,"headFetchTopK":999}`))
	if custom.MaxPages != 5 || custom.MaxDepth != 4 || custom.TimeBudgetSeconds != 10 {
		t.Fatalf("clamped = %+v", custom)
	}
	if custom.PageConcurrency != 6 || custom.ScoreThreshold != 0.123 {
		t.Fatalf("clamped = %+v", custom)
	}
	if custom.CandidatePoolSize != 20 || custom.HeadFetchTopK != 120 {
		t.Fatalf("clamped = %+v", custom)
	}
}

func TestDeepFailureStatsNormalization(t *testing.T) {
	state := normalizeDeepDiscoveryFailureState(map[string]any{
		"streak":      float64(3),
		"lastCode":    "SEED_DEEP_CRAWL_FAILED",
		"lastMessage": "Deep discovery crawl failed",
		"retryAt":     "2026-10-20T01:00:00.000Z",
	})
	if state == nil {
		t.Fatal("state missing")
	}
	if state.Streak != 3 || state.LastFailureAt == "" || state.NextRunAt != "2026-10-20T01:00:00.000Z" {
		t.Fatalf("state = %+v", state)
	}
	if normalizeDeepDiscoveryFailureState(map[string]any{}) != nil {
		t.Fatal("an empty state must be nil")
	}
	stats := normalizeDeepDiscoveryFailureStats24h(map[string]any{
		"total": float64(5),
		"byCode": map[string]any{
			"SEED_DEEP_NO_CANDIDATE": float64(2),
			"SEED_DEEP_UNKNOWN":      float64(3),
			"OTHER":                  float64(9),
			"SEED_DEEP_EMPTY_RESULT": float64(0),
		},
	})
	if stats.Total != 5 || len(stats.ByCode) != 2 {
		t.Fatalf("stats = %+v", stats)
	}
	codes := []DeepFailureCodeCount{
		{Code: "a", Count: 1},
		{Code: "b", Count: 3},
		{Code: "c", Count: 3},
	}
	sortCodeCounts(codes)
	if codes[0].Code != "b" || codes[1].Code != "c" || codes[2].Code != "a" {
		t.Fatalf("codes = %+v", codes)
	}
}

func TestDiscoveryErrorText(t *testing.T) {
	withDetail := &DiscoveryError{Code: DiscoveryCodeEmptyResult, Message: "Deep discovery did not produce article URLs.", Detail: "Adjust x and retry."}
	if got := withDetail.Error(); got != "[SEED_DEEP_EMPTY_RESULT] Deep discovery did not produce article URLs. Adjust x and retry." {
		t.Fatalf("message = %q", got)
	}
	withoutDetail := &DiscoveryError{Code: DiscoveryCodeNoCandidate, Message: "Deep discovery found no article candidates."}
	if got := withoutDetail.Error(); got != "[SEED_DEEP_NO_CANDIDATE] Deep discovery found no article candidates." {
		t.Fatalf("message = %q", got)
	}
}
