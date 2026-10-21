package crawlexecution

// Crawl quality signals: publish time, media density, DOM list risk and the four
// decisions they feed (isLowSignal, classifyPageKind, shouldAutoExpand,
// isSignificantDetailImprovement).

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawloptions"
)

func fixedNow() time.Time {
	return time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
}

func rawJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func markdownArticle(t *testing.T, markdown string) crawl4ai.PipelineArticle {
	t.Helper()
	return crawl4ai.PipelineArticle{URL: "https://news.example.com/world/story", Markdown: rawJSON(t, markdown)}
}

func TestEstimateMarkdownWordUnits(t *testing.T) {
	score, density := estimateMarkdownWordUnits("hello world")
	if score != 2 || density != 2 {
		t.Fatalf("ascii = %d/%d", score, density)
	}
	// Four CJK characters: half a word each for scoring, a sixth for density.
	score, density = estimateMarkdownWordUnits("你好世界")
	if score != 2 || density != 1 {
		t.Fatalf("cjk = %d/%d", score, density)
	}
}

func TestCountArticleImageInventoryAndDensity(t *testing.T) {
	article := crawl4ai.PipelineArticle{Media: rawJSON(t, map[string]any{
		"images":   []map[string]any{{}, {}},
		"Image":    []map[string]any{{}},
		"photos":   []map[string]any{{}, {}, {}},
		"videos":   []map[string]any{{}, {}, {}, {}},
		"metadata": map[string]any{"ignored": true},
		"empty":    []map[string]any{},
	})}
	// images=2 (image bucket), Image=1, photos=3, videos=min(2,4)=2.
	if got := countArticleImageInventory(article); got != 8 {
		t.Fatalf("image inventory = %d", got)
	}
	if got := estimateMediaDensity(article, 100); got != 0.08 {
		t.Fatalf("media density = %v", got)
	}
	if got := estimateMediaDensity(crawl4ai.PipelineArticle{}, 100); got != 0 {
		t.Fatal("no media must give zero density")
	}
	// A malformed media leaf is ignored, not fatal.
	if got := countArticleImageInventory(crawl4ai.PipelineArticle{Media: json.RawMessage(`"nope"`)}); got != 0 {
		t.Fatalf("malformed media = %d", got)
	}
}

func TestHasListPathTokens(t *testing.T) {
	cases := map[string]bool{
		"https://news.example.com/latest/":           true,
		"https://news.example.com/tag/climate":       true,
		"https://news.example.com/category/world":    true,
		"https://news.example.com/authors/jane":      true,
		"https://news.example.com/world/story-title": false,
		"https://news.example.com/latest-news/story": false,
		"": false,
	}
	for value, want := range cases {
		if got := hasListPathTokens(value); got != want {
			t.Fatalf("hasListPathTokens(%q) = %v, want %v", value, got, want)
		}
	}
}

func TestEstimateDomListRisk(t *testing.T) {
	links := map[string][]map[string]any{"internal": {}}
	for index := 0; index < 60; index++ {
		links["internal"] = append(links["internal"], map[string]any{"href": "https://news.example.com/a"})
	}
	article := crawl4ai.PipelineArticle{
		URL:   "https://news.example.com/latest/",
		Links: rawJSON(t, links),
	}
	risk := estimateDomListRisk(article, domListMetrics{
		ParagraphCount: 1,
		LinkCount:      12,
		LinkDensity:    0.2,
		BulletLines:    12,
	})
	// 0.5 (inventory) + 0.35 (density) + 0.25 (bullets) + 0.2 (paragraphs) + 0.25 (list path).
	if risk != 1 {
		t.Fatalf("risk = %v", risk)
	}
	if got := estimateDomListRisk(crawl4ai.PipelineArticle{URL: "https://news.example.com/world/story"}, domListMetrics{}); got != 0 {
		t.Fatalf("empty risk = %v", got)
	}
}

