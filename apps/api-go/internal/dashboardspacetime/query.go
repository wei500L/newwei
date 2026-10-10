package dashboardspacetime

import (
	"net/url"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/dashboardcharts"
)

type stringField struct {
	value string
	set   bool
	multi bool
}

func (f *stringField) add(value string) {
	if f.set {
		f.multi = true
		return
	}
	f.value = value
	f.set = true
}

type timeQuery struct {
	start   stringField
	end     stringField
	unknown []string
}

func decodeQueryComponent(value string) string {
	decoded, err := url.QueryUnescape(strings.ReplaceAll(value, "+", " "))
	if err != nil {
		return value
	}
	return decoded
}

func consumeQuery(raw string, known func(key, value string, query *timeQuery) bool) timeQuery {
	var query timeQuery
	if raw == "" {
		return query
	}
	seen := map[string]struct{}{}
	for _, part := range strings.Split(raw, "&") {
		if part == "" {
			continue
		}
		keyPart, valuePart, hasValue := strings.Cut(part, "=")
		key := decodeQueryComponent(keyPart)
		value := ""
		if hasValue {
			value = decodeQueryComponent(valuePart)
		}
		if known(key, value, &query) {
			continue
		}
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		query.unknown = append(query.unknown, key)
	}
	return query
}

func appendISO(parts []string, name string, field stringField) []string {
	if field.set && (field.multi || !dashboardcharts.ISO8601(field.value)) {
		parts = append(parts, name+" must be a valid ISO 8601 date string")
	}
	return parts
}

func appendRequiredString(parts []string, name string, field stringField) []string {
	if !field.set || field.multi {
		parts = append(parts, name+" must be a string")
	}
	return parts
}

func appendOptionalString(parts []string, name string, field stringField) []string {
	if field.multi {
		parts = append(parts, name+" must be a string")
	}
	return parts
}

func appendUnknown(parts []string, unknown []string) string {
	for _, key := range unknown {
		parts = append(parts, "property "+key+" should not exist")
	}
	return strings.Join(parts, "; ")
}

func alignUTCDayStart(value time.Time) time.Time {
	value = value.UTC()
	return time.Date(value.Year(), value.Month(), value.Day(), 0, 0, 0, 0, time.UTC)
}

func alignUTCDayEnd(value time.Time) time.Time {
	value = value.UTC()
	return time.Date(value.Year(), value.Month(), value.Day(), 23, 59, 59, int(time.Millisecond)*999, time.UTC)
}

func resolveAlignedRange(query timeQuery, now time.Time) (time.Time, time.Time, string) {
	var end time.Time
	if !query.end.set {
		end = now
	} else {
		parsed, ok := dashboardcharts.ParseJSDate(query.end.value)
		if !ok {
			return time.Time{}, time.Time{}, "Invalid date range"
		}
		end = parsed
	}
	var start time.Time
	if !query.start.set {
		start = end.Add(-defaultRangeDays * 24 * time.Hour)
	} else {
		parsed, ok := dashboardcharts.ParseJSDate(query.start.value)
		if !ok {
			return time.Time{}, time.Time{}, "Invalid date range"
		}
		start = parsed
	}
	resolvedStart := alignUTCDayStart(start)
	resolvedEnd := alignUTCDayEnd(end)
	if resolvedStart.After(resolvedEnd) {
		return time.Time{}, time.Time{}, "Start must be before end"
	}
	return resolvedStart, resolvedEnd, ""
}

type geoQuery struct {
	timeQuery
	eventID        stringField
	includeBuckets stringField
}

func parseGeoQuery(raw string) geoQuery {
	var query geoQuery
	base := consumeQuery(raw, func(key, value string, target *timeQuery) bool {
		switch key {
		case "start":
			target.start.add(value)
		case "end":
			target.end.add(value)
		case "eventId":
			query.eventID.add(value)
		case "includeBuckets":
			query.includeBuckets.add(value)
		default:
			return false
		}
		return true
	})
	query.timeQuery = base
	return query
}

func (q geoQuery) validation() string {
	parts := appendISO(nil, "start", q.start)
	parts = appendISO(parts, "end", q.end)
	parts = appendOptionalString(parts, "eventId", q.eventID)
	parts = appendOptionalString(parts, "includeBuckets", q.includeBuckets)
	return appendUnknown(parts, q.unknown)
}

type geoArticlesQuery struct {
	timeQuery
	eventID     stringField
	snapshotID  stringField
	pointID     stringField
	bucketStart stringField
	limit       stringField
}

func parseGeoArticlesQuery(raw string) geoArticlesQuery {
	var query geoArticlesQuery
	base := consumeQuery(raw, func(key, value string, target *timeQuery) bool {
		switch key {
		case "start":
			target.start.add(value)
		case "end":
			target.end.add(value)
		case "eventId":
			query.eventID.add(value)
		case "snapshotId":
			query.snapshotID.add(value)
		case "pointId":
			query.pointID.add(value)
		case "bucketStart":
			query.bucketStart.add(value)
		case "limit":
			query.limit.add(value)
		default:
			return false
		}
		return true
	})
	query.timeQuery = base
	return query
}

