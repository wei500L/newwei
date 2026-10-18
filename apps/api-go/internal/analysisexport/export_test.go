package analysisexport

import (
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/newsevents"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

// TestEscapeCSVValue covers the two independent rules of the source helper:
// the formula guard runs first on the raw string (after skipping JavaScript
// leading whitespace), then the CSV quoting step only reacts to comma, double
// quote, CR and LF.
func TestEscapeCSVValue(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{name: "plain", input: "tariff", want: "tariff"},
		{name: "comma", input: "a,b", want: `"a,b"`},
		{name: "quote", input: `say "hi"`, want: `"say ""hi"""`},
		{name: "newline", input: "a\nb", want: "\"a\nb\""},
		{name: "carriage return", input: "a\rb", want: "\"a\rb\""},
		{name: "empty", input: "", want: ""},
		{name: "leading spaces preserved", input: "  padded", want: "  padded"},
		{name: "negative integer stays numeric", input: "-12", want: "-12"},
		{name: "negative decimal stays numeric", input: "-0.5", want: "-0.5"},
		{name: "positive sign is a formula", input: "+12", want: "'+12"},
		{name: "exponent is a formula", input: "-1e3", want: "'-1e3"},
		{name: "equals is a formula", input: "=SUM(A1)", want: "'=SUM(A1)"},
		{name: "at sign is a formula", input: "@user", want: "'@user"},
		{name: "formula after whitespace", input: "  =1+1", want: "'  =1+1"},
		{name: "formula with comma", input: "=SUM(A1,B1)", want: "\"'=SUM(A1,B1)\""},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := escapeCSVValue(testCase.input); got != testCase.want {
				t.Fatalf("escapeCSVValue(%q) = %q, want %q", testCase.input, got, testCase.want)
			}
		})
	}
}

// TestCSVRowWriterContract pins the byte contract: LF between rows only, no
// trailing newline, header-only for an empty result.
func TestCSVRowWriterContract(t *testing.T) {
	var onlyHeader strings.Builder
	writer := newCSVRowWriter(&onlyHeader)
	writer.writeRow(itemsHeader)
	if writer.err != nil {
		t.Fatalf("unexpected write error: %v", writer.err)
	}
	want := strings.Join(itemsHeader, ",")
	if got := onlyHeader.String(); got != want {
		t.Fatalf("header-only output = %q, want %q", got, want)
	}
	if strings.HasSuffix(onlyHeader.String(), "\n") {
		t.Fatal("header-only output has a trailing newline")
	}

	var withRows strings.Builder
	writer = newCSVRowWriter(&withRows)
	writer.writeRow([]string{"a", "b"})
	writer.writeRow([]string{"c", "d"})
	if got, want := withRows.String(), "a,b\nc,d"; got != want {
		t.Fatalf("two-row output = %q, want %q", got, want)
	}
}

// TestBuildItemsRowTitleFallback pins `readModel.title ?? item.name`: an
// existing read model keeps an explicitly empty title and the publishedAt
// fallback only applies when the read-model timestamp is missing.
func TestBuildItemsRowTitleFallback(t *testing.T) {
	published := itemsreading.NewISOTime(time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC))
	row := itemsreading.ItemMetaRow{ID: "item-1", Name: "item name", PublishedAt: &published}
	rowModel := itemsreading.ExportReadModelRow{ItemMetaID: "item-1", Title: "", SourceName: strPtr("Wire")}
	built := buildItemsRow(row, &rowModel, nil)
	if built[1] != "" {
		t.Fatalf("empty read-model title must be kept, got %q", built[1])
	}
	if built[2] != "Wire" {
		t.Fatalf("source cell = %q, want Wire", built[2])
	}
	if built[4] != "2026-01-02T03:04:05.000Z" {
		t.Fatalf("publishedAt cell = %q, want the ItemMeta fallback", built[4])
	}

	readModelPublished := itemsreading.NewISOTime(time.Date(2026, 2, 3, 0, 0, 0, 0, time.UTC))
	rowModel = itemsreading.ExportReadModelRow{ItemMetaID: "item-1", Title: "Read title", PublishedAt: &readModelPublished}
	link := itemsreading.ExportEventLink{EventID: "event-1", EventTitle: "Event title"}
	built = buildItemsRow(row, &rowModel, &link)
	if built[1] != "Read title" || built[4] != "2026-02-03T00:00:00.000Z" {
		t.Fatalf("read-model projection = %q / %q", built[1], built[4])
	}
	if built[9] != "event-1" || built[10] != "Event title" {
		t.Fatalf("event cells = %q / %q", built[9], built[10])
	}

	built = buildItemsRow(row, nil, nil)
	if built[1] != "item name" {
		t.Fatalf("missing read model must fall back to the ItemMeta name, got %q", built[1])
	}
	if built[9] != "" || built[10] != "" {
		t.Fatalf("missing event must be empty, got %q / %q", built[9], built[10])
	}
}

