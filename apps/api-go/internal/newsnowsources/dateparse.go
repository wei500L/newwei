package newsnowsources

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// shanghai is the fixed +08:00 zone used by every explicit Asia/Shanghai date
// conversion in the providers. China has no DST, so a fixed zone matches the
// IANA zone for every date these sources can return.
func shanghai() *time.Location { return time.FixedZone("Asia/Shanghai", 8*60*60) }

// millisOf converts an instant to epoch milliseconds.
func millisOf(value time.Time) int64 { return value.UnixNano() / int64(time.Millisecond) }

// durationSegment is one `<number><unit>` pair of a relative duration.
type durationSegment struct {
	value int
	unit  string
}

var durationSegmentPattern = regexp.MustCompile(`(?i)(\d+)\s*(年|个月|月|周|星期|天|日|小时|时|分钟|分|秒钟|秒|years?|months?|weeks?|days?|hours?|minutes?|seconds?)`)

var clockPattern = regexp.MustCompile(`^(\d{1,2}):(\d{2})(?::(\d{2}))?$`)
var clockMeridiemPattern = regexp.MustCompile(`(?i)^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)$`)
var hourMeridiemPattern = regexp.MustCompile(`(?i)^(\d{1,2})\s*(am|pm)$`)

// parseRelativeDate mirrors sources/date.ts parseRelativeDate closely enough
// for the reachable formats: "刚刚", "<n><unit>前/ago", 今天/昨天/前天/明天/后天
// and 周X/星期X with an optional clock. Anything else is returned unchanged,
// because the NestJS helper falls through with the original string and
// `.valueOf()` then yields that string (not a timestamp).
func parseRelativeDate(value string, loc *time.Location, now time.Time) DateValue {
	trimmed := strings.TrimSpace(value)
	if trimmed == "刚刚" {
		return Millis(millisOf(now))
	}

	lowered := strings.ToLower(trimmed)
	if strings.HasSuffix(lowered, "前") || strings.HasSuffix(lowered, "ago") {
		body := strings.TrimSuffix(strings.TrimSuffix(lowered, "前"), "ago")
		if segments := parseDurationSegments(body); len(segments) > 0 {
			return Millis(millisOf(subtractDuration(now, segments)))
		}
	}

	// The word branch evaluates on the de-spaced, lower-cased text: "今天 10:20"
	// becomes "今天10:20" so the prefix regex and the clock suffix split cleanly.
	compact := strings.NewReplacer(" ", "", ",", "", "，", "", "\t", "").Replace(lowered)

	base, rest, ok := matchDayWord(compact, now.In(loc))
	if !ok {
		return StringDate(value)
	}
	hour, minute, second, valid := parseClock(rest)
	if !valid {
		return NullDate()
	}
	instant := time.Date(base.Year(), base.Month(), base.Day(), hour, minute, second, 0, loc)
	return Millis(millisOf(instant))
}

// parseDurationSegments extracts every `<number><unit>` pair. A repeated unit
// keeps the last value, which is what the NestJS duration map does.
func parseDurationSegments(text string) []durationSegment {
	matches := durationSegmentPattern.FindAllStringSubmatch(text, -1)
	if len(matches) == 0 {
		return nil
	}
	order := make([]string, 0, len(matches))
	byUnit := make(map[string]int, len(matches))
	for _, match := range matches {
		amount, err := strconv.Atoi(match[1])
		if err != nil {
			continue
		}
		unit := normalizeDurationUnit(match[2])
		if _, seen := byUnit[unit]; !seen {
			order = append(order, unit)
		}
		byUnit[unit] = amount
	}
	segments := make([]durationSegment, 0, len(order))
	for _, unit := range order {
		segments = append(segments, durationSegment{value: byUnit[unit], unit: unit})
	}
	return segments
}

// normalizeDurationUnit folds every spelling onto one canonical unit.
func normalizeDurationUnit(raw string) string {
	switch strings.ToLower(raw) {
	case "年", "year", "years":
		return "year"
	case "个月", "月", "month", "months":
		return "month"
	case "周", "星期", "week", "weeks":
		return "week"
	case "天", "日", "day", "days":
		return "day"
	case "小时", "时", "hour", "hours":
		return "hour"
	case "分钟", "分", "minute", "minutes":
		return "minute"
	case "秒钟", "秒", "second", "seconds":
		return "second"
	default:
		return strings.ToLower(raw)
	}
}

// subtractDuration applies the parsed segments in dayjs duration order.
func subtractDuration(now time.Time, segments []durationSegment) time.Time {
	years, months, days := 0, 0, 0
	duration := time.Duration(0)
	for _, segment := range segments {
		switch segment.unit {
		case "year":
			years += segment.value
		case "month":
			months += segment.value
		case "week":
			days += segment.value * 7
		case "day":
			days += segment.value
		case "hour":
			duration += time.Duration(segment.value) * time.Hour
		case "minute":
			duration += time.Duration(segment.value) * time.Minute
		case "second":
			duration += time.Duration(segment.value) * time.Second
		}
	}
	return now.AddDate(-years, -months, -days).Add(-duration)
}

