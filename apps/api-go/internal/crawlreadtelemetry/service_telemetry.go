package crawlreadtelemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// Search telemetry constants mirror search-telemetry.constants.ts.
const (
	// searchTelemetryKeyPrefix is SEARCH_TELEMETRY_KEY_PREFIX.
	searchTelemetryKeyPrefix = "search-telemetry"
	// searchTelemetryRetentionSeconds is SEARCH_TELEMETRY_RETENTION_SECONDS.
	searchTelemetryRetentionSeconds = 30 * 24 * 60 * 60
	// searchTelemetryDateLayout is the UTC day bucket format (YYYY-MM-DD).
	searchTelemetryDateLayout = "2006-01-02"
	// searchTelemetryMaxRangeDays is the inclusive span limit of getSummary.
	searchTelemetryMaxRangeDays = 31
)

// Counter hash field names shared by the record and summary endpoints.
const (
	searchTelemetryTotalField                  = "events.total"
	searchTelemetryEventFieldPrefix            = "events."
	searchTelemetrySurfaceFieldPrefix          = "surface."
	searchTelemetryQueryLengthFieldPrefix      = "query_length."
	searchTelemetryLoadMoreVerticalFieldPrefix = "load_more.vertical."
)

// Validation and service error messages are byte-identical to the
// class-validator defaults and to SearchTelemetryService errors.
const (
	searchTelemetryEventTypeMessage      = "eventType must be one of the following values: archive_search_submit, archive_query_too_short, archive_load_more_click"
	searchTelemetrySurfaceMessage        = "surface must be one of the following values: search_page, events_archive"
	searchTelemetryVerticalMessage       = "vertical must be one of the following values: EAST_SEA, SOUTH_SEA, WEST_FRONT, FOREIGN_AFFAIRS, DOMESTIC_AFFAIRS"
	searchTelemetryQueryLengthMaxMessage = "queryLength must not be greater than 500"
	searchTelemetryQueryLengthMinMessage = "queryLength must not be less than 0"
	searchTelemetrySurfaceFilterMessage  = "surface filtering is not supported by the stored telemetry counters"
	searchTelemetryInvalidDateMessage    = "invalid date"
	searchTelemetryDateShapeMessage      = "date must use YYYY-MM-DD"
	searchTelemetryRangeOrderMessage     = "from must be less than or equal to to"
	searchTelemetryRangeSpanMessage      = "date range cannot exceed 31 days"
)

// The two @Matches messages always carry the property name and the regular
// expression source, exactly like the class-validator default message.
const (
	searchTelemetryFromMatchMessage = `from must match /^\d{4}-\d{2}-\d{2}$/ regular expression`
	searchTelemetryToMatchMessage   = `to must match /^\d{4}-\d{2}-\d{2}$/ regular expression`
)

// searchTelemetryDatePattern is the SearchTelemetrySummaryQueryDto @Matches
// regular expression.
var searchTelemetryDatePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// searchTelemetryWriteScript applies every counter increment and the retention
// TTL in one round trip. ARGV[1] is the TTL followed by one field/value pair per
// counter. Lua keeps the whole write atomic, so the stored keys, field names and
// counting semantics are unchanged.
const searchTelemetryWriteScript = `
local ttl = tonumber(ARGV[1])
for index = 2, #ARGV, 2 do
  redis.call("HINCRBY", KEYS[1], ARGV[index], ARGV[index + 1])
end
redis.call("EXPIRE", KEYS[1], ttl)
return 1
`

