package assistantruns

import (
	"testing"
	"time"
)

func TestMergeRenderedNewsPrecedence(t *testing.T) {
	published := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	metaPublished := "2026-10-19T12:00:00.000Z"
	ref := "507f1f77bcf86cd799439011"
	url := "https://example.test/a"
	source := "wire"
	title := "Processed title"
	summary := "Processed summary"
	label := "negative"
	fallbackSentiment := "neutral"
	processedPublished := "2026-10-18T08:00:00.000Z"
	rows := []NewsSourceRow{
		{ID: "meta-1", MongoRef: &ref, Name: stringPtr("Meta title"), PublishedAt: &published},
		{ID: "meta-2", Name: stringPtr("Only meta")},
	}
	raw := map[string]rawPayload{ref: {URL: &url, SourceName: &source}}
	processed := map[string]processedResult{
		"meta-1": {
			Title:      &title,
			Summary:    &summary,
			SentimentL: &label,
			Published:  &processedPublished,
		},
		"meta-2": {
			Sentiment: &fallbackSentiment,
		},
	}
	items := mergeRenderedNews(rows, raw, processed)
	if len(items) != 2 {
		t.Fatalf("items = %d", len(items))
	}
	first := items[0]
	if first.ItemMetaID != "meta-1" || first.Title == nil || *first.Title != title ||
		first.Summary == nil || *first.Summary != summary ||
		first.Sentiment == nil || *first.Sentiment != label ||
		first.URL == nil || *first.URL != url || first.Source == nil || *first.Source != source ||
		first.PublishedAt == nil || *first.PublishedAt != processedPublished {
		t.Fatalf("first = %+v", first)
	}
	second := items[1]
	if second.Title == nil || *second.Title != "Only meta" || second.URL != nil || second.Source != nil ||
		second.Sentiment == nil || *second.Sentiment != fallbackSentiment || second.PublishedAt != nil {
		t.Fatalf("second = %+v", second)
	}
	// The raw meta publishedAt is used when the processed row carries none.
	rawOnly := mergeRenderedNews([]NewsSourceRow{{ID: "meta-3", Name: stringPtr("x"), PublishedAt: &published}}, nil, nil)
	if rawOnly[0].PublishedAt == nil || *rawOnly[0].PublishedAt != metaPublished {
		t.Fatalf("meta publishedAt = %v", rawOnly[0].PublishedAt)
	}
}