func (q geoArticlesQuery) validation() string {
	parts := appendISO(nil, "start", q.start)
	parts = appendISO(parts, "end", q.end)
	parts = appendOptionalString(parts, "eventId", q.eventID)
	parts = appendOptionalString(parts, "snapshotId", q.snapshotID)
	parts = appendRequiredString(parts, "pointId", q.pointID)
	parts = appendISO(parts, "bucketStart", q.bucketStart)
	parts = appendOptionalString(parts, "limit", q.limit)
	return appendUnknown(parts, q.unknown)
}

type propQuery struct {
	timeQuery
	eventID    stringField
	window     stringField
	maxNodes   stringField
	maxEdges   stringField
	maxPred    stringField
}

func parsePropQuery(raw string) propQuery {
	var query propQuery
	base := consumeQuery(raw, func(key, value string, target *timeQuery) bool {
		switch key {
		case "start":
			target.start.add(value)
		case "end":
			target.end.add(value)
		case "eventId":
			query.eventID.add(value)
		case "windowHours":
			query.window.add(value)
		case "maxNodes":
			query.maxNodes.add(value)
		case "maxEdges":
			query.maxEdges.add(value)
		case "maxPredecessorsPerSignal":
			query.maxPred.add(value)
		default:
			return false
		}
		return true
	})
	query.timeQuery = base
	return query
}

func (q propQuery) validation() string {
	parts := appendISO(nil, "start", q.start)
	parts = appendISO(parts, "end", q.end)
	parts = appendRequiredString(parts, "eventId", q.eventID)
	parts = appendOptionalString(parts, "windowHours", q.window)
	parts = appendOptionalString(parts, "maxNodes", q.maxNodes)
	parts = appendOptionalString(parts, "maxEdges", q.maxEdges)
	parts = appendOptionalString(parts, "maxPredecessorsPerSignal", q.maxPred)
	return appendUnknown(parts, q.unknown)
}

type propArticlesQuery struct {
	timeQuery
	eventID     stringField
	source      stringField
	cursorStart stringField
	cursorEnd   stringField
	limit       stringField
}

func parsePropArticlesQuery(raw string) propArticlesQuery {
	var query propArticlesQuery
	base := consumeQuery(raw, func(key, value string, target *timeQuery) bool {
		switch key {
		case "start":
			target.start.add(value)
		case "end":
			target.end.add(value)
		case "eventId":
			query.eventID.add(value)
		case "source":
			query.source.add(value)
		case "cursorStart":
			query.cursorStart.add(value)
		case "cursorEnd":
			query.cursorEnd.add(value)
		case "limit":
			query.limit.add(value)
		default:
			return false
		}
		return true
	})
	query.timeQuery = base
	return query
}

func (q propArticlesQuery) validation() string {
	parts := appendISO(nil, "start", q.start)
	parts = appendISO(parts, "end", q.end)
	parts = appendRequiredString(parts, "eventId", q.eventID)
	parts = appendRequiredString(parts, "source", q.source)
	parts = appendISO(parts, "cursorStart", q.cursorStart)
	parts = appendISO(parts, "cursorEnd", q.cursorEnd)
	parts = appendOptionalString(parts, "limit", q.limit)
	return appendUnknown(parts, q.unknown)
}

func jsParseInt(value string) (int, bool) {
	value = strings.TrimLeft(value, " \t\n\r\v\f")
	if value == "" {
		return 0, false
	}
	sign := 1
	index := 0
	if value[0] == '+' || value[0] == '-' {
		if value[0] == '-' {
			sign = -1
		}
		index++
	}
	if index >= len(value) || value[index] < '0' || value[index] > '9' {
		return 0, false
	}
	number := 0
	for index < len(value) && value[index] >= '0' && value[index] <= '9' {
		number = number*10 + int(value[index]-'0')
		index++
	}
	return sign * number, true
}

func parseBoundedInt(field stringField, fallback, min, max int) int {
	if !field.set {
		return fallback
	}
	trimmed := strings.TrimSpace(field.value)
	if trimmed == "" {
		return fallback
	}
	parsed, ok := jsParseInt(trimmed)
	if !ok {
		return fallback
	}
	if parsed < min {
		return min
	}
	if parsed > max {
		return max
	}
	return parsed
}

func parsePositiveLimit(field stringField, fallback, max int) int {
	if !field.set {
		return fallback
	}
	trimmed := strings.TrimSpace(field.value)
	if trimmed == "" {
		return fallback
	}
	parsed, ok := jsParseInt(trimmed)
	if !ok || parsed <= 0 {
		return fallback
	}
	if parsed > max {
		return max
	}
	return parsed
}