// serveTelemetryRecord handles POST /api/search-telemetry (permission
// items.read). The NestJS guard runs before the ValidationPipe, so
// authorization is enforced before the body is decoded or validated.
func (h *Handler) serveTelemetryRecord(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		authhttp.WriteHTTPException(w, r, http.StatusNotFound, "Cannot "+r.Method+" "+r.URL.Path)
		return
	}
	identity := h.authorize(w, r, permissionItemsRead)
	if identity == nil {
		return
	}

	// captured keeps the consumed body bytes so a JSON syntax failure can be
	// reported with the body-parser message shape.
	captured := &bytes.Buffer{}
	var input RecordSearchTelemetryRequest
	if err := json.NewDecoder(io.TeeReader(r.Body, captured)).Decode(&input); err != nil {
		if !errors.Is(err, io.EOF) {
			authhttp.WriteBadRequest(w, r, searchTelemetryInvalidJSONMessage(captured.Bytes()))
			return
		}
		// An empty body behaves like body-parser's {}: the missing eventType is
		// reported by validation below.
	}
	if err := validateRecordSearchTelemetry(input); err != nil {
		writeServiceError(w, r, err)
		return
	}
	if err := h.svc.recordSearchTelemetry(r.Context(), identity.OrgID, input); err != nil {
		writeServiceError(w, r, err)
		return
	}
	body, err := json.Marshal(searchTelemetryRecordResponse{Recorded: true})
	if err != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	writeJSONBody(w, http.StatusCreated, body)
}

// serveTelemetrySummary handles GET /api/admin/search-telemetry/summary
// (permission settings.manage). The check order matches the migrated contract:
// a present surface query parameter is rejected first, then the from/to
// patterns, and the remaining calendar and span checks run inside the service.
func (h *Handler) serveTelemetrySummary(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		authhttp.WriteHTTPException(w, r, http.StatusNotFound, "Cannot "+r.Method+" "+r.URL.Path)
		return
	}
	identity := h.authorize(w, r, permissionSettingsManage)
	if identity == nil {
		return
	}
	if _, present := querySingle(r, "surface"); present {
		writeServiceError(w, r, newStatusError(http.StatusBadRequest, searchTelemetrySurfaceFilterMessage))
		return
	}
	from, hasFrom := querySingle(r, "from")
	if !hasFrom || !searchTelemetryDatePattern.MatchString(from) {
		writeServiceError(w, r, newStatusError(http.StatusBadRequest, searchTelemetryFromMatchMessage))
		return
	}
	to, hasTo := querySingle(r, "to")
	if !hasTo || !searchTelemetryDatePattern.MatchString(to) {
		writeServiceError(w, r, newStatusError(http.StatusBadRequest, searchTelemetryToMatchMessage))
		return
	}
	response, err := h.svc.searchTelemetrySummary(r.Context(), identity.OrgID, from, to)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	body, err := json.Marshal(response)
	if err != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	writeJSONBody(w, http.StatusOK, body)
}

// validateRecordSearchTelemetry mirrors the class-validator rules of
// RecordSearchTelemetryDto, in declaration order. It returns a typed 400.
func validateRecordSearchTelemetry(input RecordSearchTelemetryRequest) error {
	if !isSearchTelemetryEventType(string(input.EventType)) {
		return newStatusError(http.StatusBadRequest, searchTelemetryEventTypeMessage)
	}
	if input.Surface != nil && !isSearchTelemetrySurface(string(*input.Surface)) {
		return newStatusError(http.StatusBadRequest, searchTelemetrySurfaceMessage)
	}
	if input.Vertical != nil && !isArchiveVertical(string(*input.Vertical)) {
		return newStatusError(http.StatusBadRequest, searchTelemetryVerticalMessage)
	}
	if input.QueryLength != nil {
		if *input.QueryLength > 500 {
			return newStatusError(http.StatusBadRequest, searchTelemetryQueryLengthMaxMessage)
		}
		if *input.QueryLength < 0 {
			return newStatusError(http.StatusBadRequest, searchTelemetryQueryLengthMinMessage)
		}
	}
	return nil
}

