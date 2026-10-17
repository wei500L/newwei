package classificationrssops

import "testing"

// TestResolveBackfillSourceIDHopPriority pins the multi-hop order: the owning
// PipelineJob wins, then the RawItem metadata sourceId, then the raw
// pipelineJobId, then the crawl result id, then the ItemMeta externalId hop.
func TestResolveBackfillSourceIDHopPriority(t *testing.T) {
	byJob := map[string]string{
		"job-1":      "source-from-job",
		"job-raw":    "source-from-raw-job",
		"job-blank":  "   ",
		"job-absent": "",
	}
	byCrawlResult := map[string]string{
		"crawl-1": "source-from-crawl",
		"crawl-2": "source-from-item-meta",
	}
	cases := []struct {
		name      string
		candidate rssBackfillCandidate
		want      string
	}{
		{
			name:      "pipeline job wins",
			candidate: rssBackfillCandidate{PipelineJobID: strPtr("job-1"), RawSourceID: strPtr("raw-source"), RawPipelineJobID: strPtr("job-raw")},
			want:      "source-from-job",
		},
		{
			name:      "raw metadata sourceId is the second hop",
			candidate: rssBackfillCandidate{RawSourceID: strPtr("raw-source"), RawPipelineJobID: strPtr("job-raw"), CrawlResultID: strPtr("crawl-1")},
			want:      "raw-source",
		},
		{
			name:      "raw pipeline job is the third hop",
			candidate: rssBackfillCandidate{RawPipelineJobID: strPtr("job-raw"), CrawlResultID: strPtr("crawl-1")},
			want:      "source-from-raw-job",
		},
		{
			name:      "crawl result is the fourth hop",
			candidate: rssBackfillCandidate{CrawlResultID: strPtr("crawl-1")},
			want:      "source-from-crawl",
		},
		{
			name:      "item meta externalId is the last hop",
			candidate: rssBackfillCandidate{FallbackCrawlResultID: strPtr("crawl-2")},
			want:      "source-from-item-meta",
		},
		{
			name:      "blank hops are skipped",
			candidate: rssBackfillCandidate{PipelineJobID: strPtr("job-blank"), RawSourceID: strPtr("  "), FallbackCrawlResultID: strPtr("crawl-2")},
			want:      "source-from-item-meta",
		},
		{
			name:      "nothing resolves",
			candidate: rssBackfillCandidate{PipelineJobID: strPtr("job-unknown")},
			want:      "",
		},
	}
	for _, tc := range cases {
		got := resolveBackfillSourceID(tc.candidate, byJob, byCrawlResult)
		if tc.want == "" {
			if got != nil {
				t.Fatalf("%s: resolved %q, want nil", tc.name, *got)
			}
			continue
		}
		if got == nil || *got != tc.want {
			t.Fatalf("%s: resolved %v, want %q", tc.name, got, tc.want)
		}
	}
}

// TestCrawlResultIDFromExternalID pins the two accepted prefixes.
func TestCrawlResultIDFromExternalID(t *testing.T) {
	cases := []struct {
		externalID string
		want       string
	}{
		{"crawlResult:abc123", "abc123"},
		{"crawl:def456", "def456"},
		{" crawlResult: spaced ", "spaced"},
		{"crawlResult:", ""},
		{"other:abc", ""},
		{"", ""},
	}
	for _, tc := range cases {
		got := crawlResultIDFromExternalID(tc.externalID)
		if tc.want == "" {
			if got != nil {
				t.Fatalf("externalId %q resolved %q, want nil", tc.externalID, *got)
			}
			continue
		}
		if got == nil || *got != tc.want {
			t.Fatalf("externalId %q resolved %v, want %q", tc.externalID, got, tc.want)
		}
	}
}

// TestSourceIDFromTaskConfig pins both CrawlTask.config sourceId locations.
func TestSourceIDFromTaskConfig(t *testing.T) {
	direct := []byte(`{"sourceId":"source-direct"}`)
	if got := sourceIDFromTaskConfig(direct); got == nil || *got != "source-direct" {
		t.Fatalf("direct config = %v", got)
	}
	nested := []byte(`{"itemPayload":{"metadata":{"sourceId":"source-nested"}}}`)
	if got := sourceIDFromTaskConfig(nested); got == nil || *got != "source-nested" {
		t.Fatalf("nested config = %v", got)
	}
	if got := sourceIDFromTaskConfig([]byte(`{}`)); got != nil {
		t.Fatalf("empty config = %v", got)
	}
	if got := sourceIDFromTaskConfig([]byte(`not-json`)); got != nil {
		t.Fatalf("invalid config = %v", got)
	}
}

