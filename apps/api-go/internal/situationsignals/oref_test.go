package situationsignals

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/contentsubscriptions"
)

func TestOrefDateToUTC(t *testing.T) {
	// Winter wall clock is UTC+2: "2026-01-15 10:00:00" becomes 08:00Z.
	if got := orefDateToUTC("2026-01-15 10:00:00"); got != "2026-01-15T08:00:00.000Z" {
		t.Fatalf("winter = %s", got)
	}
	// Summer wall clock is UTC+3 (DST): "2026-07-15 10:00:00" becomes 07:00Z.
	if got := orefDateToUTC("2026-07-15 10:00:00"); got != "2026-07-15T07:00:00.000Z" {
		t.Fatalf("summer = %s", got)
	}
	// A malformed input becomes "now"; only the shape is asserted.
	for _, input := range []string{"", "not-a-date", "2026-01-15", "2026-01-15 10:00", "x-y-z a:b:c"} {
		got := orefDateToUTC(input)
		if _, err := time.Parse("2006-01-02T15:04:05.000Z", got); err != nil {
			t.Fatalf("%q -> %s", input, got)
		}
	}
	if formatted := formatInJerusalem(time.Date(2026, 1, 15, 8, 0, 0, 0, time.UTC)); formatted != "2026-01-15 10:00:00" {
		t.Fatalf("format = %s", formatted)
	}
}

func TestTelegramCandidate(t *testing.T) {
	item := rawJSON{raw: json.RawMessage(`{
		"id":"42","channel":"alpha","channelTitle":"Alpha News","url":"https://t/42",
		"ts":"2026-01-02T03:04:05.000Z","text":"` + strings.Repeat("x", 200) + `","topic":"war","tags":["a","b"]
	}`)}
	candidate := telegramCandidate(item)
	if candidate.ItemKey != "telegram:42" || candidate.ItemType != "telegram" {
		t.Fatalf("candidate = %+v", candidate)
	}
	if utf16Len(candidate.Title) != 120 {
		t.Fatalf("title length = %d", utf16Len(candidate.Title))
	}
	if utf16Len(candidate.Summary) != 200 {
		t.Fatalf("summary length = %d", utf16Len(candidate.Summary))
	}
	if candidate.Link != "https://t/42" || candidate.Source != "Alpha News" || candidate.Category != "war" {
		t.Fatalf("candidate = %+v", candidate)
	}
	if len(candidate.Topics) != 1 || candidate.Topics[0] != "war" {
		t.Fatalf("topics = %v", candidate.Topics)
	}
	if len(candidate.ExtraTexts) != 2 {
		t.Fatalf("extraTexts = %v", candidate.ExtraTexts)
	}
	if candidate.Timestamp != float64(time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC).UnixMilli()) {
		t.Fatalf("timestamp = %v", candidate.Timestamp)
	}

	// An empty text falls back to the channel title.
	empty := telegramCandidate(rawJSON{raw: json.RawMessage(`{"id":"7","channelTitle":"Fallback","ts":"bad"}`)})
	if empty.Title != "Fallback" {
		t.Fatalf("title = %q", empty.Title)
	}
	if empty.Timestamp == 0 {
		t.Fatal("an unparseable ts must fall back to the current time")
	}
	if empty.Category != "" || len(empty.Topics) != 0 {
		t.Fatalf("candidate = %+v", empty)
	}
}

func TestOrefAlertCandidate(t *testing.T) {
	alert := rawJSON{raw: json.RawMessage(`{
		"id":"a1","cat":"1","title":"Rockets","data":["Tel Aviv","Ramat Gan"],
		"desc":"Take shelter","alertDate":"2026-01-15 10:00:00"
	}`)}
	candidate := orefAlertCandidate(alert, "oref_alert")
	if candidate.ItemKey != "oref:a1" || candidate.ItemType != "oref_alert" {
		t.Fatalf("candidate = %+v", candidate)
	}
	if candidate.Source != "1" || candidate.Category != "1" {
		t.Fatalf("candidate = %+v", candidate)
	}
	if candidate.Link != "" {
		t.Fatalf("link = %q", candidate.Link)
	}
	if len(candidate.GeoTexts) != 2 || len(candidate.ExtraTexts) != 2 {
		t.Fatalf("candidate = %+v", candidate)
	}
	if candidate.Timestamp != float64(time.Date(2026, 1, 15, 8, 0, 0, 0, time.UTC).UnixMilli()) {
		t.Fatalf("timestamp = %v", candidate.Timestamp)
	}

	// A missing cat falls back to "oref" and a non-array data field to [].
	sparse := orefAlertCandidate(rawJSON{raw: json.RawMessage(`{"id":"a2","data":"nope"}`)}, "oref_alert")
	if sparse.Source != "oref" || len(sparse.GeoTexts) != 0 {
		t.Fatalf("candidate = %+v", sparse)
	}
}

