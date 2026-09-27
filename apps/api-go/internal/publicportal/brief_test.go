package publicportal

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"
)

func TestBriefFingerprintMatchesNestStringify(t *testing.T) {
	got := briefFingerprint("zh", "2026-09-27T12:00:00.000Z", []briefSource{{
		URL:                "https://example.com/a",
		ProcessedArticleID: "pa1",
	}})
	wantJSON := `{"version":1,"language":"zh","lastAt":"2026-09-27T12:00:00.000Z","sources":[{"processedArticleId":"pa1","processedItemId":null,"url":"https://example.com/a"}]}`
	sum := sha256.Sum256([]byte(wantJSON))
	if got != hex.EncodeToString(sum[:]) {
		t.Fatalf("fingerprint = %s", got)
	}
}

func TestSelectBriefSourcesPrefersDistinctLabels(t *testing.T) {
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	older := now.Add(-time.Hour)
	sources := selectBriefSources([]BriefItem{
		{URL: "https://www.reuters.com/old", SourceLabel: "Reuters", HasPublishedAt: true, PublishedAt: older, ProcessedArticleID: "old"},
		{URL: "https://www.reuters.com/new", SourceLabel: "Reuters", HasPublishedAt: true, PublishedAt: now, ProcessedArticleID: "new"},
		{URL: "https://apnews.com/a", SourceLabel: "AP", HasPublishedAt: true, PublishedAt: now.Add(-time.Minute), ProcessedArticleID: "ap"},
	}, 10)
	if len(sources) != 3 {
		t.Fatalf("sources = %+v", sources)
	}
	if sources[0].ProcessedArticleID != "new" || sources[1].ProcessedArticleID != "ap" || sources[2].ProcessedArticleID != "old" {
		t.Fatalf("order = %+v", sources)
	}
	if sources[0].Index != 1 {
		t.Fatalf("index = %d", sources[0].Index)
	}
}
