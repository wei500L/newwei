package crawlstrategyruns

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
)

// TestNormalizeSeedConfigSingleMode pins the single-page branch trigger: a
// missing seed object or enabled !== true yields nil (single mode).
func TestNormalizeSeedConfigSingleMode(t *testing.T) {
	if seed := normalizeSeedConfig(nil, "https://example.com/"); seed != nil {
		t.Fatalf("nil config = %+v", seed)
	}
	if seed := normalizeSeedConfig(map[string]json.RawMessage{}, "https://example.com/"); seed != nil {
		t.Fatalf("missing seed = %+v", seed)
	}
	disabled := map[string]json.RawMessage{"seed": json.RawMessage(`{"enabled":false}`)}
	if seed := normalizeSeedConfig(disabled, "https://example.com/"); seed != nil {
		t.Fatalf("disabled seed = %+v", seed)
	}
}

// TestNormalizeSeedConfigListMode pins the seed branch defaults and the domain
// fallback to the source origin.
func TestNormalizeSeedConfigListMode(t *testing.T) {
	config := map[string]json.RawMessage{
		"seed":     json.RawMessage(`{"enabled":true,"mode":"list","pattern":"/news/","maxUrls":17}`),
		"keywords": json.RawMessage(`["markets","energy"]`),
	}
	seed := normalizeSeedConfig(config, "https://example.com/section")
	if seed == nil || !seed.Enabled {
		t.Fatalf("seed = %+v", seed)
	}
	if seed.Mode != "list" {
		t.Fatalf("mode = %s", seed.Mode)
	}
	if seed.Domain == nil || *seed.Domain != "https://example.com" {
		t.Fatalf("domain = %v", seed.Domain)
	}
	if seed.Pattern == nil || *seed.Pattern != "/news/" {
		t.Fatalf("pattern = %v", seed.Pattern)
	}
	if seed.MaxURLs != 17 {
		t.Fatalf("maxUrls = %d", seed.MaxURLs)
	}
	if seed.MaxNewURLsPerRun != 80 || seed.ListMaxPages != 6 || seed.ListPageConcurrency != 2 || !seed.FollowPagination {
		t.Fatalf("defaults = %+v", seed)
	}
	if seed.Query == nil || *seed.Query != "markets energy" {
		t.Fatalf("query = %v", seed.Query)
	}
	if len(seed.QueryParamAllowlist) == 0 {
		t.Fatal("queryParamAllowlist must default to the shared allowlist")
	}
}

// TestNormalizeSeedConfigRSSAndDeep pins the RSS feed URL fallback and the deep
// option clamps.
func TestNormalizeSeedConfigRSSAndDeep(t *testing.T) {
	rss := normalizeSeedConfig(map[string]json.RawMessage{
		"seed": json.RawMessage(`{"enabled":true,"mode":"rss"}`),
	}, "https://example.com/feed")
	if rss == nil || rss.FeedURL == nil || *rss.FeedURL != "https://example.com/feed" {
		t.Fatalf("rss = %+v", rss)
	}
	if rss.Domain != nil || rss.Pattern != nil || rss.Deep != nil {
		t.Fatalf("rss-only fields = %+v", rss)
	}

	deep := normalizeSeedConfig(map[string]json.RawMessage{
		"seed": json.RawMessage(`{"enabled":true,"mode":"deep","deep":{"maxPages":500,"maxDepth":9,"scoreThreshold":2}}`),
	}, "https://example.com/")
	if deep == nil || deep.Deep == nil {
		t.Fatalf("deep = %+v", deep)
	}
	if deep.Deep.MaxPages != 300 || deep.Deep.MaxDepth != 4 || deep.Deep.ScoreThreshold != 1 {
		t.Fatalf("clamps = %+v", deep.Deep)
	}
	if !deep.Deep.IgnoreRobotsTxt {
		t.Fatal("ignoreRobotsTxt must stay hard-locked to true")
	}
}

// TestMergeWorkflowSourceConfigPrefersOverlay pins the merge rule: the overlay's
// keywords replace the source keywords, and crawlOptions/seed merge key by key.
func TestMergeWorkflowSourceConfigPrefersOverlay(t *testing.T) {
	base := map[string]json.RawMessage{
		"keywords":     json.RawMessage(`["old"]`),
		"crawlOptions": json.RawMessage(`{"check_robots_txt":true,"locale":"en"}`),
		"seed":         json.RawMessage(`{"mode":"sitemap","maxUrls":40}`),
	}
	overlay := &crawlworkflow.CompiledNewsSourceOverlay{
		Keywords:     []string{"new"},
		CrawlOptions: json.RawMessage(`{"check_robots_txt":false}`),
		Seed:         json.RawMessage(`{"mode":"list"}`),
	}
	merged := mergeWorkflowSourceConfig(base, overlay)
	var keywords []string
	if err := json.Unmarshal(merged["keywords"], &keywords); err != nil || len(keywords) != 1 || keywords[0] != "new" {
		t.Fatalf("keywords = %s", merged["keywords"])
	}
	options, _ := objectOfRaw(merged["crawlOptions"])
	if strings.TrimSpace(string(options["check_robots_txt"])) != "false" || stringValueRaw(options["locale"]) != "en" {
		t.Fatalf("crawlOptions = %s", merged["crawlOptions"])
	}
	seed, _ := objectOfRaw(merged["seed"])
	if stringValueRaw(seed["mode"]) != "list" || strings.TrimSpace(string(seed["maxUrls"])) != "40" {
		t.Fatalf("seed = %s", merged["seed"])
	}
}
