package crawlexecution

import (
	"encoding/json"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/crawloptions"
)

func TestExtractOptionsTypeGuards(t *testing.T) {
	config := map[string]json.RawMessage{
		"scanFullPage":       json.RawMessage(`true`),
		"wordCountThreshold": json.RawMessage(`120`),
		"includeImages":      json.RawMessage(`"yes"`), // wrong type: ignored
		"userAgent":          json.RawMessage(`"Mozilla/5.0 Test"`),
		"jsCode":             json.RawMessage(`["console.log(1)", 42]`),
		"markdownFilter":     json.RawMessage(`{"type":"bm25","userQuery":"climate"}`),
		"additionalUrls":     json.RawMessage(`["https://example.com/a","https://example.com/b"]`),
	}
	extracted := extractOptions(config)
	if extracted.ScanFullPage == nil || !*extracted.ScanFullPage {
		t.Fatal("scanFullPage must be decoded")
	}
	if extracted.WordCountThreshold == nil || *extracted.WordCountThreshold != 120 {
		t.Fatal("wordCountThreshold must be decoded")
	}
	if extracted.IncludeImages != nil {
		t.Fatal("a wrong-typed value must be ignored")
	}
	if extracted.UserAgent == nil || *extracted.UserAgent != "Mozilla/5.0 Test" {
		t.Fatal("userAgent must be decoded")
	}
	if len(extracted.JSCode) != 1 || extracted.JSCode[0] != "console.log(1)" {
		t.Fatalf("jsCode = %#v", extracted.JSCode)
	}
	if extracted.MarkdownFilter == nil || extracted.MarkdownFilter.Type != "bm25" {
		t.Fatal("markdownFilter must be decoded")
	}
	if len(extracted.AdditionalURLs) != 2 {
		t.Fatalf("additionalUrls = %#v", extracted.AdditionalURLs)
	}

	normalized := crawloptions.NormalizeOptions(extracted)
	if !normalized.ScanFullPage || normalized.WordCountThreshold == nil || *normalized.WordCountThreshold != 120 {
		t.Fatal("normalized scanFullPage/wordCountThreshold mismatch")
	}
	if normalized.AdjustViewportToContent != true {
		t.Fatal("scanFullPage must default adjustViewportToContent to true")
	}
	if normalized.SessionID != nil {
		t.Fatal("extractOptions must not invent a session id")
	}
}

func TestEnsureTaskSessionReuse(t *testing.T) {
	options := crawloptions.NormalizeOptions(&crawloptions.OptionsInput{})
	reused := ensureTaskSessionReuse(" Task/ABC 123 ", options)
	if reused.SessionID == nil || *reused.SessionID != "task-task-abc-123" {
		t.Fatalf("sessionId = %#v", reused.SessionID)
	}

	explicit := "keep-me"
	options.SessionID = &explicit
	kept := ensureTaskSessionReuse("task-1", options)
	if kept.SessionID == nil || *kept.SessionID != "keep-me" {
		t.Fatalf("explicit sessionId must win: %#v", kept.SessionID)
	}

	empty := ""
	options.SessionID = &empty
	replaced := ensureTaskSessionReuse("task-1", options)
	if replaced.SessionID == nil || *replaced.SessionID != "task-task-1" {
		t.Fatalf("empty sessionId must be replaced: %#v", replaced.SessionID)
	}
}

func TestBuildURLListDedupe(t *testing.T) {
	scroll := 5
	options := crawloptions.NormalizeOptions(&crawloptions.OptionsInput{
		AdditionalURLs: []string{"https://example.com/b", "https://example.com/a", "https://example.com/a"},
		MultiURLConfigs: []crawloptions.MultiURLConfig{{
			URLs: []string{"https://example.com/c"},
		}},
		VirtualScroll: &crawloptions.VirtualScroll{ScrollCount: &scroll},
	})
	urls := buildURLList("https://example.com/target", options)
	want := []string{
		"https://example.com/target",
		"https://example.com/b",
		"https://example.com/a",
		"https://example.com/c",
	}
	if len(urls) != len(want) {
		t.Fatalf("urls = %#v", urls)
	}
	for index, value := range want {
		if urls[index] != value {
			t.Fatalf("urls[%d] = %q, want %q", index, urls[index], value)
		}
	}
}

