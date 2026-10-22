package crawlfrontiernode

// discover_test.go covers the two discovery decision points that are pure:
//
//   - extractFrontierNodeCandidates, the CrawlFrontierService.extractCandidates
//     wrapper (crawl-frontier.service.ts 3508-3545) that stamps the discovery
//     provenance (sourceTier/freshnessBucket/synthetic-list paths) onto the
//     candidates the node chain persists;
//   - the `seedDiscovery.mode = "disabled"` gate of discoverSitemapSeeds, which
//     is the one sitemap discovery mode the Go crawler chain cannot express
//     (crawl-metadata.service.ts 2361-2400).
//
// Both run without MySQL/Redis/Mongo: the extraction is a pure function of the
// crawl4ai result links plus the profile config, and the disabled gate answers
// before the sitemap service is touched.

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
)

// discoverTestNode is the depth-0 home node the extraction fixtures run on.
func discoverTestNode() *crawlfrontierllm.NodeRecord {
	return &crawlfrontierllm.NodeRecord{
		ID:         "node-discovery-test",
		RunID:      "run-discovery-test",
		OrgID:      "org-discovery-test",
		URL:        "https://example.com",
		PageType:   "home",
		Depth:      0,
		QueueClass: "hot",
		Status:     "running",
	}
}

// discoverTestResult is one crawl4ai result whose two in-domain links classify
// as an article and a category. The article matches the configured
// urlPatterns.article, so it clears the default 0.35 score threshold; with no
// list candidate the synthetic-list branch activates.
func discoverTestResult() []crawl4ai.PipelineArticle {
	return []crawl4ai.PipelineArticle{{
		URL: "https://example.com",
		Links: json.RawMessage(`{"internal":[
			{"href":"https://example.com/story/one","text":"One story"},
			{"href":"https://example.com/section/world","text":"World"}
		]}`),
	}}
}

// discoverCandidateByType finds the single accepted candidate of a page type.
func discoverCandidateByType(t *testing.T, candidates []crawlfrontierllm.Candidate, pageType string) crawlfrontierllm.Candidate {
	t.Helper()
	for _, candidate := range candidates {
		if candidate.PageType == pageType {
			return candidate
		}
	}
	t.Fatalf("no %s candidate in %d candidates", pageType, len(candidates))
	return crawlfrontierllm.Candidate{}
}

// discoverCandidateMetadata parses one candidate's metadata document.
func discoverCandidateMetadata(t *testing.T, candidate crawlfrontierllm.Candidate) *crawlfrontierllm.Object {
	t.Helper()
	metadata, ok := crawlfrontierllm.ParseObject(candidate.Metadata)
	if !ok {
		t.Fatalf("candidate %s metadata is not an object: %s", candidate.URL, candidate.Metadata)
	}
	return metadata
}

func TestExtractFrontierNodeCandidatesAppliesDiscoveryProvenance(t *testing.T) {
	service := testService()
	node := discoverTestNode()
	config := testObject(t, `{"sourceTier":"tier1","urlPatterns":{"article":["/story/"]}}`)

	extraction := service.extractFrontierNodeCandidates(node, config, discoverTestResult())
	if len(extraction.Candidates) != 2 {
		t.Fatalf("candidates = %d, want 2", len(extraction.Candidates))
	}

	// The article candidate carries the synthetic-list marking: the parent is a
	// home node with articles but no list candidate, so every article candidate is
	// treated as a synthetic list page.
	article := discoverCandidateByType(t, extraction.Candidates, "article")
	articleMetadata := discoverCandidateMetadata(t, article)
	if got, _ := articleMetadata.String("sourceTier"); got != "tier1" {
		t.Fatalf("article sourceTier = %q, want tier1", got)
	}
	// estimateFreshnessScore finds no /YYYY/M/D/ segment in the fixture URL.
	if got, _ := articleMetadata.String("freshnessBucket"); got != "unknown" {
		t.Fatalf("article freshnessBucket = %q, want unknown", got)
	}
	if got, ok := articleMetadata.Bool("syntheticList"); !ok || !got {
		t.Fatalf("article syntheticList = %v (present=%v), want true", got, ok)
	}
	if got, _ := articleMetadata.UntrimmedString("syntheticListLabel"); got != "one" {
		t.Fatalf("article syntheticListLabel = %q, want the first non-generic path segment", got)
	}
	for _, key := range []string{"discoveryPath", "frontierPath"} {
		raw, ok := articleMetadata.Raw(key)
		if !ok {
			t.Fatalf("article metadata has no %s", key)
		}
		if want := `["home","synthetic_list","article"]`; string(raw) != want {
			t.Fatalf("article %s = %s, want %s", key, raw, want)
		}
	}

	// The category candidate keeps the plain two-element path and an explicit
	// null syntheticList marker.
	category := discoverCandidateByType(t, extraction.Candidates, "category")
	categoryMetadata := discoverCandidateMetadata(t, category)
	if raw, ok := categoryMetadata.Raw("syntheticList"); !ok || string(raw) != "null" {
		t.Fatalf("category syntheticList = %s (present=%v), want null", raw, ok)
	}
	for _, key := range []string{"discoveryPath", "frontierPath"} {
		raw, ok := categoryMetadata.Raw(key)
		if !ok {
			t.Fatalf("category metadata has no %s", key)
		}
		if want := `["home","category"]`; string(raw) != want {
			t.Fatalf("category %s = %s, want %s", key, raw, want)
		}
	}

	// The diagnostics report the synthetic-list activation and keep the extraction
	// counters, with `selected` recomputed from the stamped candidate list.
	diagnostics := extraction.Diagnostics
	if diagnostics == nil {
		t.Fatal("extraction has no diagnostics")
	}
	if got, ok := diagnostics.Bool("syntheticListActivated"); !ok || !got {
		t.Fatalf("diagnostics syntheticListActivated = %v (present=%v), want true", got, ok)
	}
	flags := crawlfrontierllm.ObjectStrings(diagnostics, "warningFlags")
	if len(flags) != 1 || flags[0] != "synthetic_list_activated" {
		t.Fatalf("diagnostics warningFlags = %v, want [synthetic_list_activated]", flags)
	}
	stats, ok := diagnostics.Object("candidateStats")
	if !ok {
		t.Fatal("diagnostics have no candidateStats")
	}
	if got, ok := stats.Number("selected"); !ok || got != 2 {
		t.Fatalf("candidateStats.selected = %v (present=%v), want 2", got, ok)
	}
	if got, ok := stats.Number("accepted"); !ok || got != 2 {
		t.Fatalf("candidateStats.accepted = %v (present=%v), want 2", got, ok)
	}

	// Every decision that names an accepted candidate carries the stamped object,
	// so the workflow trace explains the same candidate the node was created from.
	stampedDecisions := 0
	for _, decision := range extraction.Decisions {
		if decision.Candidate.URL != article.URL {
			continue
		}
		stampedDecisions++
		metadata := discoverCandidateMetadata(t, decision.Candidate)
		if got, ok := metadata.Bool("syntheticList"); !ok || !got {
			t.Fatalf("decision %s syntheticList = %v (present=%v), want true", decision.NodeType, got, ok)
		}
		if got, _ := metadata.String("sourceTier"); got != "tier1" {
			t.Fatalf("decision %s sourceTier = %q, want tier1", decision.NodeType, got)
		}
	}
	if stampedDecisions == 0 {
		t.Fatal("no decision trace references the accepted article candidate")
	}
}

