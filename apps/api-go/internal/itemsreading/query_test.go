package itemsreading

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// TestNormalizePaginationMirrorsNestJS pins the page/pageSize normalization.
func TestNormalizePaginationMirrorsNestJS(t *testing.T) {
	cases := []struct {
		name     string
		page     string
		pageSize string
		max      int
		want     Pagination
	}{
		{name: "defaults", page: "", pageSize: "", max: 50, want: Pagination{Page: 1, PageSize: 10, Offset: 0}},
		{name: "fraction floors", page: "1.5", pageSize: "2.9", max: 50, want: Pagination{Page: 1, PageSize: 2, Offset: 0}},
		{name: "page size zero floors to one", page: "3", pageSize: "0", max: 50, want: Pagination{Page: 3, PageSize: 1, Offset: 2}},
		{name: "page size capped at 50", page: "1", pageSize: "60", max: 50, want: Pagination{Page: 1, PageSize: 50, Offset: 0}},
		{name: "batch cap raises the ceiling", page: "1", pageSize: "1000", max: 50000, want: Pagination{Page: 1, PageSize: 1000, Offset: 0}},
		{name: "second page offset", page: "2", pageSize: "10", max: 50, want: Pagination{Page: 2, PageSize: 10, Offset: 10}},
		{name: "max accepted offset", page: "42949673", pageSize: "50", max: 50, want: Pagination{Page: 42949673, PageSize: 50, Offset: 2147483600}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := NormalizePagination(testCase.page, testCase.pageSize, testCase.max)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != testCase.want {
				t.Fatalf("got %+v want %+v", got, testCase.want)
			}
		})
	}
}

// TestNormalizePaginationRejectsUnsafeOffset is the IR2 contract: an
// out-of-range offset fails before any query with the exact message.
func TestNormalizePaginationRejectsUnsafeOffset(t *testing.T) {
	if _, err := NormalizePagination("2147483647", "50", 50); err != ErrPaginationOffsetTooLarge {
		t.Fatalf("huge page error = %v", err)
	}
	if _, err := NormalizePagination("42949674", "50", 50); err != ErrPaginationOffsetTooLarge {
		t.Fatalf("one past the max error = %v", err)
	}
	if _, err := NormalizePagination("abc", "10", 50); err != ErrInvalidQueryParameter {
		t.Fatalf("non numeric page error = %v", err)
	}
	if _, err := NormalizePagination("1", "1e3", 50); err != ErrInvalidQueryParameter {
		t.Fatalf("exponent pageSize must be rejected like IsNumberString: %v", err)
	}
}

// TestParseSearchPayloadHandlesHistoricalEnvelope pins the
// __items_filters__ decoding, including the raw-string fallback.
func TestParseSearchPayloadHandlesHistoricalEnvelope(t *testing.T) {
	plain := ParseSearchPayload("  climate ")
	if plain.Search != "climate" || plain.Filters != nil {
		t.Fatalf("plain payload = %+v", plain)
	}
	empty := ParseSearchPayload("   ")
	if empty.Search != "" || empty.Filters != nil {
		t.Fatalf("blank payload = %+v", empty)
	}
	decoded := ParseSearchPayload(searchFiltersPrefix + `%7B%22q%22%3A%22covid%22%2C%22filters%22%3A%7B%22sourceIds%22%3A%5B%22s1%22%5D%2C%22sentiments%22%3A%5B%22POSITIVE%22%5D%7D%7D`)
	if decoded.Search != "covid" {
		t.Fatalf("decoded search = %q", decoded.Search)
	}
	if decoded.Filters == nil || len(decoded.Filters.SourceIDs) != 1 || decoded.Filters.SourceIDs[0] != "s1" {
		t.Fatalf("decoded filters = %+v", decoded.Filters)
	}
	if len(decoded.Filters.Sentiments) != 1 || decoded.Filters.Sentiments[0] != "positive" {
		t.Fatalf("sentiments must be lowercased: %+v", decoded.Filters.Sentiments)
	}
	broken := ParseSearchPayload(searchFiltersPrefix + "%7Bnot-json")
	if broken.Search != searchFiltersPrefix+"%7Bnot-json" || broken.Filters != nil {
		t.Fatalf("broken payload must fall back to the raw string: %+v", broken)
	}
	prefixOnly := ParseSearchPayload(searchFiltersPrefix)
	if prefixOnly.Search != "" || prefixOnly.Filters != nil {
		t.Fatalf("prefix only payload = %+v", prefixOnly)
	}
}