func TestIsLowSignalDecisions(t *testing.T) {
	listLike := articleSignal{IsListLike: true, WordCount: 400}
	if !isLowSignal(listLike, 0) {
		t.Fatal("list-like signal must be low signal")
	}
	bulletins := articleSignal{
		WordCount:             80,
		ParagraphCount:        3,
		PublishTimeConfidence: 0.8,
		LinkDensity:           0.1,
	}
	if isLowSignal(bulletins, 0) {
		t.Fatal("a fresh, short bulletin must not be low signal")
	}
	mixedMedia := articleSignal{
		WordCount:      120,
		ParagraphCount: 5,
		MediaDensity:   0.02,
		LinkDensity:    0.1,
	}
	if isLowSignal(mixedMedia, 0) {
		t.Fatal("a mixed-media detail must not be low signal")
	}
	domRisk := articleSignal{WordCount: 900, DomListRisk: 0.8, LinkDensity: 0.02}
	if !isLowSignal(domRisk, 0) {
		t.Fatal("high DOM list risk must be low signal")
	}
	inventory := articleSignal{WordCount: 600, LinkDensity: 0.02}
	if !isLowSignal(inventory, 45) {
		t.Fatal("a large link inventory must be low signal")
	}
	plain := articleSignal{WordCount: 1200, ParagraphCount: 12, LinkDensity: 0.03}
	if isLowSignal(plain, 3) {
		t.Fatal("a normal article must not be low signal")
	}
}

func TestAssessArticleMarkdownSignalListLike(t *testing.T) {
	lines := make([]string, 0, 20)
	for index := 0; index < 20; index++ {
		// Every line is distinct: normalizeMarkdownCandidate collapses repeated
		// identical short lines, which would erase the list under test.
		lines = append(lines, fmt.Sprintf("- [story %d](https://news.example.com/story-%d)", index, index))
	}
	article := crawl4ai.PipelineArticle{
		URL:      "https://news.example.com/latest/",
		Markdown: rawJSON(t, joinLines(lines)),
		Links: rawJSON(t, map[string][]map[string]any{
			"internal": {{"href": "https://news.example.com/story"}},
		}),
	}
	signal := assessArticleMarkdownSignal(article, true, fixedNow())
	if !signal.IsListLike {
		t.Fatalf("signal = %#v", signal)
	}
	if signal.DomListRisk <= 0 {
		t.Fatalf("domListRisk = %v", signal.DomListRisk)
	}
	if !isLowSignal(signal, countArticleLinks(article.Links)) {
		t.Fatal("a link list must be low signal")
	}
}

func TestAssessArticleMarkdownSignalPublishTimeAndMedia(t *testing.T) {
	article := crawl4ai.PipelineArticle{
		URL:         "https://news.example.com/2026/10/19/story",
		PublishedAt: json.RawMessage(`"2026-10-19T10:00:00Z"`),
		Markdown:    rawJSON(t, "Short bulletin body with enough words to pass the bulletin rule and stay readable."),
		Media:       rawJSON(t, map[string][]map[string]any{"images": {{}, {}}}),
	}
	signal := assessArticleMarkdownSignal(article, true, fixedNow())
	if signal.PublishTimeSource != publishTimeSourceMeta || signal.PublishTimeConfidence != 1 {
		t.Fatalf("publish time = %q/%v", signal.PublishTimeSource, signal.PublishTimeConfidence)
	}
	if signal.MediaDensity <= 0 {
		t.Fatalf("mediaDensity = %v", signal.MediaDensity)
	}
	if math.IsInf(signal.Score, -1) {
		t.Fatal("score must be finite for non-empty markdown")
	}
	empty := assessArticleMarkdownSignal(crawl4ai.PipelineArticle{}, true, fixedNow())
	if !math.IsInf(empty.Score, -1) || empty.WordCount != 0 {
		t.Fatalf("empty signal = %#v", empty)
	}
}

func TestSelectMarkdownForQualityPrefersFit(t *testing.T) {
	fit := "fit markdown"
	primary := "primary markdown"
	result := markdownResult{Fit: &fit, Primary: &primary}
	if got := selectMarkdownForQuality(result, true); got != fit {
		t.Fatalf("preferFit = %q", got)
	}
	if got := selectMarkdownForQuality(result, false); got != primary {
		t.Fatalf("primary = %q", got)
	}
	if got := selectMarkdownForQuality(markdownResult{}, true); got != "" {
		t.Fatalf("empty = %q", got)
	}
}

