package crawlmaintenance

import (
	"testing"
	"time"
)

// TestJSToFixedMatchesHalfUpRounding pins the ECMAScript toFixed rule: on an
// exact tie the larger scaled integer wins, which differs from Go's
// strconv.FormatFloat half-to-even.
func TestJSToFixedMatchesHalfUpRounding(t *testing.T) {
	cases := []struct {
		value  float64
		digits int
		want   string
	}{
		{12.25, 1, "12.3"},
		{1.25, 1, "1.3"},
		{0.125, 2, "0.13"},
		{2.5, 0, "3"},
		{0, 1, "0.0"},
		{0.04, 1, "0.0"},
		{25, 1, "25.0"},
		{20, 0, "20"},
		{0.2, 0, "0"},
	}
	for _, testCase := range cases {
		if got := jsToFixed(testCase.value, testCase.digits); got != testCase.want {
			t.Errorf("jsToFixed(%v, %d) = %q, want %q", testCase.value, testCase.digits, got, testCase.want)
		}
	}
}

// TestFormatISOAlwaysUTCWithMillis pins toISOString's exact shape.
func TestFormatISOAlwaysUTCWithMillis(t *testing.T) {
	location := time.FixedZone("UTC+3", 3*60*60)
	value := time.Date(2026, 10, 20, 18, 1, 2, 3_000_000, location)
	if got := formatISO(value); got != "2026-10-20T15:01:02.003Z" {
		t.Fatalf("formatISO = %q", got)
	}
}

// TestParseISO covers the strings NestJS writes.
func TestParseISO(t *testing.T) {
	parsed, ok := parseISO("2026-10-20T15:01:02.003Z")
	if !ok || !parsed.Equal(time.Date(2026, 10, 20, 15, 1, 2, 3_000_000, time.UTC)) {
		t.Fatalf("parseISO = %v, %t", parsed, ok)
	}
	if _, ok := parseISO("not-a-date"); ok {
		t.Fatal("parseISO accepted an invalid value")
	}
	if _, ok := parseISO("   "); ok {
		t.Fatal("parseISO accepted a blank value")
	}
}

// TestMarshalJSONNoHTMLEscape pins JSON.stringify's <, >, & behaviour, which
// the adaptive reason text and the janitor audit metadata depend on.
func TestMarshalJSONNoHTMLEscape(t *testing.T) {
	type sample struct {
		Reason string `json:"reason"`
	}
	payload, err := marshalJSONNoHTMLEscape(sample{Reason: "p95 > 850ms & < 2000ms"})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(payload), `{"reason":"p95 > 850ms & < 2000ms"}`; got != want {
		t.Fatalf("payload = %s, want %s", got, want)
	}
}

// TestJSRound covers Math.round for the non-negative maintenance values.
func TestJSRound(t *testing.T) {
	cases := map[float64]float64{0: 0, 0.5: 1, 1.49: 1, 1.5: 2, 2.5: 3, 99.5: 100}
	for value, want := range cases {
		if got := jsRound(value); got != want {
			t.Errorf("jsRound(%v) = %v, want %v", value, got, want)
		}
	}
}

// TestLocaleCompareMatchesByteOrderForCrawlIDs documents the A'5 proof: crawl
// ids are [0-9a-z], for which ICU's default collation equals byte order.
func TestLocaleCompareMatchesByteOrderForCrawlIDs(t *testing.T) {
	ids := []string{"c2", "c10", "a", "zz", "c1"}
	want := []string{"a", "c1", "c10", "c2", "zz"}
	sortByTimeThenID(ids, func(string) time.Time { return time.Unix(0, 0) }, func(id string) string { return id })
	for index := range want {
		if ids[index] != want[index] {
			t.Fatalf("sorted ids = %v, want %v", ids, want)
		}
	}
}

// TestSortByTimeThenIDKeepsFirstOccurrenceOrder pins the stable ordering.
func TestSortByTimeThenIDKeepsFirstOccurrenceOrder(t *testing.T) {
	type entry struct {
		id   string
		when time.Time
	}
	base := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	items := []entry{
		{"b", base.Add(2 * time.Second)},
		{"a", base},
		{"c", base},
	}
	sortByTimeThenID(items,
		func(item entry) time.Time { return item.when },
		func(item entry) string { return item.id })
	if items[0].id != "a" || items[1].id != "c" || items[2].id != "b" {
		t.Fatalf("order = %v", items)
	}
}