func TestExtractFrontierNodeCandidatesWithoutSyntheticList(t *testing.T) {
	service := testService()
	node := discoverTestNode()
	// A list candidate in the same candidate set keeps the synthetic-list branch
	// off: shouldUseSyntheticList requires articles and no list page.
	config := testObject(t, `{"sourceTier":"tier2","urlPatterns":{"article":["/story/"],"list":["/latest/"]}}`)
	results := []crawl4ai.PipelineArticle{{
		URL: "https://example.com",
		Links: json.RawMessage(`{"internal":[
			{"href":"https://example.com/story/one","text":"One story"},
			{"href":"https://example.com/latest/","text":"Latest"}
		]}`),
	}}

	extraction := service.extractFrontierNodeCandidates(node, config, results)
	if got, ok := extraction.Diagnostics.Bool("syntheticListActivated"); !ok || got {
		t.Fatalf("diagnostics syntheticListActivated = %v (present=%v), want false", got, ok)
	}
	if flags := crawlfrontierllm.ObjectStrings(extraction.Diagnostics, "warningFlags"); len(flags) != 0 {
		t.Fatalf("diagnostics warningFlags = %v, want []", flags)
	}
	for _, candidate := range extraction.Candidates {
		metadata := discoverCandidateMetadata(t, candidate)
		if raw, ok := metadata.Raw("syntheticList"); !ok || string(raw) != "null" {
			t.Fatalf("%s syntheticList = %s (present=%v), want null", candidate.PageType, raw, ok)
		}
		raw, ok := metadata.Raw("discoveryPath")
		if !ok {
			t.Fatalf("%s metadata has no discoveryPath", candidate.PageType)
		}
		if want := `["home","` + candidate.PageType + `"]`; string(raw) != want {
			t.Fatalf("%s discoveryPath = %s, want %s", candidate.PageType, raw, want)
		}
	}
}

func TestDiscoverSitemapSeedsHonorsDisabledMode(t *testing.T) {
	service := testService()
	// testService has no sitemap discovery service, so only the disabled gate can
	// produce a diagnostics document here.
	result, err := service.discoverSitemapSeeds(context.Background(), sitemapSeedInput{
		Domain:        "https://example.com",
		MaxURLs:       10,
		DiscoveryMode: "disabled",
	})
	if err != nil {
		t.Fatalf("discover sitemap seeds: %v", err)
	}
	if result == nil {
		t.Fatal("disabled mode returned no result")
	}
	if result.Candidates == nil || len(result.Candidates) != 0 {
		t.Fatalf("disabled mode candidates = %v, want the empty array", result.Candidates)
	}
	if result.Diagnostics == nil {
		t.Fatal("disabled mode returned no diagnostics")
	}
	if mode, _ := result.Diagnostics.String("discoveryMode"); mode != "disabled" {
		t.Fatalf("diagnostics discoveryMode = %q, want disabled", mode)
	}
	if count, ok := result.Diagnostics.Number("candidateCount"); !ok || count != 0 {
		t.Fatalf("diagnostics candidateCount = %v (present=%v), want 0", count, ok)
	}

	// A discovery mode that is not disabled goes on to the sitemap service, which
	// answers with the bare empty result when it is not configured. The difference
	// is what proves the gate runs before any fetch.
	robots, err := service.discoverSitemapSeeds(context.Background(), sitemapSeedInput{
		Domain:        "https://example.com",
		MaxURLs:       10,
		DiscoveryMode: "robots",
	})
	if err != nil {
		t.Fatalf("discover sitemap seeds (robots): %v", err)
	}
	if robots == nil || robots.Diagnostics != nil {
		t.Fatalf("robots mode diagnostics = %v, want the unconfigured empty result", robots)
	}
}