// matchDayWord strips a day word prefix and returns its start-of-day base plus
// the clock suffix.
func matchDayWord(compact string, localNow time.Time) (time.Time, string, bool) {
	today := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 0, 0, 0, 0, localNow.Location())

	type word struct {
		prefix string
		offset int
	}
	words := []word{
		{"今天", 0}, {"今日", 0}, {"today", 0},
		{"昨天", -1}, {"昨日", -1}, {"yesterday", -1},
		{"前天", -2},
		{"明天", 1}, {"明日", 1}, {"tomorrow", 1},
		{"后天", 2},
	}
	for _, entry := range words {
		if strings.HasPrefix(compact, entry.prefix) {
			base := today.AddDate(0, 0, entry.offset)
			return base, compact[len(entry.prefix):], true
		}
	}

	weekdays := map[string]int{
		"周一": 1, "星期一": 1,
		"周二": 2, "星期二": 2,
		"周三": 3, "星期三": 3,
		"周四": 4, "星期四": 4,
		"周五": 5, "星期五": 5,
		"周六": 6, "星期六": 6,
		"周日": 7, "周天": 7, "星期日": 7, "星期天": 7,
	}
	for prefix, target := range weekdays {
		if !strings.HasPrefix(compact, prefix) {
			continue
		}
		weekStart := today.AddDate(0, 0, -int(today.Weekday()))
		targetDay := weekStart.AddDate(0, 0, target%7)
		if !targetDay.After(today) {
			targetDay = targetDay.AddDate(0, 0, -7)
		}
		return targetDay, compact[len(prefix):], true
	}
	return time.Time{}, "", false
}

// parseClock parses "", "HH:MM", "HH:MM:SS" and am/pm variants. An unparsable
// suffix maps to dayjs' Invalid Date, which the caller serialises as null.
func parseClock(rest string) (int, int, int, bool) {
	text := strings.TrimSpace(rest)
	if text == "" {
		return 0, 0, 0, true
	}
	if match := clockPattern.FindStringSubmatch(text); match != nil {
		hour, _ := strconv.Atoi(match[1])
		minute, _ := strconv.Atoi(match[2])
		second := 0
		if match[3] != "" {
			second, _ = strconv.Atoi(match[3])
		}
		if hour > 23 || minute > 59 || second > 59 {
			return 0, 0, 0, false
		}
		return hour, minute, second, true
	}
	if match := clockMeridiemPattern.FindStringSubmatch(text); match != nil {
		hour, _ := strconv.Atoi(match[1])
		minute, _ := strconv.Atoi(match[2])
		second := 0
		if match[3] != "" {
			second, _ = strconv.Atoi(match[3])
		}
		hour = applyMeridiem(hour, match[4])
		if hour < 0 {
			return 0, 0, 0, false
		}
		return hour, minute, second, true
	}
	if match := hourMeridiemPattern.FindStringSubmatch(text); match != nil {
		hour, _ := strconv.Atoi(match[1])
		hour = applyMeridiem(hour, match[2])
		if hour < 0 {
			return 0, 0, 0, false
		}
		return hour, 0, 0, true
	}
	return 0, 0, 0, false
}

// applyMeridiem converts a 12-hour clock to 24 hours; -1 means invalid.
func applyMeridiem(hour int, meridiem string) int {
	if hour < 1 || hour > 12 {
		return -1
	}
	if strings.EqualFold(meridiem, "pm") {
		if hour == 12 {
			return 12
		}
		return hour + 12
	}
	if hour == 12 {
		return 0
	}
	return hour
}

var naiveDateLayouts = []string{
	"2006-01-02 15:04:05.999999999",
	"2006-01-02T15:04:05.999999999",
	"2006-01-02 15:04:05",
	"2006-01-02T15:04:05",
	"2006-01-02 15:04",
	"2006-01-02",
	"2006/01/02 15:04:05",
	"2006/01/02 15:04",
	"2006/01/02",
}

// tranformToUTC mirrors `dayjs.tz(date, timezone).valueOf()`: a zone-less value
// is interpreted in Asia/Shanghai, an zoned value keeps its instant, and an
// invalid value becomes NaN (serialised as null).
func tranformToUTC(value string, loc *time.Location) DateValue {
	text := strings.TrimSpace(value)
	if text == "" {
		return NullDate()
	}
	for _, layout := range naiveDateLayouts {
		if parsed, err := time.ParseInLocation(layout, text, loc); err == nil {
			return Millis(millisOf(parsed))
		}
	}
	if parsed, err := time.Parse(time.RFC3339Nano, text); err == nil {
		return Millis(millisOf(parsed))
	}
	return NullDate()
}

// dayjsToday mirrors `dayjs().format("YYYY-MM-DD")`: the process-local zone, not
// a forced UTC date.
func dayjsToday(now time.Time) string { return now.Format("2006-01-02") }

// isoMillis mirrors `new Date(ms).toISOString()`.
func isoMillis(milliseconds int64) string {
	return time.UnixMilli(milliseconds).UTC().Format("2006-01-02T15:04:05.000Z")
}
