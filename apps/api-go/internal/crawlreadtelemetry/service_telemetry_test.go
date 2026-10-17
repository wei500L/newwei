package crawlreadtelemetry

import (
	"errors"
	"testing"
	"time"
)

// telemetrySurfacePtr returns a pointer to value so the DTO's optional fields
// can distinguish absent from present.
func telemetrySurfacePtr(value SearchTelemetrySurface) *SearchTelemetrySurface {
	return &value
}

// telemetryVerticalPtr returns a pointer to value for the optional vertical.
func telemetryVerticalPtr(value ArchiveVertical) *ArchiveVertical {
	return &value
}

// telemetryQueryLengthPtr returns a pointer to value for the optional
// queryLength counter bucket input.
func telemetryQueryLengthPtr(value int) *int {
	return &value
}

// telemetryStatusMessage asserts that err is a typed HTTP failure with the
// expected status and message.
func telemetryStatusMessage(t *testing.T, err error, status int, message string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error %q, got nil", message)
	}
	var typed *statusError
	if !errors.As(err, &typed) {
		t.Fatalf("expected *statusError, got %T (%v)", err, err)
	}
	if typed.status != status {
		t.Fatalf("status = %d, want %d", typed.status, status)
	}
	if typed.message != message {
		t.Fatalf("message = %q, want %q", typed.message, message)
	}
}

// TestResolveQueryLengthBucket covers every boundary of the query length
// histogram used by the record endpoint.
func TestResolveQueryLengthBucket(t *testing.T) {
	cases := []struct {
		name   string
		length int
		want   string
	}{
		{name: "zero", length: 0, want: "len_00_01"},
		{name: "one", length: 1, want: "len_00_01"},
		{name: "two", length: 2, want: "len_02_03"},
		{name: "three", length: 3, want: "len_02_03"},
		{name: "four", length: 4, want: "len_04_07"},
		{name: "seven", length: 7, want: "len_04_07"},
		{name: "eight", length: 8, want: "len_08_15"},
		{name: "fifteen", length: 15, want: "len_08_15"},
		{name: "sixteen", length: 16, want: "len_16_31"},
		{name: "thirty one", length: 31, want: "len_16_31"},
		{name: "thirty two", length: 32, want: "len_32_plus"},
		{name: "five hundred", length: 500, want: "len_32_plus"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := resolveQueryLengthBucket(testCase.length); got != testCase.want {
				t.Fatalf("resolveQueryLengthBucket(%d) = %q, want %q", testCase.length, got, testCase.want)
			}
		})
	}
}

// TestSearchTelemetryDateRange covers the calendar, ordering and span rules of
// the summary query.
func TestSearchTelemetryDateRange(t *testing.T) {
	cases := []struct {
		name     string
		from     string
		to       string
		wantErr  string
		wantFrom string
		wantTo   string
	}{
		{
			name:    "invalid calendar date",
			from:    "2026-02-30",
			to:      "2026-03-01",
			wantErr: "invalid date",
		},
		{
			name:    "from after to",
			from:    "2026-05-02",
			to:      "2026-05-01",
			wantErr: "from must be less than or equal to to",
		},
		{
			name:    "thirty two day span",
			from:    "2026-01-01",
			to:      "2026-02-01",
			wantErr: "date range cannot exceed 31 days",
		},
		{
			name:     "thirty one day span",
			from:     "2026-01-01",
			to:       "2026-01-31",
			wantFrom: "2026-01-01",
			wantTo:   "2026-01-31",
		},
		{
			name:     "single day span",
			from:     "2026-04-18",
			to:       "2026-04-18",
			wantFrom: "2026-04-18",
			wantTo:   "2026-04-18",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			start, end, err := searchTelemetryDateRange(testCase.from, testCase.to)
			if testCase.wantErr != "" {
				telemetryStatusMessage(t, err, 400, testCase.wantErr)
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got := start.Format(searchTelemetryDateLayout); got != testCase.wantFrom {
				t.Fatalf("from = %q, want %q", got, testCase.wantFrom)
			}
			if got := end.Format(searchTelemetryDateLayout); got != testCase.wantTo {
				t.Fatalf("to = %q, want %q", got, testCase.wantTo)
			}
		})
	}
}