func TestResolvePublishTimeSignal(t *testing.T) {
	now := fixedNow()
	cases := []struct {
		name       string
		article    crawl4ai.PipelineArticle
		wantSource string
		wantConf   float64
	}{
		{
			name:       "publishedAt wins",
			article:    crawl4ai.PipelineArticle{PublishedAt: json.RawMessage(`"2026-10-19T10:00:00Z"`)},
			wantSource: publishTimeSourceMeta,
			wantConf:   1,
		},
		{
			name:       "article:published_time",
			article:    crawl4ai.PipelineArticle{Metadata: json.RawMessage(`{"article:published_time":"2026-10-19T10:00:00Z"}`)},
			wantSource: publishTimeSourceMeta,
			wantConf:   0.94,
		},
		{
			name:       "nested openGraph",
			article:    crawl4ai.PipelineArticle{Metadata: json.RawMessage(`{"openGraph":{"og:published_time":"2026-10-19T10:00:00Z"}}`)},
			wantSource: publishTimeSourceMeta,
			wantConf:   0.94,
		},
		{
			name:       "time tag",
			article:    crawl4ai.PipelineArticle{Metadata: json.RawMessage(`{"datetime":"2026-10-19T10:00:00Z"}`)},
			wantSource: publishTimeSourceTimeTag,
			wantConf:   0.9,
		},
		{
			name:       "jsonld",
			article:    crawl4ai.PipelineArticle{Metadata: json.RawMessage(`{"jsonld":{"@type":"Article","datePublished":"2026-10-19T10:00:00Z"}}`)},
			wantSource: publishTimeSourceJSONLD,
			wantConf:   0.98,
		},
		{
			name:       "url path",
			article:    crawl4ai.PipelineArticle{URL: "https://news.example.com/2026/10/19/story-slug"},
			wantSource: publishTimeSourceURLPath,
			wantConf:   0.7,
		},
		{
			name:       "none",
			article:    crawl4ai.PipelineArticle{URL: "https://news.example.com/story-slug"},
			wantSource: publishTimeSourceNone,
			wantConf:   0,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			confidence, source := resolvePublishTimeSignal(testCase.article, now)
			if source != testCase.wantSource || confidence != testCase.wantConf {
				t.Fatalf("signal = %q/%v, want %q/%v", source, confidence, testCase.wantSource, testCase.wantConf)
			}
		})
	}
}

func TestNormalizePublishTimeConfidence(t *testing.T) {
	now := fixedNow()
	// Fresh article: base plus the within-ten-days boost.
	fresh := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC).UnixMilli()
	if got := normalizePublishTimeConfidence(fresh, 0.62, now); got != 0.7 {
		t.Fatalf("fresh = %v", got)
	}
	// 30 days old: the smaller boost.
	month := time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC).UnixMilli()
	if got := normalizePublishTimeConfidence(month, 0.62, now); got != 0.65 {
		t.Fatalf("month = %v", got)
	}
	// Older than 45 days: no boost.
	old := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC).UnixMilli()
	if got := normalizePublishTimeConfidence(old, 0.62, now); got != 0.62 {
		t.Fatalf("old = %v", got)
	}
	// Implausible dates keep a third of the base confidence.
	preMillennium := time.Date(1999, 12, 31, 12, 0, 0, 0, time.UTC).UnixMilli()
	if got := normalizePublishTimeConfidence(preMillennium, 0.9, now); got != 0.315 {
		t.Fatalf("pre-2000 = %v", got)
	}
	farFuture := now.Add(30 * 24 * time.Hour).UnixMilli()
	if got := normalizePublishTimeConfidence(farFuture, 0.9, now); got != 0.315 {
		t.Fatalf("far future = %v", got)
	}
	if got := normalizePublishTimeConfidence(0, 0.9, now); got != 0 {
		t.Fatalf("zero timestamp = %v", got)
	}
}

