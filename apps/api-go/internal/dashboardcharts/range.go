package dashboardcharts

import (
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const defaultRangeDays = 30

// 与 class-validator @IsISO8601() 的非 strict 形态对齐：先认格式，
// 日历是否成立交给后面的 Date 解析。2026-02-31 能通过这一层。
var iso8601RE = regexp.MustCompile(`^(?:[+-])?\d{4}(?:-(?:(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?|W(?:[0-4]\d|5[0-3])(?:-[1-7])?|(?:00[1-9]|0[1-9]\d|[12]\d{2}|3(?:[0-5]\d|6[1-6]))))?(?:[T ](?:(?:(?:[01]\d|2[0-3])(?::[0-5]\d(?::[0-5]\d(?:[.,]\d+)?)?)?)|24:00(?::00(?:\.0+)?)?)(?:[zZ]|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$`)

type dashboardQuery struct {
	start      string
	end        string
	startSet   bool
	endSet     bool
	startMulti bool
	endMulti   bool
	unknown    []string
}

func parseDashboardQuery(r *http.Request) dashboardQuery {
	var query dashboardQuery
	raw := r.URL.RawQuery
	if raw == "" {
		return query
	}
	seenUnknown := map[string]struct{}{}
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
		switch key {
		case "start":
			if query.startSet {
				query.startMulti = true
				continue
			}
			query.start = value
			query.startSet = true
		case "end":
			if query.endSet {
				query.endMulti = true
				continue
			}
			query.end = value
			query.endSet = true
		default:
			if key == "" {
				continue
			}
			if _, ok := seenUnknown[key]; ok {
				continue
			}
			seenUnknown[key] = struct{}{}
			query.unknown = append(query.unknown, key)
		}
	}
	return query
}

func decodeQueryComponent(value string) string {
	decoded, err := url.QueryUnescape(strings.ReplaceAll(value, "+", " "))
	if err != nil {
		return value
	}
	return decoded
}

// validationMessage 是 ValidationPipe 在进入 controller 之前的 400。
// 已知字段的 ISO 错误在前，多余 query 键按出现顺序接在后面，用 "; " 连接。
func validationMessage(query dashboardQuery) string {
	var parts []string
	if query.startSet && (query.startMulti || !isISO8601(query.start)) {
		parts = append(parts, "start must be a valid ISO 8601 date string")
	}
	if query.endSet && (query.endMulti || !isISO8601(query.end)) {
		parts = append(parts, "end must be a valid ISO 8601 date string")
	}
	for _, key := range query.unknown {
		parts = append(parts, "property "+key+" should not exist")
	}
	return strings.Join(parts, "; ")
}

func isISO8601(value string) bool {
	return iso8601RE.MatchString(value)
}

// resolveRange 对齐 DashboardChartsService.resolveRange，alignToUtcDay 默认为 true。
// 缺省 end 是现在，缺省 start 是对齐前的 end 往前 30 天。
// 返回的 message 非空时是 BadRequestException 的原文。
func resolveRange(query dashboardQuery, now time.Time) (time.Time, time.Time, string) {
	var end time.Time
	if !query.endSet {
		end = now
	} else {
		parsed, ok := parseJSDate(query.end)
		if !ok {
			return time.Time{}, time.Time{}, "Invalid date range"
		}
		end = parsed
	}
	var start time.Time
	if !query.startSet {
		start = end.Add(-defaultRangeDays * 24 * time.Hour)
	} else {
		parsed, ok := parseJSDate(query.start)
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

func alignUTCDayStart(value time.Time) time.Time {
	value = value.UTC()
	return time.Date(value.Year(), value.Month(), value.Day(), 0, 0, 0, 0, time.UTC)
}

func alignUTCDayEnd(value time.Time) time.Time {
	value = value.UTC()
	return time.Date(value.Year(), value.Month(), value.Day(), 23, 59, 59, int(time.Millisecond)*999, time.UTC)
}

func parseJSDate(value string) (time.Time, bool) {
	if len(value) == 4 {
		year, ok := atoiStrict(value)
		if ok {
			return time.Date(year, time.January, 1, 0, 0, 0, 0, time.UTC), true
		}
	}
	if len(value) == 7 && value[4] == '-' {
		year, okY := atoiStrict(value[:4])
		month, okM := atoiStrict(value[5:])
		if okY && okM && month >= 1 && month <= 12 {
			return time.Date(year, time.Month(month), 1, 0, 0, 0, 0, time.UTC), true
		}
	}
	if len(value) == 10 && value[4] == '-' && value[7] == '-' {
		year, okY := atoiStrict(value[:4])
		month, okM := atoiStrict(value[5:7])
		day, okD := atoiStrict(value[8:])
		if okY && okM && okD && validYMD(year, month, day) {
			return time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC), true
		}
		return time.Time{}, false
	}

	normalized := strings.ReplaceAll(value, ",", ".")
	if strings.Contains(normalized, " ") {
		normalized = strings.Replace(normalized, " ", "T", 1)
	}
	normalized = strings.ReplaceAll(normalized, "z", "Z")
	normalized = insertOffsetColon(normalized)
	layouts := []string{
		time.RFC3339Nano,
		"2006-01-02T15:04:05Z07:00",
		"2006-01-02T15:04Z07:00",
	}
	for _, layout := range layouts {
		parsed, err := time.Parse(layout, normalized)
		if err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

func insertOffsetColon(value string) string {
	if len(value) < 5 {
		return value
	}
	tail := value[len(value)-5:]
	if (tail[0] != '+' && tail[0] != '-') || strings.Contains(tail, ":") {
		return value
	}
	for _, ch := range tail[1:] {
		if ch < '0' || ch > '9' {
			return value
		}
	}
	return value[:len(value)-5] + tail[:3] + ":" + tail[3:]
}

func validYMD(year, month, day int) bool {
	if month < 1 || month > 12 || day < 1 {
		return false
	}
	parsed := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	return parsed.Year() == year && int(parsed.Month()) == month && parsed.Day() == day
}

func atoiStrict(value string) (int, bool) {
	if value == "" {
		return 0, false
	}
	n := 0
	for _, ch := range value {
		if ch < '0' || ch > '9' {
			return 0, false
		}
		n = n*10 + int(ch-'0')
	}
	return n, true
}

func toISO(value time.Time) string {
	return time.UnixMilli(value.UTC().UnixMilli()).UTC().Format("2006-01-02T15:04:05.000Z")
}
