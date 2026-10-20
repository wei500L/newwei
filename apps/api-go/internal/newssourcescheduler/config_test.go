package newssourcescheduler

import (
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"
	"time"
)

// These tests pin the pure compatibility surface: seed normalization, the
// discovery cache key, the canonical URL fingerprint, the RSS adaptive tiers,
// the backoff jitter and the execution-window search.

func TestNormalizeSeedConfigDefaultsAndClamps(t *testing.T) {
	source := testSource("source-1", "org-1", map[string]any{
		"keywords": []any{"alpha", " beta ", ""},
		"seed": map[string]any{
			"enabled":             true,
			"mode":                "LIST",
			"maxUrls":             9_999,
			"maxNewUrlsPerRun":    -3,
			"listMaxPages":        500,
			"listPageConcurrency": 9,
			"followPagination":    false,
			"scoreThreshold":      2,
			"dedupeWindowHours":   9_999,
			"queryParamAllowlist": []any{" ID ", "id", "bad key"},
			"rssAdaptive":         map[string]any{"enabled": true},
		},
	})
	settings := defaultSeedRuntimeSettings()
	config := normalizeSeedConfig(source, settings, nil)
	if config == nil {
		t.Fatal("seed config is nil")
	}
	if config.Mode != seedModeList {
		t.Fatalf("mode = %q", config.Mode)
	}
	if config.MaxURLs != 2_000 || config.MaxNewURLsPerRun != 1 || config.ListMaxPages != 20 || config.ListPageConcurrency != 5 {
		t.Fatalf("clamps: %+v", config)
	}
	if config.FollowPagination {
		t.Fatal("followPagination must keep the explicit false")
	}
	if config.ScoreThreshold != 1 {
		t.Fatalf("scoreThreshold = %v", config.ScoreThreshold)
	}
	if config.DedupeWindowHours != 24*30 {
		t.Fatalf("dedupeWindowHours = %d", config.DedupeWindowHours)
	}
	if len(config.QueryTokens) != 2 || config.QueryTokens[0] != "alpha" || config.QueryTokens[1] != "beta" {
		t.Fatalf("query tokens = %v", config.QueryTokens)
	}
	if len(config.QueryParamAllowlist) != 1 || config.QueryParamAllowlist[0] != "id" {
		t.Fatalf("allowlist = %v", config.QueryParamAllowlist)
	}
	if config.RSSAdaptiveEnabled {
		t.Fatal("rssAdaptive only applies to rss mode")
	}
	if config.CacheTTLSeconds != defaultSeedCacheTTLSecondsListDeep || config.CacheTTLPolicy != seedCacheTTLPolicyModeDefault {
		t.Fatalf("cache ttl = %d / %q", config.CacheTTLSeconds, config.CacheTTLPolicy)
	}
}

func TestNormalizeSeedConfigSourceCacheTTLAndWorkflowOverlay(t *testing.T) {
	source := testSource("source-1", "org-1", map[string]any{
		"seed": map[string]any{
			"enabled":         true,
			"mode":            "sitemap",
			"domain":          "example.com",
			"cacheTtlSeconds": 900,
		},
	})
	settings := defaultSeedRuntimeSettings()
	config := normalizeSeedConfig(source, settings, nil)
	if config == nil || config.CacheTTLSeconds != 900 || config.CacheTTLPolicy != seedCacheTTLPolicySourceOverride {
		t.Fatalf("source override = %+v", config)
	}
	if config.Domain == nil || *config.Domain != "https://example.com" {
		t.Fatalf("domain = %v", config.Domain)
	}

	forced := settings
	forced.SeedCacheTTLForceGlobal = true
	config = normalizeSeedConfig(source, forced, nil)
	if config == nil || config.CacheTTLSeconds != forced.SeedCacheTTLSecondsSitemapRSS || config.CacheTTLPolicy != seedCacheTTLPolicyGlobalForced {
		t.Fatalf("global forced = %+v", config)
	}

	overlay := &workflowOverlay{
		Seed:     json.RawMessage(`{"mode":"deep","maxUrls":7,"domain":"https://overlay.example"}`),
		Keywords: []string{"overlay-keyword"},
	}
	config = normalizeSeedConfig(source, settings, overlay)
	if config == nil || config.Mode != seedModeDeep || config.MaxURLs != 7 {
		t.Fatalf("overlay merge = %+v", config)
	}
	if config.Domain == nil || *config.Domain != "https://overlay.example" {
		t.Fatalf("overlay domain = %v", config.Domain)
	}
	if len(config.QueryTokens) != 1 || config.QueryTokens[0] != "overlay-keyword" {
		t.Fatalf("overlay query tokens = %v", config.QueryTokens)
	}
	if config.Deep == nil || config.Deep.MaxPages != 80 || !config.Deep.IgnoreRobotsTxt {
		t.Fatalf("deep defaults = %+v", config.Deep)
	}
}

