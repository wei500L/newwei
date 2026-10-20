package archivereading

import "testing"

func TestDisplayEligibility(t *testing.T) {
	cases := []struct {
		sourceType string
		content    contentType
		path       string
		want       bool
	}{
		{"blog", contentTypeNewsFact, "intel", false},
		{"authoritative", contentTypeOpinion, "politics/geopolitics", false},
		{"unknown", contentTypeAnalysis, "", false},
		{"unknown", contentTypeNewsFact, "", true},
		{"unknown", contentTypeMixed, "", true},
		{"unknown", contentTypeAnalysis, "intel", true},
		{"unknown", contentTypeAnalysis, "politics/geopolitics/asia", true},
	}
	for _, tc := range cases {
		if got := shouldDisplay(tc.sourceType, tc.content, tc.path); got != tc.want {
			t.Fatalf("shouldDisplay(%q,%q,%q) = %t, want %t", tc.sourceType, tc.content, tc.path, got, tc.want)
		}
	}
}

func TestBackfillMissingDocumentVersusMissingFields(t *testing.T) {
	if needsBackfill(displaySignals{Exists: false}) {
		t.Fatal("a missing Mongo document is not a backfill target")
	}
	if !needsBackfill(displaySignals{Exists: true}) {
		t.Fatal("an existing document without content type needs backfill")
	}
	content := contentTypeNewsFact
	if !needsBackfill(displaySignals{Exists: true, ContentType: &content}) {
		t.Fatal("content type without a category field still needs backfill")
	}
	if needsBackfill(displaySignals{Exists: true, ContentType: &content, CategoryMethod: "llm"}) {
		t.Fatal("content type plus category method is complete")
	}
	if needsBackfill(displaySignals{Exists: true, ContentType: &content, CategoryPath: "intel"}) {
		t.Fatal("content type plus category path is complete")
	}
}

func TestNormalizeNewsContentTypeAliases(t *testing.T) {
	for raw, want := range map[string]contentType{
		"news-fact":        contentTypeNewsFact,
		"Op-Ed":            contentTypeOpinion,
		"分析":               contentTypeAnalysis,
		"fact_and_opinion": contentTypeMixed,
	} {
		value := raw
		got := normalizeNewsContentType(&value)
		if got == nil || *got != want {
			t.Fatalf("normalizeNewsContentType(%q) = %v, want %q", raw, got, want)
		}
	}
	unknown := "unknown"
	if normalizeNewsContentType(&unknown) != nil {
		t.Fatal("unknown content type accepted")
	}
}

func TestInferNewsContentType(t *testing.T) {
	if got := inferNewsContentType("Breaking report", "", "wire", "https://example.com/a", nil, nil); got != contentTypeNewsFact {
		t.Fatalf("fact inference = %q", got)
	}
	if got := inferNewsContentType("Opinion", "", "commentary", "https://example.com/opinion/x", nil, nil); got != contentTypeOpinion {
		t.Fatalf("opinion inference = %q", got)
	}
	if got := inferNewsContentType("Analysis", "", "", "https://example.com/analysis/x", nil, nil); got != contentTypeAnalysis {
		t.Fatalf("analysis inference = %q", got)
	}
}

func TestCategoryPathNormalization(t *testing.T) {
	cases := map[string]string{
		" /Intel//Sub/ ": "intel/sub",
		"":               "",
		"///":            "",
	}
	for raw, want := range cases {
		if got := normalizeCategoryPathValue(raw); got != want {
			t.Fatalf("normalizeCategoryPathValue(%q) = %q, want %q", raw, got, want)
		}
	}
}
