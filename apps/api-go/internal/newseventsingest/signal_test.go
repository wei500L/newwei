package newseventsingest

import (
	"encoding/json"
	"testing"
	"time"
)

// fixedNow is the clock every signal test freezes.
var fixedNow = time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)

func timePointer(value time.Time) *time.Time { return &value }

func stringPtr(value string) *string { return &value }

func floatPtr(value float64) *float64 { return &value }

// TestBuildNewsSignalMatchesNestValues walks the NestJS builder field by field
// against a ProcessedArticle with every optional column set and a ProcessedItem
// result carrying both the classification and sentiment leaves.
func TestBuildNewsSignalMatchesNestValues(t *testing.T) {
	publishedAt := time.Date(2026, 10, 19, 8, 30, 0, 0, time.UTC)
	processedAt := time.Date(2026, 10, 19, 9, 0, 0, 0, time.UTC)
	crawlAt := time.Date(2026, 10, 19, 8, 35, 0, 0, time.UTC)
	result := json.RawMessage(`{
		"sentiment_label": "Pos",
		"category": " Politics ",
		"category_path": "World\\Europe / Politics",
		"category_confidence": 1.4
	}`)

	signal := BuildNewsSignalFromProcessedArticle(BuildNewsSignalInput{
		ProcessedArticle: ProcessedArticleRecord{
			ID:                 "cpa_1",
			ArticleID:          "ca_1",
			ProcessedAt:        &processedAt,
			PublishedAt:        &publishedAt,
			Language:           stringPtr("  en  "),
			Title:              stringPtr("  Title  "),
			Summary:            stringPtr("Summary"),
			Category:           stringPtr("tech"),
			TopicsJSON:         []byte(`[" Tech ", {"name":" AI "},{"topic":"Markets"},"", "Tech"]`),
			EntitiesJSON:       []byte(`["Alpha", {"name":" Beta ","type":"ORG","confidence":1.7}, {"name":"   "}, {"type":"ORG"}, 7]`),
			QualityScore:       floatPtr(1.2),
			CleanedMarkdownRef: stringPtr(" 675f1f2e9d3c4b5a6e7f8a90 "),
			ArticleCrawlAt:     &crawlAt,
		},
		ProcessedItemResult: result,
		Now:                 fixedNow,
	})

	if signal.ArticleID != "ca_1" || signal.ProcessedArticleID != "cpa_1" {
		t.Fatalf("ids = %q/%q", signal.ArticleID, signal.ProcessedArticleID)
	}
	if signal.ProcessedItemID == nil || *signal.ProcessedItemID != "675f1f2e9d3c4b5a6e7f8a90" {
		t.Fatalf("ProcessedItemID = %v", signal.ProcessedItemID)
	}
	if !signal.Timestamp.Equal(publishedAt) {
		t.Fatalf("Timestamp = %v, want %v", signal.Timestamp, publishedAt)
	}
	if signal.Language == nil || *signal.Language != "en" {
		t.Fatalf("Language = %v", signal.Language)
	}
	if signal.Title == nil || *signal.Title != "Title" {
		t.Fatalf("Title = %v", signal.Title)
	}
	if signal.Summary == nil || *signal.Summary != "Summary" {
		t.Fatalf("Summary = %v", signal.Summary)
	}

	// normalizeTopics: trimmed strings, object name then topic, blanks dropped,
	// duplicates removed preserving the first occurrence.
	wantTopics := []string{"Tech", "AI", "Markets"}
	if len(signal.Topics) != len(wantTopics) {
		t.Fatalf("Topics = %#v, want %#v", signal.Topics, wantTopics)
	}
	for index, want := range wantTopics {
		if signal.Topics[index] != want {
			t.Fatalf("Topics[%d] = %q, want %q", index, signal.Topics[index], want)
		}
	}

	// normalizeEntities: string entries become nameless-type entities, object
	// entries need a name, and the confidence is clamped into 0..1.
	if len(signal.Entities) != 2 {
		t.Fatalf("Entities = %#v", signal.Entities)
	}
	if signal.Entities[0].Name != "Alpha" || signal.Entities[0].Type != nil || signal.Entities[0].Confidence != nil {
		t.Fatalf("Entities[0] = %#v", signal.Entities[0])
	}
	if signal.Entities[1].Name != "Beta" || signal.Entities[1].Type == nil || *signal.Entities[1].Type != "ORG" {
		t.Fatalf("Entities[1] = %#v", signal.Entities[1])
	}
	if signal.Entities[1].Confidence == nil || *signal.Entities[1].Confidence != 1 {
		t.Fatalf("Entities[1].Confidence = %v", signal.Entities[1].Confidence)
	}

	if signal.Sentiment == nil || *signal.Sentiment != NewsSentimentLabelPositive {
		t.Fatalf("Sentiment = %v", signal.Sentiment)
	}
	if signal.QualityScore == nil || *signal.QualityScore != 1 {
		t.Fatalf("QualityScore = %v", signal.QualityScore)
	}
	// The result classification wins over ProcessedArticle.category.
	if signal.LegacyCategory == nil || *signal.LegacyCategory != "politics" {
		t.Fatalf("LegacyCategory = %v", signal.LegacyCategory)
	}
	if signal.CategoryPath == nil || *signal.CategoryPath != "world/europe/politics" {
		t.Fatalf("CategoryPath = %v", signal.CategoryPath)
	}
	if signal.CategoryConfidence == nil || *signal.CategoryConfidence != 1 {
		t.Fatalf("CategoryConfidence = %v", signal.CategoryConfidence)
	}
}