func TestNormalizeSeedConfigRSSFetchPolicy(t *testing.T) {
	source := testSource("source-1", "org-1", map[string]any{
		"seed": map[string]any{
			"enabled": true,
			"mode":    "rss",
			"feedUrl": "example.com/feed",
			"rssFetch": map[string]any{
				"enabled":            true,
				"requestTimeoutMs":   500,
				"bodySourceStrategy": "CONTENT_ONLY",
				"noBodyPolicy":       "title_description_stub",
			},
		},
	})
	config := normalizeSeedConfig(source, defaultSeedRuntimeSettings(), nil)
	if config == nil || config.RSSFetch == nil {
		t.Fatal("rss fetch config is nil")
	}
	if config.FeedURL == nil || *config.FeedURL != "https://example.com/feed" {
		t.Fatalf("feedUrl = %v", config.FeedURL)
	}
	if config.RSSFetch.RequestTimeoutMs != 1_000 || config.RSSFetch.BodySourceStrategy != "content_only" ||
		config.RSSFetch.NoBodyPolicy != "title_description_stub" || !config.RSSFetch.Enabled {
		t.Fatalf("rssFetch = %+v", config.RSSFetch)
	}
}

func TestBuildSeedDiscoveryCacheKeyPinsJSONOrder(t *testing.T) {
	seed := &seedConfig{
		Mode:                seedModeSitemap,
		Domain:              strPtr("https://example.com"),
		MaxURLs:             200,
		ListMaxPages:        6,
		ListPageConcurrency: 2,
		FollowPagination:    true,
		QueryTokens:         []string{},
		ScoreThreshold:      0,
		CacheTTLSeconds:     60,
		CacheTTLPolicy:      seedCacheTTLPolicyModeDefault,
	}
	key := buildSeedDiscoveryCacheKey("source-1", "https://example.com/news", seed, 60)
	// The digest pins the exact JSON.stringify order of the source object.
	expectedJSON := `{"mode":"sitemap","sourceUrl":"https://example.com/news","domain":"https://example.com","pattern":null,"feedUrl":null,"maxUrls":200,"listMaxPages":6,"listPageConcurrency":2,"followPagination":true,"queryTokens":[],"scoreThreshold":0,"cacheTtlSeconds":60,"cacheTtlPolicy":"mode_default","deep":null}`
	if mustJSONString(t, seedDiscoveryFingerprint{
		Mode:                "sitemap",
		SourceURL:           "https://example.com/news",
		Domain:              strPtr("https://example.com"),
		MaxURLs:             200,
		ListMaxPages:        6,
		ListPageConcurrency: 2,
		FollowPagination:    true,
		QueryTokens:         []string{},
		ScoreThreshold:      0,
		CacheTTLSeconds:     60,
		CacheTTLPolicy:      "mode_default",
	}) != expectedJSON {
		t.Fatalf("fingerprint JSON changed: %s", mustJSONString(t, seedDiscoveryFingerprint{
			Mode:                "sitemap",
			SourceURL:           "https://example.com/news",
			Domain:              strPtr("https://example.com"),
			MaxURLs:             200,
			ListMaxPages:        6,
			ListPageConcurrency: 2,
			FollowPagination:    true,
			QueryTokens:         []string{},
			ScoreThreshold:      0,
			CacheTTLSeconds:     60,
			CacheTTLPolicy:      "mode_default",
		}))
	}
	if len(key) < len("news-source:sitemap:source-1:")+40 {
		t.Fatalf("key = %q", key)
	}
	if key[:len("news-source:sitemap:source-1:")] != "news-source:sitemap:source-1:" {
		t.Fatalf("key prefix = %q", key)
	}
	sum := sha1Hex(expectedJSON)
	if key != "news-source:sitemap:source-1:"+sum {
		t.Fatalf("key = %q, want digest %q", key, sum)
	}

	shorter := *seed
	shorter.MaxURLs = 100
	if buildSeedDiscoveryCacheKey("source-1", "https://example.com/news", &shorter, 60) == key {
		t.Fatal("a different maxUrls must change the cache key")
	}
}

