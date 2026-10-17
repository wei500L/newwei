package crawlreadtelemetry

// SearchTelemetryEventType is the SEARCH_TELEMETRY_EVENT_TYPES union.
type SearchTelemetryEventType string

const (
	SearchTelemetryEventArchiveSearchSubmit  SearchTelemetryEventType = "archive_search_submit"
	SearchTelemetryEventArchiveQueryTooShort SearchTelemetryEventType = "archive_query_too_short"
	SearchTelemetryEventArchiveLoadMoreClick SearchTelemetryEventType = "archive_load_more_click"
)

// isSearchTelemetryEventType reports whether value is a whitelisted event type.
func isSearchTelemetryEventType(value string) bool {
	switch SearchTelemetryEventType(value) {
	case SearchTelemetryEventArchiveSearchSubmit,
		SearchTelemetryEventArchiveQueryTooShort,
		SearchTelemetryEventArchiveLoadMoreClick:
		return true
	default:
		return false
	}
}

// SearchTelemetrySurface is the SEARCH_TELEMETRY_SURFACES union.
type SearchTelemetrySurface string

const (
	SearchTelemetrySurfaceSearchPage    SearchTelemetrySurface = "search_page"
	SearchTelemetrySurfaceEventsArchive SearchTelemetrySurface = "events_archive"
)

// isSearchTelemetrySurface reports whether value is a whitelisted surface.
func isSearchTelemetrySurface(value string) bool {
	switch SearchTelemetrySurface(value) {
	case SearchTelemetrySurfaceSearchPage, SearchTelemetrySurfaceEventsArchive:
		return true
	default:
		return false
	}
}

// ArchiveVertical is the Prisma/GraphQL ArchiveVertical enum accepted by the
// telemetry DTO. The NestJS DTO validates @IsEnum(ArchiveVertical), so Go
// accepts exactly these five values.
type ArchiveVertical string

const (
	ArchiveVerticalEastSea         ArchiveVertical = "EAST_SEA"
	ArchiveVerticalSouthSea        ArchiveVertical = "SOUTH_SEA"
	ArchiveVerticalWestFront       ArchiveVertical = "WEST_FRONT"
	ArchiveVerticalForeignAffairs  ArchiveVertical = "FOREIGN_AFFAIRS"
	ArchiveVerticalDomesticAffairs ArchiveVertical = "DOMESTIC_AFFAIRS"
)

// isArchiveVertical reports whether value is a whitelisted archive vertical.
func isArchiveVertical(value string) bool {
	switch ArchiveVertical(value) {
	case ArchiveVerticalEastSea, ArchiveVerticalSouthSea, ArchiveVerticalWestFront,
		ArchiveVerticalForeignAffairs, ArchiveVerticalDomesticAffairs:
		return true
	default:
		return false
	}
}

// RecordSearchTelemetryRequest is the validated POST /api/search-telemetry
// body. QueryLength is a pointer so an absent field is distinguishable from an
// explicit zero.
type RecordSearchTelemetryRequest struct {
	EventType   SearchTelemetryEventType `json:"eventType"`
	Surface     *SearchTelemetrySurface  `json:"surface"`
	Vertical    *ArchiveVertical         `json:"vertical"`
	QueryLength *int                     `json:"queryLength"`
}

// searchTelemetryRecordResponse is the POST response body.
type searchTelemetryRecordResponse struct {
	Recorded bool `json:"recorded"`
}

// searchTelemetryEventCounts is the fixed per-event-type counter object. The
// declaration order matches SEARCH_TELEMETRY_EVENT_TYPES so the serialized JSON
// key order matches NestJS.
type searchTelemetryEventCounts struct {
	ArchiveSearchSubmit  int `json:"archive_search_submit"`
	ArchiveQueryTooShort int `json:"archive_query_too_short"`
	ArchiveLoadMoreClick int `json:"archive_load_more_click"`
}

// searchTelemetrySurfaceCounts is the fixed per-surface counter object.
type searchTelemetrySurfaceCounts struct {
	SearchPage    int `json:"search_page"`
	EventsArchive int `json:"events_archive"`
}

// SearchTelemetrySummaryTotals mirrors the totals block of the summary.
// QueryLengthBuckets and LoadMoreVerticalCounts are named maps because their
// keys are data-dependent (bucket names and vertical values).
type SearchTelemetrySummaryTotals struct {
	TotalEvents            int                          `json:"totalEvents"`
	EventCounts            searchTelemetryEventCounts   `json:"eventCounts"`
	SurfaceCounts          searchTelemetrySurfaceCounts `json:"surfaceCounts"`
	QueryLengthBuckets     map[string]int               `json:"queryLengthBuckets"`
	LoadMoreVerticalCounts map[string]int               `json:"loadMoreVerticalCounts"`
}

// SearchTelemetryDailyPoint is one day in the summary series.
type SearchTelemetryDailyPoint struct {
	Date        string                       `json:"date"`
	TotalEvents int                          `json:"totalEvents"`
	Events      searchTelemetryEventCounts   `json:"events"`
	Surfaces    searchTelemetrySurfaceCounts `json:"surfaces"`
}

// SearchTelemetrySummaryResponse is the GET /api/admin/search-telemetry/summary
// payload.
type SearchTelemetrySummaryResponse struct {
	From    string                       `json:"from"`
	To      string                       `json:"to"`
	Surface string                       `json:"surface"`
	Totals  SearchTelemetrySummaryTotals `json:"totals"`
	Daily   []SearchTelemetryDailyPoint  `json:"daily"`
}