// TestBuildNewsSignalFallsBackToArticleCategory locks the `?? ProcessedArticle.category`
// fallback and the empty process result.
func TestBuildNewsSignalFallsBackToArticleCategory(t *testing.T) {
	processedAt := time.Date(2026, 10, 19, 9, 0, 0, 0, time.UTC)
	signal := BuildNewsSignalFromProcessedArticle(BuildNewsSignalInput{
		ProcessedArticle: ProcessedArticleRecord{
			ID:          "cpa_2",
			ArticleID:   "ca_2",
			ProcessedAt: &processedAt,
			Category:    stringPtr("TECH"),
		},
		Now: fixedNow,
	})
	if signal.LegacyCategory == nil || *signal.LegacyCategory != "tech" {
		t.Fatalf("LegacyCategory = %v", signal.LegacyCategory)
	}
	if signal.CategoryPath != nil || signal.CategoryConfidence != nil {
		t.Fatalf("path/confidence = %v/%v, want nil", signal.CategoryPath, signal.CategoryConfidence)
	}
	// No publishedAt and no crawlAt: processedAt wins.
	if !signal.Timestamp.Equal(processedAt) {
		t.Fatalf("Timestamp = %v", signal.Timestamp)
	}
	if signal.Topics != nil || signal.Entities != nil {
		t.Fatalf("topics/entities = %#v/%#v, want nil", signal.Topics, signal.Entities)
	}
}

// TestBuildNewsSignalClampsFutureTimestamp locks clampFutureTimestamp: a future
// publishedAt collapses to now.
func TestBuildNewsSignalClampsFutureTimestamp(t *testing.T) {
	future := fixedNow.Add(time.Hour)
	processedAt := fixedNow.Add(-time.Hour)
	signal := BuildNewsSignalFromProcessedArticle(BuildNewsSignalInput{
		ProcessedArticle: ProcessedArticleRecord{
			ID:          "cpa_3",
			ArticleID:   "ca_3",
			ProcessedAt: &processedAt,
			PublishedAt: &future,
		},
		Now: fixedNow,
	})
	if !signal.Timestamp.Equal(fixedNow) {
		t.Fatalf("Timestamp = %v, want %v", signal.Timestamp, fixedNow)
	}
}

