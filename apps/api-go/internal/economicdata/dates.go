package economicdata

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

var shanghai = time.FixedZone("Asia/Shanghai", 8*60*60)

var (
	compactHHMMSS = regexp.MustCompile(`^(\d{2})(\d{2})(\d{2})$`)
	compactHHMM   = regexp.MustCompile(`^(\d{2})(\d{2})$`)
	colonTime     = regexp.MustCompile(`^(\d{1,2}):(\d{2})(?::(\d{2}))?$`)
	naiveDateTime = regexp.MustCompile(`^\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}(?::\d{2})?`)
	numericDate   = regexp.MustCompile(`^\d{10,13}$`)
	quarterDate   = regexp.MustCompile(`^(\d{4})\s*(?:年\s*)?(?:Q([1-4])|第\s*([1-4])\s*季度)$`)
	chineseDate   = regexp.MustCompile(`^(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?(?:\s*(\d{1,2})(?:[:时]\s*(\d{1,2}))?(?:[:分]\s*(\d{1,2}))?(?:\.(\d{1,3}))?\s*(?:秒)?)?\s*$`)
	dotDate       = regexp.MustCompile(`^(\d{4})[.](\d{1,2})[.](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$`)
	yearMonthDate = regexp.MustCompile(`^(\d{4})[-/.](\d{1,2})$`)
	yearOnlyDate  = regexp.MustCompile(`^(\d{4})(?:\s*年)?$`)
)

// parseDateValue mirrors BaseParser.parseDate/tryParseDate. Missing or invalid
// values return the current instant through parseDate, while required fields use
// parseRequiredDate and fail.
func parseDateValue(value any) time.Time {
	if parsed, ok := tryParseDate(value); ok {
		return parsed
	}
	return time.Now()
}

func parseRequiredDate(value any, field, slug string) (time.Time, error) {
	if parsed, ok := tryParseDate(value); ok {
		return parsed, nil
	}
	suffix := ""
	if slug != "" {
		suffix = " for " + slug
	}
	return time.Time{}, &parseError{message: `Invalid or missing date field "` + field + `"` + suffix}
}

type parseError struct{ message string }

func (e *parseError) Error() string { return e.message }