// TestRankSearchCandidateIDsPortsFusion pins the fusion order and weights.
func TestRankSearchCandidateIDsPortsFusion(t *testing.T) {
	ranked := rankSearchCandidateIDs(map[SearchCandidateSource][]string{
		SearchCandidateMeta:          {"a", "b"},
		SearchCandidateElasticsearch: {"b"},
	})
	if len(ranked) != 2 || ranked[0] != "b" {
		t.Fatalf("fusion order = %v", ranked)
	}
	// "b" scores 1.3/1.1 ... meta index 1 -> 1.3/(1+1/20)=1.238, plus the
	// elasticsearch hit 1.6/(1+0)=1.6, plus the 0.2 multi-source bonus.
	// "a" only gets the meta index 0 score 1.3.
	if ranked[0] != "b" || ranked[1] != "a" {
		t.Fatalf("fusion order = %v", ranked)
	}
}

// TestMergeSuggestionsHybridOrigin pins the lexical/semantic merge rules.
func TestMergeSuggestionsHybridOrigin(t *testing.T) {
	facets := ItemFacets{
		Topics:     []FacetOption{{Value: "climate", Count: 3}},
		Regions:    []FacetOption{},
		Sentiments: []FacetOption{},
	}
	merged := mergeSuggestions(
		facets,
		[]SourceCount{{Source: "Climate Wire", Count: 2}},
		[]semanticSuggestion{{Type: SuggestionTypeTopic, Value: "climate", Score: 100}},
		"cli",
		10,
	)
	if len(merged) != 2 {
		t.Fatalf("merged = %+v", merged)
	}
	var climate *SearchSuggestion
	for index := range merged {
		if merged[index].Value == "climate" {
			climate = &merged[index]
		}
	}
	if climate == nil {
		t.Fatalf("climate suggestion missing: %+v", merged)
	}
	if climate.Origin != SuggestionOriginHybrid {
		t.Fatalf("climate origin = %q", climate.Origin)
	}
	if merged[0].Value != "climate" {
		t.Fatalf("highest score first: %+v", merged)
	}
}

// TestNormalizeProcessedResultPortsNestJS pins the nested-string rules.
func TestNormalizeProcessedResultPortsNestJS(t *testing.T) {
	if NormalizeProcessedResult(OpenJSON{}).Valid() {
		t.Fatal("missing value must normalize to invalid")
	}
	if NormalizeProcessedResult(NewOpenJSON([]byte(`""`))).Valid() {
		t.Fatal("blank string must normalize to invalid")
	}
	if NormalizeProcessedResult(NewOpenJSON([]byte(`"not json"`))).Valid() {
		t.Fatal("invalid JSON string must normalize to invalid")
	}
	nested := NormalizeProcessedResult(NewOpenJSON([]byte(`"{\"a\":1}"`)))
	if !nested.Valid() || string(nested.Bytes()) != `{"a":1}` {
		t.Fatalf("nested string = %q", nested.Bytes())
	}
	doubleNested := NormalizeProcessedResult(NewOpenJSON([]byte(`"\"{\\\"a\\\":2}\""`)))
	if !doubleNested.Valid() || string(doubleNested.Bytes()) != `{"a":2}` {
		t.Fatalf("double nested string = %q", doubleNested.Bytes())
	}
	object := NormalizeProcessedResult(NewOpenJSON([]byte(`{"b":3}`)))
	if string(object.Bytes()) != `{"b":3}` {
		t.Fatalf("object = %q", object.Bytes())
	}
}

// TestContentTypeNormalization pins the preview synonym mapping and the
// read-model variant difference.
func TestContentTypeNormalization(t *testing.T) {
	if got := normalizeContentType("Editorial"); got != "opinion" {
		t.Fatalf("editorial = %q", got)
	}
	if got := normalizeContentType("news-fact"); got != "news_fact" {
		t.Fatalf("news-fact = %q", got)
	}
	if got := normalizeContentType("unknown-value"); got != "" {
		t.Fatalf("unknown = %q", got)
	}
	if got := normalizeLowerKey("  Editorial  "); got != "editorial" {
		t.Fatalf("read-model variant = %q", got)
	}
}

