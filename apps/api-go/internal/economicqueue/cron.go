package economicqueue

import (
	"errors"
	"strconv"
	"strings"
	"time"
)

// NextEveryMillis aligns an interval to the epoch exactly like BullMQ's
// repeatStrategy: floor(now/every)*every + every.
func NextEveryMillis(every int64, now time.Time) (int64, bool) {
	if every <= 0 {
		return 0, false
	}
	millis := now.UnixMilli()
	next := (millis/every)*every + every
	return next, true
}

// NextPatternMillis returns the next cron occurrence strictly after now (or
// from startDate when it is later). It accepts five-field cron and the
// six-field second-resolution form BullMQ uses for realtime slots. Parsing
// covers the syntax used by buildPatternForSlot plus normal ranges, lists,
// steps, month/weekday names and Sunday as 0 or 7.
func NextPatternMillis(pattern string, now time.Time, startDate *time.Time) (int64, bool) {
	spec, ok := parseCron(pattern)
	if !ok {
		return 0, false
	}
	current := now.In(time.Local)
	if startDate != nil && startDate.After(current) {
		current = startDate.In(time.Local)
	}
	if spec.hasSeconds {
		current = current.Truncate(time.Second).Add(time.Second)
	} else {
		current = current.Truncate(time.Minute).Add(time.Minute)
	}
	limit := current.AddDate(8, 0, 0)
	for !current.After(limit) {
		if !spec.months[current.Month()] {
			current = time.Date(current.Year(), current.Month()+1, 1, 0, 0, 0, 0, current.Location())
			continue
		}
		if !spec.dayMatches(current) {
			current = time.Date(current.Year(), current.Month(), current.Day()+1, 0, 0, 0, 0, current.Location())
			continue
		}
		if !spec.hours[current.Hour()] {
			current = time.Date(current.Year(), current.Month(), current.Day(), current.Hour()+1, 0, 0, 0, current.Location())
			continue
		}
		if !spec.minutes[current.Minute()] {
			current = current.Truncate(time.Minute).Add(time.Minute)
			continue
		}
		if spec.hasSeconds {
			if !spec.seconds[current.Second()] {
				current = current.Truncate(time.Second).Add(time.Second)
				continue
			}
		} else if current.Second() != 0 {
			current = current.Truncate(time.Minute).Add(time.Minute)
			continue
		}
		return current.UnixMilli(), true
	}
	return 0, false
}

type cronSpec struct {
	hasSeconds  bool
	seconds     map[int]bool
	minutes     map[int]bool
	hours       map[int]bool
	daysOfMonth map[int]bool
	months      map[time.Month]bool
	daysOfWeek  map[int]bool
	domStar     bool
	dowStar     bool
}

func (s cronSpec) dayMatches(current time.Time) bool {
	dom := s.daysOfMonth[current.Day()]
	dow := s.daysOfWeek[int(current.Weekday())]
	if s.domStar || s.dowStar {
		return dom && dow
	}
	return dom || dow
}

func parseCron(pattern string) (cronSpec, bool) {
	fields := strings.Fields(strings.TrimSpace(pattern))
	if len(fields) != 5 && len(fields) != 6 {
		return cronSpec{}, false
	}
	spec := cronSpec{
		hasSeconds:  len(fields) == 6,
		seconds:     map[int]bool{0: true},
		minutes:     map[int]bool{},
		hours:       map[int]bool{},
		daysOfMonth: map[int]bool{},
		months:      map[time.Month]bool{},
		daysOfWeek:  map[int]bool{},
	}
	offset := 0
	if spec.hasSeconds {
		seconds, err := parseCronField(fields[0], 0, 59, nil)
		if err != nil {
			return cronSpec{}, false
		}
		spec.seconds = seconds
		offset = 1
	}
	minutes, err := parseCronField(fields[offset], 0, 59, nil)
	if err != nil {
		return cronSpec{}, false
	}
	hours, err := parseCronField(fields[offset+1], 0, 23, nil)
	if err != nil {
		return cronSpec{}, false
	}
	daysOfMonth, err := parseCronField(fields[offset+2], 1, 31, nil)
	if err != nil {
		return cronSpec{}, false
	}
	months, err := parseCronField(fields[offset+3], 1, 12, monthNames)
	if err != nil {
		return cronSpec{}, false
	}
	daysOfWeek, err := parseCronField(fields[offset+4], 0, 7, weekdayNames)
	if err != nil {
		return cronSpec{}, false
	}
	spec.minutes = minutes
	spec.hours = hours
	spec.daysOfMonth = daysOfMonth
	for value := range months {
		spec.months[time.Month(value)] = true
	}
	if daysOfWeek[7] {
		daysOfWeek[0] = true
	}
	delete(daysOfWeek, 7)
	spec.daysOfWeek = daysOfWeek
	spec.domStar = fields[offset+2] == "*" || fields[offset+2] == "?"
	spec.dowStar = fields[offset+4] == "*" || fields[offset+4] == "?"
	return spec, true
}

var monthNames = map[string]int{
	"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
	"jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}

var weekdayNames = map[string]int{
	"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6,
}

func parseCronField(raw string, min, max int, names map[string]int) (map[int]bool, error) {
	raw = strings.TrimSpace(strings.ToLower(raw))
	if raw == "" {
		return nil, errors.New("empty cron field")
	}
	if raw == "?" {
		raw = "*"
	}
	result := map[int]bool{}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			return nil, errors.New("empty cron list item")
		}
		step := 1
		if slash := strings.IndexByte(part, '/'); slash >= 0 {
			parsedStep, err := strconv.Atoi(part[slash+1:])
			if err != nil || parsedStep <= 0 {
				return nil, errors.New("invalid cron step")
			}
			step = parsedStep
			part = part[:slash]
		}
		start, end := min, max
		switch {
		case part == "*":
		case strings.Contains(part, "-"):
			bounds := strings.SplitN(part, "-", 2)
			parsedStart, err := cronValue(bounds[0], names)
			if err != nil {
				return nil, err
			}
			parsedEnd, err := cronValue(bounds[1], names)
			if err != nil {
				return nil, err
			}
			start, end = parsedStart, parsedEnd
		default:
			value, err := cronValue(part, names)
			if err != nil {
				return nil, err
			}
			start, end = value, value
		}
		if start < min || end > max || start > end {
			return nil, errors.New("cron value out of range")
		}
		for value := start; value <= end; value += step {
			result[value] = true
		}
	}
	if len(result) == 0 {
		return nil, errors.New("empty cron field")
	}
	return result, nil
}

func cronValue(raw string, names map[string]int) (int, error) {
	raw = strings.TrimSpace(raw)
	if names != nil {
		if value, ok := names[raw]; ok {
			return value, nil
		}
	}
	return strconv.Atoi(raw)
}