// TestParseRSSSeed pins the config.seed filter: only mode "rss" is kept by the
// caller, an unknown mode falls back to "sitemap" and a missing seed is skipped.
func TestParseRSSSeed(t *testing.T) {
	seed, ok := parseRSSSeed([]byte(`{"seed":{"enabled":true,"mode":"RSS","feedUrl":" https://example.com/rss "}}`))
	if !ok || !seed.Enabled || seed.Mode != "rss" {
		t.Fatalf("rss seed = %+v (%v)", seed, ok)
	}
	if seed.FeedURL == nil || *seed.FeedURL != "https://example.com/rss" {
		t.Fatalf("feed url = %v", seed.FeedURL)
	}
	unknown, ok := parseRSSSeed([]byte(`{"seed":{"mode":"custom"}}`))
	if !ok || unknown.Mode != "sitemap" {
		t.Fatalf("unknown mode = %+v (%v)", unknown, ok)
	}
	if _, ok := parseRSSSeed([]byte(`{}`)); ok {
		t.Fatalf("missing seed must be skipped")
	}
	if _, ok := parseRSSSeed([]byte(`{"seed":[]}`)); ok {
		t.Fatalf("array seed must be skipped")
	}
}

// TestComputeRSSVisibility pins the processed/article_fallback/none split.
func TestComputeRSSVisibility(t *testing.T) {
	sources := []rssSourceRow{{ID: "a"}, {ID: "b"}, {ID: "c"}}
	processed := map[string]rssSourceWindowStats{"a": {ItemCount: 2}}
	articles := map[string]rssSourceWindowStats{"b": {ItemCount: 5}}
	visibility := computeRSSVisibility(sources, processed, articles)
	if visibility.VisibleByProcessed != 1 || visibility.VisibleByArticleFallback != 1 || visibility.HiddenSources != 1 {
		t.Fatalf("visibility = %+v", visibility)
	}
}

// TestPipelineAndCrawlTaskCounts pins the four-bucket aggregation.
func TestPipelineAndCrawlTaskCounts(t *testing.T) {
	counts := pipelineCountsFromStatusTotals(map[string]int{
		"queued": 1, "pending": 2, "running": 3, "delayed": 4,
		"completed": 5, "failed": 6, "cancelled": 99,
	})
	if counts.Total != 21 || counts.Queued != 3 || counts.Running != 7 || counts.Completed != 5 || counts.Failed != 6 {
		t.Fatalf("pipeline counts = %+v", counts)
	}
	taskCounts := crawlTaskCountsFromRows([]rssCrawlTaskStatusCount{
		{Status: "queued", Count: 1},
		{Status: "running", Count: 2},
		{Status: "completed", Count: 3},
		{Status: "failed", Count: 4},
		{Status: "cancelled", Count: 50},
	})
	if taskCounts.Total != 10 || taskCounts.Queued != 1 || taskCounts.Running != 2 ||
		taskCounts.Completed != 3 || taskCounts.Failed != 4 {
		t.Fatalf("crawl task counts = %+v", taskCounts)
	}
}

// TestResolveDiagnosticsWindowClamps pins the RSS window and lookback clamps.
func TestResolveDiagnosticsWindowClamps(t *testing.T) {
	if got := resolveWindowDays(nil); got != rssDefaultWindowDays {
		t.Fatalf("default windowDays = %d", got)
	}
	if got := resolveWindowDays(floatPtr(0)); got != 1 {
		t.Fatalf("windowDays=0 -> %d", got)
	}
	if got := resolveWindowDays(floatPtr(99)); got != rssMaxWindowDays {
		t.Fatalf("windowDays=99 -> %d", got)
	}
	if got := resolveWindowDays(floatPtr(7.9)); got != 7 {
		t.Fatalf("windowDays=7.9 -> %d", got)
	}
	if got := resolveLookbackHours(nil); got != rssDefaultLookbackHours {
		t.Fatalf("default lookbackHours = %d", got)
	}
	if got := resolveLookbackHours(floatPtr(9999)); got != rssMaxLookbackHours {
		t.Fatalf("lookbackHours=9999 -> %d", got)
	}
}