func TestCanonicalURLFingerprint(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		allowlist any
		want      string
	}{
		{
			name:      "adds scheme and trailing slash rules",
			input:     "example.com/news/",
			allowlist: []string{},
			want:      "https://example.com/news",
		},
		{
			name:      "keeps only allowlisted pairs sorted",
			input:     "https://example.com/a?b=2&id=7&a=1&utm=9#frag",
			allowlist: []string{"id", "a", "b"},
			want:      "https://example.com/a?a=1&b=2&id=7",
		},
		{
			name:      "drops the default port and credentials",
			input:     "https://user:pass@Example.com:443/a//b/../c",
			allowlist: []string{},
			want:      "https://example.com/a/c",
		},
		{
			name:      "empty allowlist strips every parameter",
			input:     "https://example.com/a?id=1",
			allowlist: []string{},
			want:      "https://example.com/a",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			canonical, fingerprint, ok := buildCanonicalURLFingerprint(test.input, test.allowlist)
			if !ok {
				t.Fatalf("canonicalize(%q) failed", test.input)
			}
			if canonical != test.want {
				t.Fatalf("canonical = %q, want %q", canonical, test.want)
			}
			if fingerprint != sha256Hex(canonical) {
				t.Fatalf("fingerprint = %q, want sha256 of the canonical URL", fingerprint)
			}
		})
	}
	if _, _, ok := buildCanonicalURLFingerprint("   ", []string{}); ok {
		t.Fatal("empty URL must fail")
	}
}

func TestCanonicalizeSeedJobsDedupesAndMergesPrefetchedArticle(t *testing.T) {
	first := scoredSeedCandidate{
		URL:             "https://example.com/a?x=1",
		EffectiveTs:     int64Ptr(100),
		CrawledAtTs:     int64Ptr(100),
		TimestampSource: "crawled",
	}
	first.PrefetchedArticle = &prefetchedArticle{Markdown: "short"}
	second := scoredSeedCandidate{
		URL:             "https://example.com/a",
		EffectiveTs:     int64Ptr(200),
		CrawledAtTs:     int64Ptr(200),
		TimestampSource: "crawled",
	}
	second.PrefetchedArticle = &prefetchedArticle{Markdown: "a much longer body"}
	jobs := canonicalizeSeedJobs([]scoredSeedCandidate{first, second}, []string{})
	if len(jobs) != 1 {
		t.Fatalf("jobs = %d, want 1", len(jobs))
	}
	if jobs[0].URL != "https://example.com/a" || jobs[0].EffectiveTs == nil || *jobs[0].EffectiveTs != 200 {
		t.Fatalf("job = %+v", jobs[0])
	}
	if jobs[0].PrefetchedArticle == nil || jobs[0].PrefetchedArticle.Markdown != "a much longer body" {
		t.Fatalf("prefetched article = %+v", jobs[0].PrefetchedArticle)
	}
}

func TestDedupeMatchedFingerprintsAddsCandidateFingerprint(t *testing.T) {
	byURL := map[string]string{"https://example.com/a": "candidate"}
	old := "stored"
	records := []fingerprintRecord{
		{URL: "https://example.com/a", URLFingerprint: &old},
	}
	matched := matchedFingerprints(records, byURL)
	if !matched["stored"] {
		t.Fatal("the record's own fingerprint must be kept")
	}
	if !matched["candidate"] {
		t.Fatal("S1: the candidate fingerprint must be added for a URL hit")
	}
	// A record with no stored fingerprint still contributes the candidate one.
	records = []fingerprintRecord{{URL: "https://example.com/a"}}
	matched = matchedFingerprints(records, byURL)
	if !matched["candidate"] || len(matched) != 1 {
		t.Fatalf("matched = %v", matched)
	}
}

