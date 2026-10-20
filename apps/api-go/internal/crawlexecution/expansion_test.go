package crawlexecution

import (
	"encoding/json"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawloptions"
)

func TestDetailCandidateSelection(t *testing.T) {
	links := map[string][]map[string]any{
		"internal": {
			{"href": "/2026/10/20/a-long-article-slug-about-climate"},
			{"href": "/tag/climate"},
			{"href": "/author/jane-doe"},
			{"href": "https://other.example.com/2026/10/20/external-story-slug"},
		},
		"external": {
			{"href": "https://other.example.com/2026/10/20/external-story-slug"},
		},
	}
	rawLinks, err := json.Marshal(links)
	if err != nil {
		t.Fatal(err)
	}
	article := crawl4ai.PipelineArticle{URL: "https://news.example.com/", Links: rawLinks}
	options := resolveDetailExpansionOptions(crawloptions.NormalizeOptions(&crawloptions.OptionsInput{}))
	candidates := extractDetailLinkCandidates(article, article.URL, options)
	if len(candidates) != 2 {
		t.Fatalf("candidates = %#v", candidates)
	}
	// Buckets are walked in sorted key order (external before internal) so the
	// selection is deterministic.
	if candidates[0] != "https://other.example.com/2026/10/20/external-story-slug" {
		t.Fatalf("candidate = %q", candidates[0])
	}
	if candidates[1] != "https://news.example.com/2026/10/20/a-long-article-slug-about-climate" {
		t.Fatalf("candidate = %q", candidates[1])
	}

	// Excluding the article path pattern filters the candidate out.
	excluded := options
	excluded.ExcludeURLPatterns = append(append([]string(nil), options.ExcludeURLPatterns...), "*a-long-article*")
	if got := extractDetailLinkCandidates(article, article.URL, excluded); len(got) != 0 {
		t.Fatalf("exclude pattern did not filter: %#v", got)
	}

	// allowExternalLinks=false with requireSameDomain=false keeps the same-domain rule.
	blockedExternal := options
	blockedExternal.AllowExternalLinks = false
	blockedExternal.RequireSameDomain = true
	// Both hosts share the root domain "example.com", so this still resolves to
	// two candidates; a different root domain would be blocked by the link
	// filter, which is covered by isLikelyDetailArticleURL tests.
	if got := extractDetailLinkCandidates(article, article.URL, blockedExternal); len(got) != 2 {
		t.Fatalf("same-root-domain candidates = %#v", got)
	}
}

func TestShouldAutoExpand(t *testing.T) {
	options := crawloptions.NormalizeOptions(&crawloptions.OptionsInput{})
	if !options.AutoExpandDetails {
		t.Fatal("autoExpandDetails defaults to true")
	}
	if !shouldAutoExpand(options, "list", "list", false, 1) {
		t.Fatal("list hint must auto expand when low signal candidates exist")
	}
	if shouldAutoExpand(options, "auto", "detail", false, 0) {
		t.Fatal("no low-signal candidates must not auto expand")
	}
	if !shouldAutoExpand(options, "auto", "detail", true, 1) {
		t.Fatal("all-low-signal page must auto expand")
	}
	disabled := options
	disabled.AutoExpandDetails = false
	if shouldAutoExpand(disabled, "list", "list", true, 1) {
		t.Fatal("autoExpandDetails=false must disable expansion")
	}
}

func TestIsSignificantDetailImprovement(t *testing.T) {
	base := articleSignal{WordCount: 40, ParagraphCount: 1, LinkCount: 18, LinkDensity: 0.45, IsListLike: true, Score: 30}
	improved := articleSignal{WordCount: 600, ParagraphCount: 8, HeadingCount: 2, LinkCount: 4, LinkDensity: 0.006, IsListLike: false, Score: 900}
	if !isSignificantDetailImprovement(improved, base.Score, base.WordCount, base.LinkDensity) {
		t.Fatal("a long article must count as a significant improvement")
	}
	listLike := articleSignal{WordCount: 120, ParagraphCount: 2, LinkCount: 30, LinkDensity: 0.25, IsListLike: true, Score: 60}
	if isSignificantDetailImprovement(listLike, 200, 100, 0.2) {
		t.Fatal("another list-like page must not count as an improvement")
	}
}

func TestScoreDetailCandidateURLAndConfidence(t *testing.T) {
	articleURL := "https://news.example.com/2026/10/20/some-article-slug-title"
	sectionURL := "https://news.example.com/business"
	articleScore := scoreDetailCandidateURL(articleURL, "https://news.example.com/2026/10/20/list-page")
	sectionScore := scoreDetailCandidateURL(sectionURL, "https://news.example.com/2026/10/20/list-page")
	if articleScore <= sectionScore {
		t.Fatalf("article score %v must beat section score %v", articleScore, sectionScore)
	}
	if confidence := estimatePublishTimeConfidenceFromCandidateURL(articleURL); confidence != 0.82 {
		t.Fatalf("date path confidence = %v", confidence)
	}
	if confidence := estimatePublishTimeConfidenceFromCandidateURL("https://news.example.com/1234567"); confidence != 0.74 {
		t.Fatalf("numeric id confidence = %v", confidence)
	}
}

func TestExtractPrimaryPathSegment(t *testing.T) {
	if got := extractPrimaryPathSegment("https://news.example.com/World/2026/10/20/story"); got != "world" {
		t.Fatalf("segment = %q", got)
	}
	if !urlMatchesPrimaryPathSegment("https://news.example.com/world/2026/10/20/story", "world") {
		t.Fatal("path segment must match")
	}
	if urlMatchesPrimaryPathSegment("https://news.example.com/business/2026/10/20/story", "world") {
		t.Fatal("different path segment must not match")
	}
}