func TestCrawlOptionsMapping(t *testing.T) {
	threshold := 0.2
	filter := &crawloptions.MarkdownFilter{
		Type:             "pruning",
		Threshold:        &threshold,
		ThresholdType:    stringPtr("dynamic"),
		MinWordThreshold: intPtrOf(5),
	}
	scrollCount := 8
	scrollBy := json.RawMessage(`"page_height"`)
	waitAfter := 700
	options := crawloptions.NormalizeOptions(&crawloptions.OptionsInput{
		MarkdownFilter: filter,
		MarkdownOptions: &crawloptions.MarkdownOptionsInput{
			ContentSource: stringPtr("cleaned_html"),
			Citations:     boolPtr(true),
		},
		CleanMarkdown: &crawloptions.CleanMarkdownInput{
			RemoveOverlayElements: boolPtr(true),
			WordCountThreshold:    intPtrOf(18),
		},
		VirtualScroll: &crawloptions.VirtualScroll{
			ContainerSelector: "body",
			ScrollCount:       &scrollCount,
			ScrollBy:          scrollBy,
			WaitAfterScrollMs: &waitAfter,
		},
		SessionID: stringPtr("session-1"),
	})
	mapped := crawlOptionsForRequest(options)
	if mapped.MarkdownFilter == nil || mapped.MarkdownFilter.Type != "pruning" ||
		mapped.MarkdownFilter.MinWordThreshold == nil || *mapped.MarkdownFilter.MinWordThreshold != 5 {
		t.Fatalf("markdown filter mapping = %#v", mapped.MarkdownFilter)
	}
	if mapped.MarkdownOptions == nil || mapped.MarkdownOptions.ContentSource == nil ||
		*mapped.MarkdownOptions.ContentSource != "cleaned_html" {
		t.Fatalf("markdown options mapping = %#v", mapped.MarkdownOptions)
	}
	if mapped.CleanMarkdown == nil || mapped.CleanMarkdown.WordCountThreshold == nil ||
		*mapped.CleanMarkdown.WordCountThreshold != 18 {
		t.Fatalf("clean markdown mapping = %#v", mapped.CleanMarkdown)
	}
	if mapped.VirtualScroll == nil || mapped.VirtualScroll.ScrollBy == nil ||
		*mapped.VirtualScroll.ScrollBy != "page_height" {
		t.Fatalf("virtual scroll mapping = %#v", mapped.VirtualScroll)
	}
	if mapped.ScanFullPage {
		t.Fatal("virtualScroll must disable scanFullPage")
	}
	if mapped.SessionID == nil || *mapped.SessionID != "session-1" {
		t.Fatalf("session mapping = %#v", mapped.SessionID)
	}
}

func TestResolveDetailExpansionOptionsDefaults(t *testing.T) {
	resolved := resolveDetailExpansionOptions(crawloptions.NormalizeOptions(&crawloptions.OptionsInput{}))
	if resolved.MaxDetailUrls != 12 {
		t.Fatalf("maxDetailUrls = %d", resolved.MaxDetailUrls)
	}
	if resolved.MinRelevanceScore != 0.35 {
		t.Fatalf("minRelevanceScore = %v", resolved.MinRelevanceScore)
	}
	if !resolved.RequireSameDomain || !resolved.AllowExternalLinks {
		t.Fatal("default same-domain flags mismatch")
	}
	if len(resolved.ExcludeURLPatterns) == 0 {
		t.Fatal("default exclude patterns must be present")
	}

	maxURLs := 3
	minRelevance := 0.9
	requireSame := false
	overridden := resolveDetailExpansionOptions(crawloptions.NormalizeOptions(&crawloptions.OptionsInput{
		DetailExpansion: &crawloptions.DetailExpansion{
			MaxDetailUrls:     &maxURLs,
			MinRelevanceScore: &minRelevance,
			RequireSameDomain: &requireSame,
		},
	}))
	if overridden.MaxDetailUrls != 3 || overridden.MinRelevanceScore != 0.9 || overridden.RequireSameDomain {
		t.Fatalf("overridden = %#v", overridden)
	}
	if !overridden.AllowExternalLinks {
		t.Fatal("requireSameDomain=false must allow external links")
	}
}