func TestRSSAdaptiveTiersAndIntervals(t *testing.T) {
	settings := defaultSeedRuntimeSettings()
	service := newTestService(newFakeRepo(), newFakeCache(), Options{})

	normal := rssAdaptiveState{Outcomes: []bool{false, false}, UpdatedAt: isoMillis(time.Unix(0, 0))}
	if tier := service.resolveRSSAdaptiveTier(normal, 0, settings); tier != rssAdaptiveTierNormal {
		t.Fatalf("tier = %q, want normal", tier)
	}
	if tier := service.resolveRSSAdaptiveTier(normal, 80, settings); tier != rssAdaptiveTierWarm {
		t.Fatalf("hot priority tier = %q, want warm", tier)
	}
	if tier := service.resolveRSSAdaptiveTier(normal, -80, settings); tier != rssAdaptiveTierCold {
		t.Fatalf("cold priority tier = %q, want cold", tier)
	}

	hot := rssAdaptiveState{Outcomes: []bool{true, true, true}}
	if tier := service.resolveRSSAdaptiveTier(hot, 0, settings); tier != rssAdaptiveTierHot {
		t.Fatalf("tier = %q, want hot", tier)
	}
	cold := rssAdaptiveState{Outcomes: []bool{false, false, false}, ConsecutiveNoHit: 4}
	if tier := service.resolveRSSAdaptiveTier(cold, 0, settings); tier != rssAdaptiveTierCold {
		t.Fatalf("tier = %q, want cold", tier)
	}

	if got := resolveRSSAdaptiveIntervalSeconds(600, rssAdaptiveTierHot, settings); got != settings.RSSAdaptiveHotIntervalSeconds {
		t.Fatalf("hot interval = %d", got)
	}
	if got := resolveRSSAdaptiveIntervalSeconds(600, rssAdaptiveTierWarm, settings); got != 300 {
		t.Fatalf("warm interval = %d", got)
	}
	if got := resolveRSSAdaptiveIntervalSeconds(600, rssAdaptiveTierCold, settings); got != 1_200 {
		t.Fatalf("cold interval = %d", got)
	}
	if got := resolveRSSAdaptiveIntervalSeconds(600, rssAdaptiveTierNormal, settings); got != 600 {
		t.Fatalf("normal interval = %d", got)
	}
	if got := resolveRSSAdaptiveCacheTTLSeconds(900, rssAdaptiveTierHot, settings); got != settings.RSSAdaptiveHotDiscoveryCacheTTLCapSeconds {
		t.Fatalf("hot ttl = %d", got)
	}
	if got := resolveRSSAdaptiveCacheTTLSeconds(900, rssAdaptiveTierWarm, settings); got != settings.RSSAdaptiveWarmDiscoveryCacheTTLCapSeconds {
		t.Fatalf("warm ttl = %d", got)
	}
	next := service.buildNextRSSAdaptiveState(hot, false)
	if next.ConsecutiveNoHit != 1 || len(next.Outcomes) != 4 || next.Outcomes[3] {
		t.Fatalf("next state = %+v", next)
	}
	next = service.buildNextRSSAdaptiveState(cold, true)
	if next.ConsecutiveNoHit != 0 || !next.Outcomes[len(next.Outcomes)-1] {
		t.Fatalf("next state = %+v", next)
	}
}

func TestExponentialBackoffJitter(t *testing.T) {
	service := newTestService(newFakeRepo(), newFakeCache(), Options{Random: func() float64 { return 0 }})
	if got := service.computeExponentialBackoffDelay(600_000, 1, 86_400_000); got != 450_000 {
		t.Fatalf("attempt 1 low jitter = %d, want 450000", got)
	}
	if got := service.computeExponentialBackoffDelay(600_000, 2, 86_400_000); got != 900_000 {
		t.Fatalf("attempt 2 low jitter = %d, want 900000", got)
	}
	high := newTestService(newFakeRepo(), newFakeCache(), Options{Random: func() float64 { return 1 }})
	if got := high.computeExponentialBackoffDelay(600_000, 2, 86_400_000); got != 1_500_000 {
		t.Fatalf("attempt 2 high jitter = %d, want 1500000", got)
	}
	if got := high.computeExponentialBackoffDelay(600_000, 20, 3_600_000); got != 4_500_000 {
		t.Fatalf("capped = %d, want 4500000", got)
	}
}