// TestValidateRecordSearchTelemetry covers the accepted body and every
// class-validator rejection of the record endpoint.
func TestValidateRecordSearchTelemetry(t *testing.T) {
	valid := RecordSearchTelemetryRequest{
		EventType:   SearchTelemetryEventArchiveLoadMoreClick,
		Surface:     telemetrySurfacePtr(SearchTelemetrySurfaceSearchPage),
		Vertical:    telemetryVerticalPtr(ArchiveVerticalEastSea),
		QueryLength: telemetryQueryLengthPtr(12),
	}
	cases := []struct {
		name    string
		input   RecordSearchTelemetryRequest
		wantErr string
	}{
		{
			name:  "valid request",
			input: valid,
		},
		{
			name:    "missing event type",
			input:   RecordSearchTelemetryRequest{},
			wantErr: "eventType must be one of the following values: archive_search_submit, archive_query_too_short, archive_load_more_click",
		},
		{
			name: "unknown event type",
			input: RecordSearchTelemetryRequest{
				EventType: SearchTelemetryEventType("page_view"),
			},
			wantErr: "eventType must be one of the following values: archive_search_submit, archive_query_too_short, archive_load_more_click",
		},
		{
			name: "unknown surface",
			input: RecordSearchTelemetryRequest{
				EventType: SearchTelemetryEventArchiveSearchSubmit,
				Surface:   telemetrySurfacePtr(SearchTelemetrySurface("home_page")),
			},
			wantErr: "surface must be one of the following values: search_page, events_archive",
		},
		{
			name: "unknown vertical",
			input: RecordSearchTelemetryRequest{
				EventType: SearchTelemetryEventArchiveLoadMoreClick,
				Vertical:  telemetryVerticalPtr(ArchiveVertical("NORTH_SEA")),
			},
			wantErr: "vertical must be one of the following values: EAST_SEA, SOUTH_SEA, WEST_FRONT, FOREIGN_AFFAIRS, DOMESTIC_AFFAIRS",
		},
		{
			name: "query length above maximum",
			input: RecordSearchTelemetryRequest{
				EventType:   SearchTelemetryEventArchiveSearchSubmit,
				QueryLength: telemetryQueryLengthPtr(501),
			},
			wantErr: "queryLength must not be greater than 500",
		},
		{
			name: "query length below minimum",
			input: RecordSearchTelemetryRequest{
				EventType:   SearchTelemetryEventArchiveSearchSubmit,
				QueryLength: telemetryQueryLengthPtr(-1),
			},
			wantErr: "queryLength must not be less than 0",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			err := validateRecordSearchTelemetry(testCase.input)
			if testCase.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			telemetryStatusMessage(t, err, 400, testCase.wantErr)
		})
	}
}

