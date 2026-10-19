package gdeltsnapshot

import (
	"testing"
	"time"
)

// TestNormalizePayloadRebuildsDerivedMembers checks that a stored payload is
// re-derived the way the NestJS normalizePayload does before it reaches a
// caller (cache restore and status summary).
func TestNormalizePayloadRebuildsDerivedMembers(t *testing.T) {
	stored := `{
      "source":"other","scope":"other","variantKey":"other","status":"weird",
      "generatedAt":"2026-10-20T12:00:00.000Z","expiresAt":"2026-10-20T12:20:00.000Z",
      "partial":1,
      "warnings":[{"code":"gdelt_http_error","severity":"warning","message":"m"},7,null],
      "diagnostics":{"requestedCategories":"six","fetchedCategories":["politics","nope","politics"],
        "reusedCategories":["gov"],"failedCategories":[],"totalHeadlines":"x"},
      "categoryStates":{
        "politics":{"status":"reused","articleCount":2.9,"contentGeneratedAt":"","reasonCode":"  spaced  "},
        "gov":{"articleCount":-3}
      },
      "headlinesByCategory":{
        "politics":[{"id":"1","title":"a","link":"l","source":"s","timestamp":5,"category":"nope","origin":"gdelt","isAlert":false},7],
        "gov":"not an array"
      }
    }`
	payload := normalizePayload([]byte(stored))
	if payload == nil {
		t.Fatal("payload = nil, want a normalized snapshot")
	}
	if payload.Source != sourceName || payload.Scope != scope || payload.VariantKey != variantKey {
		t.Errorf("identity = %s/%s/%s", payload.Source, payload.Scope, payload.VariantKey)
	}
	if payload.Status != StatusCompleted {
		t.Errorf("status = %s, want completed for an unknown stored status", payload.Status)
	}
	if !payload.Partial {
		t.Error("partial = false, want true (Boolean(1))")
	}
	if len(payload.Warnings) != 1 || payload.Warnings[0].Code != codeHTTPError {
		t.Errorf("warnings = %+v, want only the object entry", payload.Warnings)
	}

	politics := payload.CategoryStates.Politics
	if politics.Status != categoryStatusReused || politics.ArticleCount != 2 {
		t.Errorf("politics state = %+v, want reused/2 (truncated 2.9)", politics)
	}
	if politics.ContentGeneratedAt == nil || *politics.ContentGeneratedAt != "2026-10-20T12:00:00.000Z" {
		t.Errorf("politics contentGeneratedAt = %v, want the snapshot timestamp fallback", politics.ContentGeneratedAt)
	}
	if politics.ReasonCode != "spaced" {
		t.Errorf("reasonCode = %q, want trimmed", politics.ReasonCode)
	}
	// gov has no stored status and no headlines: the fallback is empty, so the
	// article count is clamped to zero and the timestamp is null.
	gov := payload.CategoryStates.Gov
	if gov.Status != categoryStatusEmpty || gov.ArticleCount != 0 || gov.ContentGeneratedAt != nil {
		t.Errorf("gov state = %+v", gov)
	}

	if len(payload.HeadlinesByCategory.Politics) != 1 {
		t.Errorf("politics headlines = %+v, want the single object entry", payload.HeadlinesByCategory.Politics)
	}
	if payload.HeadlinesByCategory.Politics[0].Category != CategoryPolitics {
		t.Error("stored headline category was not forced to the bucket")
	}
	if len(payload.HeadlinesByCategory.Gov) != 0 || payload.HeadlinesByCategory.Gov == nil {
		t.Errorf("gov headlines = %+v, want an empty non-nil slice", payload.HeadlinesByCategory.Gov)
	}

	if payload.Diagnostics.RequestedCategories != 6 {
		t.Errorf("requestedCategories = %d, want the fallback 6", payload.Diagnostics.RequestedCategories)
	}
	if !equalCategories(payload.Diagnostics.FetchedCategories, []Category{CategoryPolitics, CategoryPolitics}) {
		t.Errorf("fetchedCategories = %v, want the known entries in order with duplicates", payload.Diagnostics.FetchedCategories)
	}
	if payload.Diagnostics.TotalHeadlines != 1 {
		t.Errorf("totalHeadlines = %d, want the derived count 1", payload.Diagnostics.TotalHeadlines)
	}
}