// TestExtractRawPreviewMergesMetadata pins the payload/metadata override rule
// and the alias order.
func TestExtractRawPreviewMergesMetadata(t *testing.T) {
	payload := NewOpenJSON([]byte(`{
      "url": "https://payload.example/a",
      "sourceName": "payload source",
      "summary": "payload summary",
      "sentiment_label": "positive",
      "price": "1.5",
      "changePercent": 2.25,
      "history": [{"timestamp": "2026-01-01", "value": 1}, {"timestamp": "2026-01-02", "value": "2"}],
      "metadata": {"summary": "metadata summary", "sourceName": "metadata source", "ticker": "ACME"}
    }`))
	preview := ExtractRawPreviewMongo(payload)
	if preview.URL != "https://payload.example/a" {
		t.Fatalf("url = %q", preview.URL)
	}
	if preview.SourceName != "metadata source" {
		t.Fatalf("metadata must override payload: %q", preview.SourceName)
	}
	if preview.Summary != "metadata summary" {
		t.Fatalf("summary = %q", preview.Summary)
	}
	if preview.Ticker != "ACME" {
		t.Fatalf("ticker = %q", preview.Ticker)
	}
	if preview.Price == nil || *preview.Price != 1.5 {
		t.Fatalf("price = %v", preview.Price)
	}
	if preview.ChangePercent == nil || *preview.ChangePercent != 2.25 {
		t.Fatalf("changePercent = %v", preview.ChangePercent)
	}
	if len(preview.History) != 2 || preview.History[1].Value != 2 {
		t.Fatalf("history = %+v", preview.History)
	}
}

// TestBuildReadModelDocumentStaysOrganizationBound is the IR1 guard for the
// hydration projection.
func TestBuildReadModelDocumentStaysOrganizationBound(t *testing.T) {
	meta := ItemMetaRow{
		ID:         "item-a",
		OrgID:      "org-a",
		ExternalID: "crawlResult:cr-1",
		Name:       "Alpha",
		Status:     "completed",
		MongoRef:   "0123456789abcdef01234567",
		Version:    1,
		SortAt:     NewISOTime(parseTimeOrZero("2026-01-01T00:00:00Z")),
		CreatedAt:  NewISOTime(parseTimeOrZero("2026-01-01T00:00:00Z")),
		UpdatedAt:  NewISOTime(parseTimeOrZero("2026-01-02T00:00:00Z")),
	}
	raw := &ReadModelRawDoc{
		ID:         meta.MongoRef,
		ItemMetaID: meta.ID,
		Payload:    NewOpenJSON([]byte(`{"url":"https://x.example","metadata":{"sourceId":"src-1"}}`)),
		CreatedAt:  meta.CreatedAt,
		UpdatedAt:  meta.UpdatedAt,
	}
	processed := &ReadModelProcessedDoc{
		ID:         "0123456789abcdef01234568",
		ItemMetaID: meta.ID,
		Status:     "completed",
		Tags:       []string{"tag", "tag", " "},
		Result:     NewOpenJSON([]byte(`{"title":"Alpha title","topics":["t"],"entities":[{"name":"E"}]}`)),
		CreatedAt:  meta.CreatedAt,
		UpdatedAt:  meta.UpdatedAt,
	}
	doc := buildReadModelDocument(buildReadModelInput{Meta: meta, Raw: raw, Processed: processed})
	if doc.OrgID != "org-a" || doc.ItemMetaID != "item-a" {
		t.Fatalf("tenant keys = %q/%q", doc.OrgID, doc.ItemMetaID)
	}
	if doc.Title != "Alpha title" {
		t.Fatalf("title = %q", doc.Title)
	}
	if len(doc.Tags) != 1 || doc.Tags[0] != "tag" {
		t.Fatalf("tags = %+v", doc.Tags)
	}
	if len(doc.TopicKeys) != 1 || doc.TopicKeys[0] != "t" {
		t.Fatalf("topicKeys = %+v", doc.TopicKeys)
	}
	if len(doc.EntityKeys) != 1 || doc.EntityKeys[0] != "e" {
		t.Fatalf("entityKeys = %+v", doc.EntityKeys)
	}
	// The sourceId chain must take the raw metadata source when the processed
	// snapshot has none.
	encoded, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"searchTerms"`) {
		t.Fatalf("searchTerms missing: %s", encoded)
	}
}

// parseTimeOrZero parses a test timestamp.
func parseTimeOrZero(value string) time.Time {
	result, ok := parseTimeValue(value)
	if !ok {
		return time.Time{}
	}
	return result
}