// recordSearchTelemetry mirrors SearchTelemetryService.record: it increments the
// UTC day bucket hash fields and refreshes the 30 day retention TTL. Every
// Redis failure is swallowed, because the NestJS method wraps the whole block
// in try/catch and the endpoint always answers {"recorded":true}.
func (s *Service) recordSearchTelemetry(ctx context.Context, orgID string, input RecordSearchTelemetryRequest) error {
	if s == nil || s.redis == nil {
		// A missing Redis client is a swallowed cache failure on the NestJS
		// side as well: the telemetry endpoint stays non-blocking.
		return nil
	}
	key := searchTelemetryMetricKey(orgID, time.Now())
	fields := make([]string, 0, 5)
	fields = append(fields,
		searchTelemetryTotalField,
		searchTelemetryEventFieldPrefix+string(input.EventType),
	)
	if input.Surface != nil {
		fields = append(fields, searchTelemetrySurfaceFieldPrefix+string(*input.Surface))
	}
	if input.Vertical != nil && input.EventType == SearchTelemetryEventArchiveLoadMoreClick {
		fields = append(fields, searchTelemetryLoadMoreVerticalFieldPrefix+string(*input.Vertical))
	}
	if input.QueryLength != nil {
		fields = append(fields, searchTelemetryQueryLengthFieldPrefix+resolveQueryLengthBucket(*input.QueryLength))
	}

	// One EVAL applies the increments and the TTL refresh together, replacing
	// the previous pipeline plus EXPIRE pair. args is the driver argument list
	// (TTL, then field/value pairs), not business data.
	args := make([]interface{}, 0, 1+2*len(fields))
	args = append(args, searchTelemetryRetentionSeconds)
	for _, field := range fields {
		args = append(args, field, 1)
	}
	if err := s.redis.Eval(ctx, searchTelemetryWriteScript, []string{key}, args...).Err(); err != nil {
		return nil
	}
	return nil
}

// searchTelemetrySummary mirrors SearchTelemetryService.getSummary: it
// validates the range, reads one day bucket hash per inclusive day and
// aggregates the counters. A Redis read failure becomes errRedis (HTTP 500).
func (s *Service) searchTelemetrySummary(ctx context.Context, orgID, from, to string) (SearchTelemetrySummaryResponse, error) {
	start, end, err := searchTelemetryDateRange(from, to)
	if err != nil {
		return SearchTelemetrySummaryResponse{}, err
	}
	dates := searchTelemetryDays(start, end)
	if s == nil || s.redis == nil {
		return SearchTelemetrySummaryResponse{}, fmt.Errorf("%w: redis is not configured", errRedis)
	}
	rows := make([]searchTelemetryRow, 0, len(dates))
	// One pipeline reads every day bucket instead of one HGETALL per day; the
	// rows stay index-aligned with the ascending date list.
	pipe := s.redis.Pipeline()
	commands := make([]*redis.MapStringStringCmd, 0, len(dates))
	for _, date := range dates {
		commands = append(commands, pipe.HGetAll(ctx, searchTelemetryMetricKey(orgID, date)))
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return SearchTelemetrySummaryResponse{}, fmt.Errorf("%w: %v", errRedis, err)
	}
	for _, command := range commands {
		row, err := command.Result()
		if err != nil {
			return SearchTelemetrySummaryResponse{}, fmt.Errorf("%w: %v", errRedis, err)
		}
		rows = append(rows, row)
	}
	return aggregateSearchTelemetry(formatSearchTelemetryDates(dates), rows), nil
}

// searchTelemetryRow is one day bucket as returned by HGETALL: hash field name
// to the stored integer text.
type searchTelemetryRow map[string]string