// TestBuildEventsRowNumbers pins the numeric rendering of the export ranges.
func TestBuildEventsRowNumbers(t *testing.T) {
	row := newsevents.ExportEventRow{
		ID:               "event-1",
		Title:            "Title",
		Status:           "active",
		StartAt:          time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC),
		LastAt:           time.Time{},
		HeatScore:        62.5,
		CredibilityScore: 0.4167,
		ItemCount:        3,
	}
	cells := buildEventsRow(row)
	if cells[5] != "2026-03-04T05:06:07.000Z" || cells[6] != "" {
		t.Fatalf("time cells = %q / %q", cells[5], cells[6])
	}
	if cells[7] != "62.5" || cells[8] != "0.4167" {
		t.Fatalf("score cells = %q / %q", cells[7], cells[8])
	}
	if cells[9] != "3" || cells[10] != "0" || cells[11] != "0" {
		t.Fatalf("count cells = %q / %q / %q", cells[9], cells[10], cells[11])
	}
}

// TestParseItemsParams covers dispatch order (relevance beats personalized),
// first-value semantics for single keys, every-value semantics for the repeated
// filters and the ignored invalid date.
func TestParseItemsParams(t *testing.T) {
	params := parseItemsParams(parseQueryParams(
		"q=tariff&q=shipping&region=APAC&region=emea&topic=shipping&sentiment=Positive" +
			"&contentType=news_fact&from=2026-01-01&to=not-a-date&dedup=TRUE&order=published&ranking=recency",
	))
	if params.search != "tariff" {
		t.Fatalf("search = %q, want the first q value", params.search)
	}
	if params.orderBy != itemsreading.ItemsListOrderPublishedDesc {
		t.Fatalf("orderBy = %q", params.orderBy)
	}
	if params.ranking != itemsreading.ItemsRankingRecency {
		t.Fatalf("ranking = %q, want RECENCY for ranking=recency", params.ranking)
	}
	if len(params.filters.Regions) != 2 || params.filters.Regions[0] != "APAC" || params.filters.Regions[1] != "emea" {
		t.Fatalf("regions = %v", params.filters.Regions)
	}
	if len(params.filters.Topics) != 1 || params.filters.Topics[0] != "shipping" {
		t.Fatalf("topics = %v", params.filters.Topics)
	}
	if len(params.filters.Sentiments) != 1 || len(params.filters.ContentTypes) != 1 {
		t.Fatalf("sentiments/contentTypes = %v / %v", params.filters.Sentiments, params.filters.ContentTypes)
	}
	if !params.filters.ExcludeDuplicates {
		t.Fatal("dedup=TRUE must set excludeDuplicates")
	}
	if params.filters.DateRange == nil || params.filters.DateRange.Start == nil {
		t.Fatalf("from date was not parsed: %+v", params.filters.DateRange)
	}
	if params.filters.DateRange != nil && params.filters.DateRange.End != nil {
		t.Fatalf("invalid to date must be ignored, got %v", params.filters.DateRange.End)
	}

	relevance := parseItemsParams(parseQueryParams("q=tariff&order=personalized"))
	if relevance.ranking != itemsreading.ItemsRankingRelevance {
		t.Fatalf("default ranking with a search term = %q, want RELEVANCE", relevance.ranking)
	}
	if relevance.orderBy != itemsreading.ItemsListOrderPersonalized {
		t.Fatalf("orderBy = %q, want PERSONALIZED", relevance.orderBy)
	}

	plain := parseItemsParams(parseQueryParams("region=APAC,EMEA"))
	if plain.ranking != itemsreading.ItemsRankingRecency {
		t.Fatalf("ranking without search = %q, want RECENCY", plain.ranking)
	}
	if plain.orderBy != itemsreading.ItemsListOrderCreatedDesc {
		t.Fatalf("default orderBy = %q", plain.orderBy)
	}
	if len(plain.filters.Regions) != 1 || plain.filters.Regions[0] != "APAC,EMEA" {
		t.Fatalf("a comma must not split a filter value: %v", plain.filters.Regions)
	}
}