func TestComputeNextRunAtIntervalAndWindow(t *testing.T) {
	service := newTestService(newFakeRepo(), newFakeCache(), Options{Random: func() float64 { return 0 }})
	scheduledFor := time.Date(2026, 10, 20, 13, 0, 0, 0, time.UTC)
	now := time.Date(2026, 10, 20, 13, 5, 0, 0, time.UTC)
	source := testSource("source-1", "org-1", map[string]any{})
	source.FrequencySeconds = 600
	// No cron block: anchor + interval + zero jitter.
	next := service.computeNextRunAt(source, scheduledFor, now, nil)
	if !next.Equal(now.Add(600 * time.Second)) {
		t.Fatalf("next = %s, want %s", next, now.Add(600*time.Second))
	}

	cronSource := testSource("source-1", "org-1", map[string]any{
		"schedule": map[string]any{
			"mode": "cron",
			"cron": map[string]any{"expression": "0 9 * * *", "timezone": "UTC"},
			"window": map[string]any{
				"daysOfWeek": []any{1},
				"startHour":  9,
				"endHour":    10,
			},
		},
	})
	base := time.Date(2026, 10, 20, 8, 0, 0, 0, time.UTC) // Tuesday
	next = service.computeNextRunAt(cronSource, base, base, nil)
	// 2026-10-26 is the next Monday; the window only accepts 09:00-09:59.
	if !next.Equal(time.Date(2026, 10, 26, 9, 0, 0, 0, time.UTC)) {
		t.Fatalf("windowed next = %s, want 2026-10-26T09:00:00Z", next)
	}

	// A 30-minute cadence can never reach next Monday within the 200-occurrence
	// budget: the scheduler returns the 201st occurrence, out of the window,
	// exactly like the NestJS loop.
	frequent := testSource("source-1", "org-1", map[string]any{
		"schedule": map[string]any{
			"mode": "cron",
			"cron": map[string]any{"expression": "*/30 * * * *", "timezone": "UTC"},
			"window": map[string]any{
				"daysOfWeek": []any{1},
			},
		},
	})
	next = service.computeNextRunAt(frequent, base, base, nil)
	// base + 201 * 30 minutes
	if !next.Equal(time.Date(2026, 10, 24, 12, 30, 0, 0, time.UTC)) {
		t.Fatalf("200-iteration fallback = %s, want 2026-10-24T12:30:00Z", next)
	}
}

func TestIsWithinCronWindow(t *testing.T) {
	monday := time.Date(2026, 10, 26, 9, 30, 0, 0, time.UTC)
	window := &cronWindow{StartHour: intPtr(9), EndHour: intPtr(10)}
	if !isWithinCronWindow(monday, window, "UTC") {
		t.Fatal("09:30 must be inside 09-10")
	}
	if isWithinCronWindow(monday.Add(2*time.Hour), window, "UTC") {
		t.Fatal("11:30 must be outside 09-10")
	}
	days := &cronWindow{DaysOfWeek: []int{1}}
	if !isWithinCronWindow(monday, days, "Europe/Moscow") {
		// 09:30Z is 12:30 MSK on Monday.
		t.Fatal("Monday in Moscow must match")
	}
	if isWithinCronWindow(monday.Add(24*time.Hour), days, "Europe/Moscow") {
		t.Fatal("Tuesday must not match")
	}
	if !isWithinCronWindow(monday, days, "Not/AZone") {
		t.Fatal("an unresolvable timezone must not filter")
	}
}

func TestNormalizeCronSchedule(t *testing.T) {
	source := testSource("source-1", "org-1", map[string]any{
		"schedule": map[string]any{
			"mode": "cron",
			"cron": map[string]any{"expression": " 0 9 * * 1 ", "timezone": " Europe/Moscow "},
			"window": map[string]any{
				"daysOfWeek": []any{1, 1, 7, -1, 3.9},
				"startHour":  25,
				"endHour":    0,
			},
		},
	})
	schedule := normalizeCronSchedule(source)
	if schedule == nil {
		t.Fatal("schedule is nil")
	}
	if schedule.Expression != "0 9 * * 1" || schedule.Timezone == nil || *schedule.Timezone != "Europe/Moscow" {
		t.Fatalf("schedule = %+v", schedule)
	}
	if len(schedule.Window.DaysOfWeek) != 2 || schedule.Window.DaysOfWeek[0] != 1 || schedule.Window.DaysOfWeek[1] != 3 {
		t.Fatalf("days = %v", schedule.Window.DaysOfWeek)
	}
	if schedule.Window.StartHour == nil || *schedule.Window.StartHour != 23 {
		t.Fatalf("startHour = %v", schedule.Window.StartHour)
	}
	if schedule.Window.EndHour == nil || *schedule.Window.EndHour != 1 {
		t.Fatalf("endHour = %v", schedule.Window.EndHour)
	}

	notCron := testSource("source-1", "org-1", map[string]any{"schedule": map[string]any{"mode": "interval"}})
	if normalizeCronSchedule(notCron) != nil {
		t.Fatal("an interval schedule must not parse as cron")
	}
}