func TestParseDateValueAndURLDate(t *testing.T) {
	cases := []struct {
		raw  string
		want bool
	}{
		{`"2026-10-19T10:00:00Z"`, true},
		{`"2026-10-19T10:00:00+08:00"`, true},
		{`"2026-10-19 10:00:00"`, true},
		{`"2026-10-19"`, true},
		{`"not a date"`, false},
		{`""`, false},
		{`12`, false},
		{`null`, false},
	}
	for _, testCase := range cases {
		if _, ok := parseDateValue(json.RawMessage(testCase.raw)); ok != testCase.want {
			t.Fatalf("parseDateValue(%s) = %v, want %v", testCase.raw, ok, testCase.want)
		}
	}
	value, ok := parseDateValue(json.RawMessage(`"2026-10-19T00:00:00Z"`))
	if !ok || value != time.Date(2026, 10, 19, 0, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("timestamp = %d", value)
	}

	valid, ok := parseDateFromArticleURL("https://news.example.com/2026/10/19/story")
	if !ok || valid != time.Date(2026, 10, 19, 0, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("url date = %d", valid)
	}
	if _, ok := parseDateFromArticleURL("https://news.example.com/2026/02/31/story"); ok {
		t.Fatal("an impossible calendar date must be rejected")
	}
	if _, ok := parseDateFromArticleURL("https://news.example.com/story"); ok {
		t.Fatal("a URL without a date must be rejected")
	}
}

func TestClassifyPageKindAndAutoExpand(t *testing.T) {
	low := make([]articleSignal, 8)
	assessments := make([]articleSignal, 10)
	if got := classifyPageKind(nil, nil, "auto"); got != "blocked" {
		t.Fatalf("empty kind = %q", got)
	}
	if got := classifyPageKind(assessments, low, "auto"); got != "list" {
		t.Fatalf("list kind = %q", got)
	}
	if got := classifyPageKind(assessments, low[:4], "auto"); got != "mixed" {
		t.Fatalf("mixed kind = %q", got)
	}
	if got := classifyPageKind(assessments, low[:2], "auto"); got != "detail" {
		t.Fatalf("detail kind = %q", got)
	}
	if got := classifyPageKind(assessments, low[:2], "detail"); got != "detail" {
		t.Fatalf("hint detail = %q", got)
	}

	options := crawloptionsWithAutoExpand(true)
	if !shouldAutoExpand(options, "auto", "list", false, 3) {
		t.Fatal("list pages must auto expand")
	}
	if shouldAutoExpand(options, "auto", "list", false, 0) {
		t.Fatal("a page without low-signal results must not auto expand")
	}
	disabled := crawloptionsWithAutoExpand(false)
	if shouldAutoExpand(disabled, "auto", "list", true, 3) {
		t.Fatal("autoExpandDetails=false must never expand")
	}
	if !shouldAutoExpand(options, "detail", "detail", true, 1) {
		t.Fatal("an all-low-signal detail hint must expand")
	}
}

func TestQualityIsSignificantDetailImprovement(t *testing.T) {
	improved := articleSignal{WordCount: 500, ParagraphCount: 5, LinkDensity: 0.02, Score: 400}
	if !isSignificantDetailImprovement(improved, 100, 50, 0.3) {
		t.Fatal("a long clean article must be an improvement")
	}
	if isSignificantDetailImprovement(articleSignal{WordCount: 0}, 100, 50, 0.3) {
		t.Fatal("an empty signal is never an improvement")
	}
	listLike := articleSignal{IsListLike: true, WordCount: 120, ParagraphCount: 2, LinkDensity: 0.3}
	if isSignificantDetailImprovement(listLike, 100, 80, 0.3) {
		t.Fatal("a short list page must not count as an improvement")
	}
	bigger := articleSignal{WordCount: 800, ParagraphCount: 1, LinkDensity: 0.2, Score: 100}
	if !isSignificantDetailImprovement(bigger, 100, 50, 0.5) {
		t.Fatal("a much longer page must count as an improvement")
	}
}

// joinLines joins markdown lines.
func joinLines(lines []string) string { return strings.Join(lines, "\n") }

// crawloptionsWithAutoExpand builds normalized options with one expansion flag.
func crawloptionsWithAutoExpand(enabled bool) normalizedOptions {
	value := enabled
	return crawloptions.NormalizeOptions(&crawloptions.OptionsInput{AutoExpandDetails: &value})
}