func TestOrefHistoryCandidate(t *testing.T) {
	alert := rawJSON{raw: json.RawMessage(`{"id":"a1","cat":"1","title":"T","alertDate":"2026-01-15 10:00:00"}`)}
	entry := rawJSON{raw: json.RawMessage(`{"alerts":[],"timestamp":"2026-01-16 11:00:00"}`)}
	candidate := orefHistoryCandidate(alert, entry)
	if candidate.ItemKey != "oref-history:2026-01-16 11:00:00:a1" || candidate.ItemType != "oref_history" {
		t.Fatalf("candidate = %+v", candidate)
	}
	if candidate.Timestamp != float64(time.Date(2026, 1, 16, 9, 0, 0, 0, time.UTC).UnixMilli()) {
		t.Fatalf("timestamp = %v", candidate.Timestamp)
	}
}

func TestExtractGeoCountryAlpha2(t *testing.T) {
	cases := map[string]string{
		"Israel":            "IL",
		"israel":            "IL",
		"IL":                "IL",
		"ISR":               "IL",
		"Tel Aviv, Israel":  "IL",
		"France":            "FR",
		"United States":     "US",
		"Germany":           "DE",
		"LATAM":             "",
		"EU":                "",
		"":                  "",
		"Some Random Place": "",
	}
	for input, want := range cases {
		got, ok := extractGeoCountryAlpha2(input)
		if want == "" {
			if ok {
				t.Fatalf("%q resolved to %q", input, got)
			}
			continue
		}
		if !ok || got != want {
			t.Fatalf("%q -> %q/%v, want %q", input, got, ok, want)
		}
	}
	// Alpha-3 resolves through the shared country table.
	if got := contentsubscriptions.NormalizeCountryAlpha2("ISR"); got != "IL" {
		t.Fatalf("ISR -> %q", got)
	}
}

func TestCanonicalizeGeoValue(t *testing.T) {
	country := canonicalizeGeoValue("France")
	if country.CountryCodeAlpha2 != "FR" || country.NormalizedValue != "fr" || country.DisplayValue == "" {
		t.Fatalf("canonical = %+v", country)
	}
	plain := canonicalizeGeoValue("Tel Aviv")
	if plain.CountryCodeAlpha2 != "" || plain.NormalizedValue != "tel aviv" || plain.DisplayValue != "Tel Aviv" {
		t.Fatalf("canonical = %+v", plain)
	}
	ambiguous := canonicalizeGeoValue("LATAM")
	if ambiguous.CountryCodeAlpha2 != "" || ambiguous.NormalizedValue != "latam" {
		t.Fatalf("canonical = %+v", ambiguous)
	}
	if empty := canonicalizeGeoValue("  "); empty.NormalizedValue != "" || empty.DisplayValue != "" {
		t.Fatalf("canonical = %+v", empty)
	}
}

func TestCollectGeoHits(t *testing.T) {
	if hits := collectGeoHits([]string{"Paris"}, []string{"Paris"}); len(hits) != 1 {
		t.Fatalf("hits = %v", hits)
	}
	if hits := collectGeoHits([]string{"France"}, []string{"France"}); len(hits) != 1 {
		t.Fatalf("hits = %v", hits)
	}
	if hits := collectGeoHits([]string{"France"}, []string{"Germany"}); len(hits) != 0 {
		t.Fatalf("hits = %v", hits)
	}
	// A short ASCII value must match exactly.
	if hits := collectGeoHits([]string{"IL"}, []string{"IL"}); len(hits) != 1 {
		t.Fatalf("hits = %v", hits)
	}
}

func TestCandidateEmbeddingText(t *testing.T) {
	candidate := monitorCandidate{
		Title:      "Title",
		Summary:    "Summary",
		Topics:     []string{"war"},
		Entities:   []string{"NATO"},
		Location:   "Paris",
		ExtraTexts: []string{"one", "two"},
		Source:     "Alpha",
	}
	want := "title=Title\nsummary=Summary\ntopics=war\nentities=NATO\nlocation=Paris\nextra=one | two\nsource=Alpha"
	if got := candidateEmbeddingText(candidate); got != want {
		t.Fatalf("got %q want %q", got, want)
	}
	minimal := monitorCandidate{Title: "T", Source: "S"}
	if got := candidateEmbeddingText(minimal); got != "title=T\nsource=S" {
		t.Fatalf("got %q", got)
	}
}

func TestBuildQueryText(t *testing.T) {
	record := monitorRecord{
		Name:                 "One",
		RawKeywords:          []string{"alpha"},
		ApprovedTopics:       []string{"war"},
		ApprovedEntities:     []string{"NATO"},
		ApprovedSources:      []string{"Alpha"},
		ApprovedGeos:         []string{"France"},
		ApprovedLexicalTerms: []string{"beta"},
		Location:             &monitorLocation{Name: "Paris", CountryCodeAlpha2: "FR"},
	}
	got := buildQueryText(record)
	for _, want := range []string{"name=One", "keywords=alpha", "topics=war", "entities=NATO", "sources=Alpha", "geos=France", "lexical=beta", "location=Paris", "country=France"} {
		if !strings.Contains(got, want) {
			t.Fatalf("%q missing %q", got, want)
		}
	}
	empty := buildQueryText(monitorRecord{Name: "Only"})
	if empty != "name=Only" {
		t.Fatalf("got %q", empty)
	}
}