func TestSeedPayloadMetadataAndItemPayload(t *testing.T) {
	service := newTestService(newFakeRepo(), newFakeCache(), Options{})
	source := testSource("source-1", "org-1", map[string]any{
		"keywords":     []any{"k1"},
		"tags":         []any{"t1"},
		"summaryHints": []any{"h1"},
		"metadata":     map[string]any{"custom": "value"},
		"crawlOptions": map[string]any{
			"headless":      true,
			"cleanMarkdown": map[string]any{"excludedTags": []any{"iframe"}},
		},
	})
	seed := &seedPayloadInput{
		Mode:                seedModeList,
		ParentURL:           source.URL,
		PublishedAt:         strPtr("2026-10-01T00:00:00.000Z"),
		TimestampSource:     "published",
		DedupeWindowHours:   24,
		QueryParamAllowlist: []string{},
	}
	payload := service.buildPayload(source, "https://example.com/a", seed)
	if payload.Language != nil {
		t.Fatal("a nil language must be omitted")
	}
	if payload.SourceName == nil || *payload.SourceName != "Example" {
		t.Fatalf("sourceName = %v", payload.SourceName)
	}
	if payload.ForceRefresh {
		t.Fatal("forceRefresh must default to false")
	}
	if payload.CrawlOptions == nil {
		t.Fatal("crawl options are missing")
	}
	var markdownOptions map[string]json.RawMessage
	_ = json.Unmarshal(payload.CrawlOptions["markdownOptions"], &markdownOptions)
	if _, present := markdownOptions["contentSource"]; !present {
		t.Fatal("markdownOptions defaults are missing")
	}
	var cleanMarkdown map[string]json.RawMessage
	_ = json.Unmarshal(payload.CrawlOptions["cleanMarkdown"], &cleanMarkdown)
	if _, present := cleanMarkdown["cssSelector"]; present {
		t.Fatal("cssSelector must be removed when absent")
	}
	if _, present := payload.CrawlOptions["virtualScroll"]; !present {
		t.Fatal("list mode must add virtualScroll defaults")
	}

	itemPayloadConfig := buildItemPayloadConfig(source, &seedConfig{Mode: seedModeList, DedupeWindowHours: 24, QueryParamAllowlist: []string{}}, source.URL, seed)
	itemPayload := buildItemPayload(payload, itemPayloadConfig)
	metadataJSON, _ := json.Marshal(itemPayload["metadata"])
	if len(metadataJSON) == 0 {
		t.Fatal("item payload metadata is empty")
	}
	var metadata map[string]json.RawMessage
	if err := json.Unmarshal(metadataJSON, &metadata); err != nil {
		t.Fatalf("metadata: %v", err)
	}
	if _, present := metadata["newsSourceSeed"]; !present {
		t.Fatal("newsSourceSeed is missing")
	}
	if _, present := metadata["custom"]; !present {
		t.Fatal("config metadata must override/merge into the item payload metadata")
	}
}

func TestBuildRSSPrefetchedPayloadValidates(t *testing.T) {
	payload := crawlPayload{
		URL:          "https://example.com/a",
		SourceName:   strPtr("Example"),
		Keywords:     []string{},
		Tags:         []string{},
		SummaryHints: []string{},
		Metadata:     jsonObject{"sourceId": rawValue("source-1")},
	}
	article := &prefetchedArticle{Markdown: "body", Metadata: json.RawMessage(`{"markdownSource":"content"}`)}
	normalized, ok := buildRSSPrefetchedPayload(payload, article)
	if !ok {
		t.Fatal("payload validation failed")
	}
	if normalized.URL != payload.URL || normalized.Prefetched == nil {
		t.Fatalf("normalized = %+v", normalized)
	}
}

func TestTruncateUTF16(t *testing.T) {
	if got := truncateUTF16("abcdef", 4); got != "abcd" {
		t.Fatalf("truncate = %q", got)
	}
	// An astral character counts as two code units: "a😀b" is 4 units, so a
	// limit of 3 cuts before the emoji.
	if got := truncateUTF16("a😀b", 3); got != "a" {
		t.Fatalf("truncate astral = %q", got)
	}
	if got := displayName(&source{ID: "s", Name: "n"}); got != "NewsSource:s:n" {
		t.Fatalf("displayName = %q", got)
	}
	if got := toItemMetaName("  spaced  "); got != "spaced" {
		t.Fatalf("toItemMetaName = %q", got)
	}
}

func mustJSONString(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(encoded)
}

func sha1Hex(value string) string {
	sum := sha1.Sum([]byte(value))
	return hex.EncodeToString(sum[:])
}

func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func int64Ptr(value int64) *int64 {
	return &value
}