// TestAggregateSearchTelemetry reproduces the record-then-summary round trip
// without a Redis stub: one archive_load_more_click event on search_page with
// vertical EAST_SEA and queryLength 12 must surface in totals, daily and the
// data-dependent bucket maps.
func TestAggregateSearchTelemetry(t *testing.T) {
	rows := []searchTelemetryRow{
		{
			"events.total":                   "1",
			"events.archive_load_more_click": "1",
			"surface.search_page":            "1",
			"load_more.vertical.EAST_SEA":    "1",
			"query_length.len_08_15":         "1",
		},
	}
	response := aggregateSearchTelemetry([]string{"2026-04-18"}, rows)

	if response.Surface != "all" {
		t.Fatalf("surface = %q, want %q", response.Surface, "all")
	}
	if response.From != "2026-04-18" || response.To != "2026-04-18" {
		t.Fatalf("range = %q..%q, want 2026-04-18..2026-04-18", response.From, response.To)
	}
	if response.Totals.TotalEvents != 1 {
		t.Fatalf("totals.totalEvents = %d, want 1", response.Totals.TotalEvents)
	}
	if response.Totals.EventCounts.ArchiveLoadMoreClick != 1 {
		t.Fatalf("totals.eventCounts.archive_load_more_click = %d, want 1", response.Totals.EventCounts.ArchiveLoadMoreClick)
	}
	if response.Totals.SurfaceCounts.SearchPage != 1 {
		t.Fatalf("totals.surfaceCounts.search_page = %d, want 1", response.Totals.SurfaceCounts.SearchPage)
	}
	if got := response.Totals.LoadMoreVerticalCounts["EAST_SEA"]; got != 1 {
		t.Fatalf("totals.loadMoreVerticalCounts[EAST_SEA] = %d, want 1", got)
	}
	if got := response.Totals.QueryLengthBuckets["len_08_15"]; got != 1 {
		t.Fatalf("totals.queryLengthBuckets[len_08_15] = %d, want 1", got)
	}
	if len(response.Daily) != 1 {
		t.Fatalf("daily length = %d, want 1", len(response.Daily))
	}
	point := response.Daily[0]
	if point.Date != "2026-04-18" || point.TotalEvents != 1 {
		t.Fatalf("daily[0] = %+v, want date 2026-04-18 with totalEvents 1", point)
	}
	if point.Surfaces.SearchPage != 1 {
		t.Fatalf("daily[0].surfaces.search_page = %d, want 1", point.Surfaces.SearchPage)
	}
}

// TestAggregateSearchTelemetryEmptyDay guards the fixed-key defaults: a day
// without counters still yields zeroed event/surface keys and non-nil maps.
func TestAggregateSearchTelemetryEmptyDay(t *testing.T) {
	response := aggregateSearchTelemetry([]string{"2026-04-17", "2026-04-18"}, []searchTelemetryRow{{}})
	if response.Totals.QueryLengthBuckets == nil || response.Totals.LoadMoreVerticalCounts == nil {
		t.Fatal("bucket maps must be non-nil so they serialize as {}")
	}
	if response.Totals.TotalEvents != 0 || response.Totals.SurfaceCounts.EventsArchive != 0 {
		t.Fatalf("unexpected totals: %+v", response.Totals)
	}
	if len(response.Daily) != 2 {
		t.Fatalf("daily length = %d, want 2", len(response.Daily))
	}
	if response.From != "2026-04-17" || response.To != "2026-04-18" {
		t.Fatalf("range = %q..%q, want 2026-04-17..2026-04-18", response.From, response.To)
	}
	second := response.Daily[1]
	if second.Date != "2026-04-18" || second.TotalEvents != 0 || second.Events.ArchiveSearchSubmit != 0 {
		t.Fatalf("daily[1] = %+v, want zeroed counters for 2026-04-18", second)
	}
}

// TestSearchTelemetryMetricKey checks the day bucket key uses the UTC date.
func TestSearchTelemetryMetricKey(t *testing.T) {
	cases := []struct {
		name string
		when time.Time
		want string
	}{
		{
			name: "utc evening",
			when: time.Date(2026, time.April, 18, 23, 30, 0, 0, time.UTC),
			want: "search-telemetry:org-1:2026-04-18",
		},
		{
			name: "local date ahead of utc",
			when: time.Date(2026, time.April, 19, 1, 0, 0, 0, time.FixedZone("UTC+3", 3*60*60)),
			want: "search-telemetry:org-1:2026-04-18",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := searchTelemetryMetricKey("org-1", testCase.when); got != testCase.want {
				t.Fatalf("searchTelemetryMetricKey() = %q, want %q", got, testCase.want)
			}
		})
	}
}