// aggregateSearchTelemetry folds the per-day counter hashes into the summary
// payload exactly like SearchTelemetryService.getSummary. dates must be in
// ascending order; rows is index-aligned with dates.
func aggregateSearchTelemetry(dates []string, rows []searchTelemetryRow) SearchTelemetrySummaryResponse {
	response := SearchTelemetrySummaryResponse{
		Surface: "all",
		Totals: SearchTelemetrySummaryTotals{
			// Non-nil maps serialize as {} instead of null.
			QueryLengthBuckets:     map[string]int{},
			LoadMoreVerticalCounts: map[string]int{},
		},
		Daily: make([]SearchTelemetryDailyPoint, 0, len(dates)),
	}
	if len(dates) > 0 {
		response.From = dates[0]
		response.To = dates[len(dates)-1]
	}
	for index, date := range dates {
		var row searchTelemetryRow
		if index < len(rows) {
			row = rows[index]
		}
		point := SearchTelemetryDailyPoint{
			Date: date,
			Events: searchTelemetryEventCounts{
				ArchiveSearchSubmit:  searchTelemetryRowCount(row, searchTelemetryEventFieldPrefix+string(SearchTelemetryEventArchiveSearchSubmit)),
				ArchiveQueryTooShort: searchTelemetryRowCount(row, searchTelemetryEventFieldPrefix+string(SearchTelemetryEventArchiveQueryTooShort)),
				ArchiveLoadMoreClick: searchTelemetryRowCount(row, searchTelemetryEventFieldPrefix+string(SearchTelemetryEventArchiveLoadMoreClick)),
			},
			Surfaces: searchTelemetrySurfaceCounts{
				SearchPage:    searchTelemetryRowCount(row, searchTelemetrySurfaceFieldPrefix+string(SearchTelemetrySurfaceSearchPage)),
				EventsArchive: searchTelemetryRowCount(row, searchTelemetrySurfaceFieldPrefix+string(SearchTelemetrySurfaceEventsArchive)),
			},
			TotalEvents: searchTelemetryRowCount(row, searchTelemetryTotalField),
		}
		response.Totals.TotalEvents += point.TotalEvents
		response.Totals.EventCounts.ArchiveSearchSubmit += point.Events.ArchiveSearchSubmit
		response.Totals.EventCounts.ArchiveQueryTooShort += point.Events.ArchiveQueryTooShort
		response.Totals.EventCounts.ArchiveLoadMoreClick += point.Events.ArchiveLoadMoreClick
		response.Totals.SurfaceCounts.SearchPage += point.Surfaces.SearchPage
		response.Totals.SurfaceCounts.EventsArchive += point.Surfaces.EventsArchive
		for field, raw := range row {
			count := searchTelemetryRawCount(raw)
			if strings.HasPrefix(field, searchTelemetryQueryLengthFieldPrefix) {
				bucket := strings.TrimPrefix(field, searchTelemetryQueryLengthFieldPrefix)
				response.Totals.QueryLengthBuckets[bucket] += count
			}
			if strings.HasPrefix(field, searchTelemetryLoadMoreVerticalFieldPrefix) {
				vertical := strings.TrimPrefix(field, searchTelemetryLoadMoreVerticalFieldPrefix)
				response.Totals.LoadMoreVerticalCounts[vertical] += count
			}
		}
		response.Daily = append(response.Daily, point)
	}
	return response
}

// searchTelemetryMetricKey builds "<prefix>:<orgId>:<YYYY-MM-DD>" from the UTC
// date of when, mirroring SearchTelemetryService.buildMetricKey.
func searchTelemetryMetricKey(orgID string, when time.Time) string {
	return searchTelemetryKeyPrefix + ":" + orgID + ":" + when.UTC().Format(searchTelemetryDateLayout)
}

// resolveQueryLengthBucket mirrors SearchTelemetryService.resolveQueryLengthBucket.
func resolveQueryLengthBucket(length int) string {
	switch {
	case length <= 1:
		return "len_00_01"
	case length <= 3:
		return "len_02_03"
	case length <= 7:
		return "len_04_07"
	case length <= 15:
		return "len_08_15"
	case length <= 31:
		return "len_16_31"
	default:
		return "len_32_plus"
	}
}