// TestParseEventsParams covers the JavaScript parseInt/parseFloat semantics and
// the source token whitelists (including that minCredibility keeps values above
// 100 instead of clamping them like the GraphQL root).
func TestParseEventsParams(t *testing.T) {
	cases := []struct {
		name       string
		raw        string
		window     int
		status     string
		entity     string
		sort       string
		sourceType string
		minHeatNil bool
		minHeat    float64
		minCredNil bool
		minCred    float64
	}{
		{name: "empty", raw: "", window: 30, status: "", entity: "", sort: "latest", sourceType: "all", minHeatNil: true, minCredNil: true},
		{name: "fractional window", raw: "window=3.9", window: 3, sort: "latest", sourceType: "all", minHeatNil: true, minCredNil: true},
		{name: "invalid window", raw: "window=abc", window: 30, sort: "latest", sourceType: "all", minHeatNil: true, minCredNil: true},
		{name: "zero window", raw: "window=0", window: 30, sort: "latest", sourceType: "all", minHeatNil: true, minCredNil: true},
		{name: "clamped window", raw: "window=999", window: 365, sort: "latest", sourceType: "all", minHeatNil: true, minCredNil: true},
		{name: "exponent window", raw: "window=1e3", window: 1, sort: "latest", sourceType: "all", minHeatNil: true, minCredNil: true},
		{
			name: "filters", raw: "status=archived&entity=%20acme%20&sort=heat&sourceType=blog&minHeat=2.5&minCredibility=250",
			window: 30, status: "archived", entity: "acme", sort: "heat", sourceType: "blog", minHeat: 2.5, minCred: 250,
		},
		{name: "unknown tokens", raw: "status=deleted&sort=bogus&sourceType=x&minHeat=-1&minCredibility=abc", window: 30, status: "", sort: "latest", sourceType: "all", minHeatNil: true, minCredNil: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			query := parseEventsParams(parseQueryParams(testCase.raw))
			if query.WindowDays != testCase.window {
				t.Fatalf("window = %d, want %d", query.WindowDays, testCase.window)
			}
			if query.Status != testCase.status || query.Entity != testCase.entity {
				t.Fatalf("status/entity = %q / %q, want %q / %q", query.Status, query.Entity, testCase.status, testCase.entity)
			}
			if query.Sort != testCase.sort || query.SourceType != testCase.sourceType {
				t.Fatalf("sort/sourceType = %q / %q, want %q / %q", query.Sort, query.SourceType, testCase.sort, testCase.sourceType)
			}
			if testCase.minHeatNil {
				if query.MinHeatScore != nil {
					t.Fatalf("minHeat = %v, want nil", *query.MinHeatScore)
				}
			} else if query.MinHeatScore == nil || *query.MinHeatScore != testCase.minHeat {
				t.Fatalf("minHeat = %v, want %v", query.MinHeatScore, testCase.minHeat)
			}
			if testCase.minCredNil {
				if query.MinCredibilityScore != nil {
					t.Fatalf("minCredibility = %v, want nil", *query.MinCredibilityScore)
				}
			} else if query.MinCredibilityScore == nil || *query.MinCredibilityScore != testCase.minCred {
				t.Fatalf("minCredibility = %v, want %v", query.MinCredibilityScore, testCase.minCred)
			}
		})
	}
}

func strPtr(value string) *string {
	return &value
}