// TestNormalizePayloadRejectsUnusableDocuments covers the null cases.
func TestNormalizePayloadRejectsUnusableDocuments(t *testing.T) {
	cases := map[string]string{
		"empty":            "",
		"null":             "null",
		"array":            "[]",
		"missing times":    `{"status":"partial"}`,
		"numeric times":    `{"generatedAt":1,"expiresAt":2}`,
		"malformed":        `{"generatedAt":`,
		"blank generated":  `{"generatedAt":"","expiresAt":"2026-10-20T12:20:00.000Z"}`,
		"blank expiration": `{"generatedAt":"2026-10-20T12:00:00.000Z","expiresAt":""}`,
	}
	for name, document := range cases {
		if payload := normalizePayload([]byte(document)); payload != nil {
			t.Errorf("%s: payload = %+v, want nil", name, payload)
		}
	}
}

// TestNormalizeSnapshotHeadlinesFiltersPlaceholders pins the second-stage
// filtering: blank fields, placeholder titles, duplicates and the category cap.
func TestNormalizeSnapshotHeadlinesFiltersPlaceholders(t *testing.T) {
	headlines := []Headline{
		{Title: "  ", Link: "https://example.com/blank-title"},
		{Title: "Real", Link: "  "},
		{Title: "Untitled", Link: "https://example.com/untitled"},
		{Title: "No Title.", Link: "https://example.com/no-title"},
		{Title: "N/A", Link: "https://example.com/na"},
		{Title: "暂无标题", Link: "https://example.com/zh"},
		{Title: "  Kept title  ", Link: "  https://example.com/keep  "},
		{Title: "Duplicate", Link: "https://example.com/keep"},
	}
	normalized := normalizeSnapshotHeadlines(headlines, CategoryIntel)
	if len(normalized) != 1 {
		t.Fatalf("normalized = %+v, want one headline", normalized)
	}
	if normalized[0].Title != "Kept title" || normalized[0].Link != "https://example.com/keep" {
		t.Errorf("headline = %+v, want trimmed title and link", normalized[0])
	}
	if normalized[0].Category != CategoryIntel {
		t.Errorf("category = %s", normalized[0].Category)
	}
}

// TestNormalizeSnapshotHeadlinesCapsCategory proves the per-category cap.
func TestNormalizeSnapshotHeadlinesCapsCategory(t *testing.T) {
	headlines := make([]Headline, 0, 30)
	for index := 0; index < 30; index++ {
		headlines = append(headlines, Headline{
			Title: "Title",
			Link:  "https://example.com/" + string(rune('a'+index%26)) + string(rune('a'+index/26)),
		})
	}
	if got := len(normalizeSnapshotHeadlines(headlines, CategoryTech)); got != categoryLimit {
		t.Errorf("normalized = %d, want the cap %d", got, categoryLimit)
	}
}

// TestIsExpiredMatchesDateParse covers the expiry boundary.
func TestIsExpiredMatchesDateParse(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		expiresAt string
		want      bool
	}{
		{"2026-10-20T12:00:00.001Z", false},
		{"2026-10-20T12:00:00.000Z", true},
		{"2026-10-20T11:59:59.999Z", true},
		{"not a date", true},
		{"", true},
	}
	for _, testCase := range cases {
		if got := isExpired(testCase.expiresAt, now); got != testCase.want {
			t.Errorf("isExpired(%q) = %v, want %v", testCase.expiresAt, got, testCase.want)
		}
	}
}

// TestIsoTimeFormat pins the Date.toISOString shape.
func TestIsoTimeFormat(t *testing.T) {
	if got := isoTime(time.Date(2026, 1, 2, 3, 4, 5, 6000000, time.UTC)); got != "2026-01-02T03:04:05.006Z" {
		t.Errorf("isoTime = %q", got)
	}
	// Sub-millisecond precision is truncated, like Date's millisecond storage.
	if got := isoTime(time.Date(2026, 1, 2, 3, 4, 5, 123999999, time.UTC)); got != "2026-01-02T03:04:05.123Z" {
		t.Errorf("isoTime = %q, want truncation to milliseconds", got)
	}
}