// searchTelemetryDateRange parses from/to and enforces the ordering and span
// rules of SearchTelemetryService.resolveDateRange. It returns typed 400
// errors so the handler can emit the NestJS messages verbatim.
func searchTelemetryDateRange(from, to string) (time.Time, time.Time, error) {
	fromDate, err := parseSearchTelemetryDate(from)
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	toDate, err := parseSearchTelemetryDate(to)
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	if fromDate.After(toDate) {
		return time.Time{}, time.Time{}, newStatusError(http.StatusBadRequest, searchTelemetryRangeOrderMessage)
	}
	// Both bounds are UTC midnight, so the difference is exact whole days.
	spanDays := int(toDate.Sub(fromDate)/(24*time.Hour)) + 1
	if spanDays > searchTelemetryMaxRangeDays {
		return time.Time{}, time.Time{}, newStatusError(http.StatusBadRequest, searchTelemetryRangeSpanMessage)
	}
	return fromDate, toDate, nil
}

// parseSearchTelemetryDate mirrors SearchTelemetryService.parseDateOnly: the
// value must be a YYYY-MM-DD date that survives a UTC calendar round trip.
func parseSearchTelemetryDate(value string) (time.Time, error) {
	normalized := strings.TrimSpace(value)
	if !searchTelemetryDatePattern.MatchString(normalized) {
		return time.Time{}, newStatusError(http.StatusBadRequest, searchTelemetryDateShapeMessage)
	}
	year, _ := strconv.Atoi(normalized[0:4])
	month, _ := strconv.Atoi(normalized[5:7])
	day, _ := strconv.Atoi(normalized[8:10])
	parsed := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	if parsed.Year() != year || int(parsed.Month()) != month || parsed.Day() != day {
		return time.Time{}, newStatusError(http.StatusBadRequest, searchTelemetryInvalidDateMessage)
	}
	return parsed, nil
}

// searchTelemetryDays enumerates the inclusive UTC day range, mirroring
// SearchTelemetryService.buildDateRange.
func searchTelemetryDays(from, to time.Time) []time.Time {
	days := make([]time.Time, 0, searchTelemetryMaxRangeDays)
	for cursor := from; !cursor.After(to); cursor = cursor.AddDate(0, 0, 1) {
		days = append(days, cursor)
	}
	return days
}

// formatSearchTelemetryDates renders the inclusive day range as YYYY-MM-DD.
func formatSearchTelemetryDates(dates []time.Time) []string {
	formatted := make([]string, 0, len(dates))
	for _, date := range dates {
		formatted = append(formatted, date.Format(searchTelemetryDateLayout))
	}
	return formatted
}

// searchTelemetryRowCount reads one hash field, mirroring
// SearchTelemetryService.readFieldCount.
func searchTelemetryRowCount(row searchTelemetryRow, field string) int {
	return searchTelemetryRawCount(row[field])
}

// searchTelemetryRawCount mirrors SearchTelemetryService.readRawCount: a
// missing or non-numeric value counts as zero and negative values clamp to
// zero.
func searchTelemetryRawCount(value string) int {
	if value == "" {
		return 0
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 0 {
		return 0
	}
	return parsed
}

// searchTelemetryInvalidJSONMessage mirrors the body-parser JSON.parse failure
// message that the Nest GlobalExceptionFilter turns into a 400.
func searchTelemetryInvalidJSONMessage(body []byte) string {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return "Unexpected end of JSON input"
	}
	if bytes.Equal(trimmed, []byte("{")) {
		return "Expected property name or '}' in JSON at position 1"
	}
	token := trimmed[0]
	snippet := trimmed
	ellipsis := ""
	if len(snippet) > 10 {
		snippet = snippet[:10]
		ellipsis = "..."
	}
	return fmt.Sprintf("Unexpected token '%c', \"%s\"%s is not valid JSON", token, string(snippet), ellipsis)
}