// TestNormalizeSentimentLabelPrefixes locks the positive/negative/neutral prefix
// ladder and the lower-cased comparison.
func TestNormalizeSentimentLabelPrefixes(t *testing.T) {
	cases := map[string]*NewsSentimentLabel{
		`"positive"`:    labelPointer(NewsSentimentLabelPositive),
		`" POSITIVE "`:  labelPointer(NewsSentimentLabelPositive),
		`"pos"`:         labelPointer(NewsSentimentLabelPositive),
		`"negative"`:    labelPointer(NewsSentimentLabelNegative),
		`"Neg "`:        labelPointer(NewsSentimentLabelNegative),
		`"neutral"`:     labelPointer(NewsSentimentLabelNeutral),
		`"neu-ish"`:     labelPointer(NewsSentimentLabelNeutral),
		`"unknown"`:     nil,
		`"po"`:          nil,
		`7`:             nil,
		`null`:          nil,
		`{"a":1}`:       nil,
		`"neutralish "`: labelPointer(NewsSentimentLabelNeutral),
	}
	for raw, want := range cases {
		got := normalizeSentimentLabel(json.RawMessage(raw))
		if want == nil {
			if got != nil {
				t.Fatalf("%s => %v, want nil", raw, *got)
			}
			continue
		}
		if got == nil || *got != *want {
			t.Fatalf("%s => %v, want %v", raw, got, *want)
		}
	}
}

func labelPointer(value NewsSentimentLabel) *NewsSentimentLabel { return &value }

// TestNormalizeLegacyCategoryWhitelist locks the closed category set.
func TestNormalizeLegacyCategoryWhitelist(t *testing.T) {
	allowed := []string{"politics", "tech", "finance", "gov", "ai", "intel"}
	for _, value := range allowed {
		input := "  " + value + "  "
		if got := normalizeLegacyCategory(&input); got == nil || *got != value {
			t.Fatalf("%q => %v, want %q", input, got, value)
		}
	}
	for _, value := range []string{"", "  ", "sports", "tech ", "Tech2"} {
		input := value
		if got := normalizeLegacyCategory(&input); got != nil {
			t.Fatalf("%q => %q, want nil", value, *got)
		}
	}
}

// TestNormalizeCategoryPathUsesJavaScriptWhitespace locks the Unicode whitespace
// rule: the JS `\s` set (which includes U+FEFF and excludes U+0085) becomes one
// dash, while Go's regexp \s would not.
func TestNormalizeCategoryPathUsesJavaScriptWhitespace(t *testing.T) {
	cases := map[string]string{
		"World\\Europe / Politics": "world/europe/politics",
		"//A//B//":                 "a/b",
		"  A  B  ":                 "a-b",
		"A\u00a0B":                 "a-b",
		"A\ufeffB":                 "a-b",
		"A\u2028B":                 "a-b",
		"A\u3000B":                 "a-b",
		// U+0085 is Go's IsSpace but NOT a JavaScript \s, so it must survive.
		"A\u0085B":                           "a\u0085b",
		"World/\u00a0Europe\u00a0/ Politics": "world/europe/politics",
		"\u00a0":                             "",
		"a\u2000\u2001b":                     "a-b",
		"Tech/Ünïcode  Path":                 "tech/ünïcode-path",
	}
	for input, want := range cases {
		got := normalizeCategoryPath(&input)
		if want == "" {
			if got != nil {
				t.Fatalf("%q => %q, want nil", input, *got)
			}
			continue
		}
		if got == nil || *got != want {
			t.Fatalf("%q => %v, want %q", input, got, want)
		}
	}
}

// TestNormalizeTopicsAndEntitiesNonArrays covers the Array.isArray negative
// branch.
func TestNormalizeTopicsAndEntitiesNonArrays(t *testing.T) {
	for _, raw := range []string{"null", `"x"`, `{"name":"a"}`, `7`} {
		if got := normalizeTopics([]byte(raw)); got != nil {
			t.Fatalf("normalizeTopics(%s) = %#v, want nil", raw, got)
		}
		if got := normalizeEntities([]byte(raw)); got != nil {
			t.Fatalf("normalizeEntities(%s) = %#v, want nil", raw, got)
		}
	}
}