func tryParseDate(value any) (time.Time, bool) {
	text, ok := value.(string)
	if !ok {
		return time.Time{}, false
	}
	trimmed := strings.TrimSpace(text)
	if numericDate.MatchString(trimmed) {
		value, err := strconv.ParseInt(trimmed, 10, 64)
		if err == nil {
			if len(trimmed) <= 10 {
				value *= 1000
			}
			return time.UnixMilli(value).UTC(), true
		}
	}
	if match := quarterDate.FindStringSubmatch(trimmed); match != nil {
		year, _ := strconv.Atoi(match[1])
		quarter, _ := strconv.Atoi(match[2])
		if quarter == 0 {
			quarter, _ = strconv.Atoi(match[3])
		}
		return time.Date(year, time.Month((quarter-1)*3+1), 1, 0, 0, 0, 0, time.UTC), true
	}
	if match := chineseDate.FindStringSubmatch(trimmed); match != nil {
		year, _ := strconv.Atoi(match[1])
		month, _ := strconv.Atoi(match[2])
		day := 1
		if match[3] != "" {
			day, _ = strconv.Atoi(match[3])
		}
		hour, minute, second := 0, 0, 0
		if match[4] != "" {
			hour, _ = strconv.Atoi(match[4])
			if match[5] != "" {
				minute, _ = strconv.Atoi(match[5])
			}
			if match[6] != "" {
				second, _ = strconv.Atoi(match[6])
			}
		}
		return time.Date(year, time.Month(month), day, hour, minute, second, 0, time.UTC), true
	}
	if match := dotDate.FindStringSubmatch(trimmed); match != nil {
		year, _ := strconv.Atoi(match[1])
		month, _ := strconv.Atoi(match[2])
		day, _ := strconv.Atoi(match[3])
		hour, minute, second := 0, 0, 0
		if match[4] != "" {
			hour, _ = strconv.Atoi(match[4])
			minute, _ = strconv.Atoi(match[5])
			if match[6] != "" {
				second, _ = strconv.Atoi(match[6])
			}
		}
		return time.Date(year, time.Month(month), day, hour, minute, second, 0, time.UTC), true
	}
	if match := yearMonthDate.FindStringSubmatch(trimmed); match != nil {
		year, _ := strconv.Atoi(match[1])
		month, _ := strconv.Atoi(match[2])
		return time.Date(year, time.Month(month), 1, 0, 0, 0, 0, time.UTC), true
	}
	if match := yearOnlyDate.FindStringSubmatch(trimmed); match != nil {
		year, _ := strconv.Atoi(match[1])
		return time.Date(year, time.January, 1, 0, 0, 0, 0, time.UTC), true
	}
	if match := compactHHMMSS.FindStringSubmatch(trimmed); match != nil {
		if parsed, ok := intradayToday(match[1], match[2], match[3]); ok {
			return parsed, true
		}
	}
	if match := compactHHMM.FindStringSubmatch(trimmed); match != nil {
		if parsed, ok := intradayToday(match[1], match[2], "00"); ok {
			return parsed, true
		}
	}
	if match := colonTime.FindStringSubmatch(trimmed); match != nil {
		seconds := "00"
		if len(match) > 3 && match[3] != "" {
			seconds = match[3]
		}
		if parsed, ok := intradayToday(match[1], match[2], seconds); ok {
			return parsed, true
		}
	}
	if naiveDateTime.MatchString(trimmed) {
		layouts := []string{"2006-01-02 15:04:05", "2006-01-02 15:04", "2006/01/02 15:04:05", "2006/01/02 15:04"}
		for _, layout := range layouts {
			if parsed, err := time.ParseInLocation(layout, trimmed, shanghai); err == nil && parsed.Year() >= 1000 && parsed.Year() <= 9999 {
				return parsed.UTC(), true
			}
		}
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.000Z07:00", "2006-01-02T15:04:05Z07:00", "2006-01-02", "2006/01/02", "2006-01-02 15:04:05"} {
		var parsed time.Time
		var err error
		if strings.Contains(layout, "Z07:00") || layout == time.RFC3339Nano {
			parsed, err = time.Parse(layout, trimmed)
		} else {
			parsed, err = time.ParseInLocation(layout, trimmed, time.UTC)
		}
		if err == nil && parsed.Year() >= 1000 && parsed.Year() <= 9999 {
			return parsed.UTC(), true
		}
	}
	return time.Time{}, false
}

func intradayToday(hoursRaw, minutesRaw, secondsRaw string) (time.Time, bool) {
	hours, err1 := strconv.Atoi(hoursRaw)
	minutes, err2 := strconv.Atoi(minutesRaw)
	seconds, err3 := strconv.Atoi(secondsRaw)
	if err1 != nil || err2 != nil || err3 != nil || hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59 {
		return time.Time{}, false
	}
	now := time.Now().In(shanghai)
	return time.Date(now.Year(), now.Month(), now.Day(), hours, minutes, seconds, 0, shanghai).UTC(), true
}

func parseYearMonthDate(yearRaw, monthRaw, dayRaw any) (time.Time, bool) {
	year, yearOK := numberInt(yearRaw)
	month, monthOK := numberInt(monthRaw)
	day := 1
	dayOK := true
	if dayRaw != nil {
		day, dayOK = numberInt(dayRaw)
	}
	if yearOK && monthOK && dayOK && year >= 1000 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= 31 {
		return time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC), true
	}
	if yearOK && monthOK && year >= 1000 && year <= 9999 && month >= 1 && month <= 12 {
		return time.Date(year, time.Month(month), 1, 0, 0, 0, 0, time.UTC), true
	}
	return time.Time{}, false
}

func numberInt(value any) (int, bool) {
	switch typed := value.(type) {
	case int:
		return typed, true
	case int64:
		return int(typed), true
	case float64:
		if typed != float64(int(typed)) {
			return 0, false
		}
		return int(typed), true
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(typed))
		return parsed, err == nil
	default:
		return 0, false
	}
}

// shanghaiDateYYYYMMDD mirrors resolveParamTemplate's Asia/Shanghai calendar
// date, independent of the container timezone database.
func shanghaiDateYYYYMMDD(deltaDays int) string {
	return time.Now().In(shanghai).AddDate(0, 0, deltaDays).Format("20060102")
}
