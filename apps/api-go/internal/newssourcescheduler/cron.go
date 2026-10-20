// This file ports the cron engine used to compute a source's next run time. It
// reproduces cron-parser@4.9.0 (the version pinned in pnpm-lock.yaml) closely
// enough that an expression NestJS schedules with takes the same branch in Go:
//
//   - 1 to 6 fields are accepted. Missing leading fields take the parser
//     defaults ("0" for seconds, "*" for the rest), so a five-field expression
//     fixes seconds at 0 and a six-field expression adds an explicit seconds
//     field. More than six fields is an error.
//   - The predefined expressions are exactly @yearly, @monthly, @weekly, @daily
//     and @hourly. @annually and @midnight are NOT accepted (cron-parser 4.9.0
//     throws for them, so the scheduler must fall back to the interval plan).
//   - Lists, ranges, steps (*, a-b, */n, a-b/n, a/n), month names (JAN-DEC) and
//     day names (SUN-SAT) are parsed with the same expansion rules, including
//     the day-of-week quirks: single values are taken modulo 7, a range whose
//     maximum is a multiple of 7 also contributes 0, and "7" is therefore
//     equivalent to "0" only in the single-value form.
//   - '?' is replaced like '*' in day-of-month/day-of-week; the other fields
//     reject the character.
//   - 'L' in day-of-month is the last day of the month. In day-of-week "nL" is
//     the last n-weekday of the month; a bare 'L' is rejected because
//     cron-parser throws when it evaluates it ("Invalid last weekday of the
//     month expression").
//   - 'd#k' is the k-th d-weekday of the month (k in 1..5) and cannot be
//     combined with a list, range or step.
//   - Quartz-only syntax (W, LW, L-n, nW) is rejected: cron-parser 4.9.0 rejects
//     it too, and computeNextRunAt then falls back to the interval schedule.
//   - The Vixie day rule is reproduced exactly, including the value-count
//     "wildcard" detection cron-parser uses: day-of-month is a wildcard when its
//     parsed value count is at least the parser's days-in-month table entry
//     (February is 29 there), and day-of-week is a wildcard when its parsed
//     value count is exactly 8 (0..7). The parser keeps duplicates, so
//     "0,1,2,3,4,5,6,7" counts as 8 just like "*".
//   - The '#' occurrence check runs after the day rule, like cron-parser.
//
// Times are expanded as wall-clock values in the expression's location. A
// nonexistent spring-forward local time is shifted forward by the gap (Luxon's
// fixOffset behaviour, which cron-parser relies on); an ambiguous fall-back
// local time resolves with the pre-transition offset.
package newssourcescheduler

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	// cronMaxSearchYears bounds how far Next looks for an occurrence. It is the
	// cron-parser LOOP_LIMIT (10000 single-unit steps) expressed in years, so an
	// expression that only matches every eight years still resolves.
	cronMaxSearchYears = 27
	// cronMaxSearchIterations guards the jump-based search.
	cronMaxSearchIterations = 100000
)

// cronPredefined is CronExpression.predefined.
var cronPredefined = map[string]string{
	"@yearly":  "0 0 1 1 *",
	"@monthly": "0 0 1 * *",
	"@weekly":  "0 0 * * 0",
	"@daily":   "0 0 * * *",
	"@hourly":  "0 * * * *",
}

// cronParseDefaults is CronExpression.parseDefaults.
var cronParseDefaults = [6]string{"0", "*", "*", "*", "*", "*"}

var cronMonthNames = map[string]int{
	"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
	"JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}

var cronDayNames = map[string]int{
	"SUN": 0, "MON": 1, "TUE": 2, "WED": 3, "THU": 4, "FRI": 5, "SAT": 6,
}

// cronParserDaysInMonth is CronExpression.daysInMonth: February is 29 in this
// table regardless of the year, because it only feeds the wildcard heuristic.
var cronParserDaysInMonth = [12]int{31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}

var (
	cronStandardCharacters = regexp.MustCompile(`^[,*\d/-]+$`)
	cronDOMCharacters      = regexp.MustCompile(`^[?,*\dL/-]+$`)
	cronDOWCharacters      = regexp.MustCompile(`^[?,*\dL#/-]+$`)
	cronThreeLetters       = regexp.MustCompile(`[A-Za-z]{3}`)
)

type cronFieldKind int

const (
	cronSecond cronFieldKind = iota
	cronMinute
	cronHour
	cronDayOfMonth
	cronMonth
	cronDayOfWeek
)

func cronFieldBounds(kind cronFieldKind) (int, int) {
	switch kind {
	case cronSecond, cronMinute:
		return 0, 59
	case cronHour:
		return 0, 23
	case cronDayOfMonth:
		return 1, 31
	case cronMonth:
		return 1, 12
	case cronDayOfWeek:
		return 0, 7
	default:
		return 0, 0
	}
}

// cronExpression is a parsed cron expression. Instances are immutable after
// parsing and safe for concurrent use.
type cronExpression struct {
	expr string
	loc  *time.Location

	seconds []int
	minutes []int
	hours   []int

	months [13]bool

	domSet   [32]bool
	domCount int
	domHasL  bool

	dowSet          [7]bool
	dowLastWeekdays []int
	dowCount        int

	// nth is the k of a d#k expression (0 when absent).
	nth int
}

// parseCronExpression parses expr with cron-parser 4.9.0 semantics. loc is the
// timezone used for wall-clock expansion (nil means UTC).
func parseCronExpression(expr string, loc *time.Location) (*cronExpression, error) {
	if loc == nil {
		loc = time.UTC
	}
	trimmed := trimJS(expr)
	if predefined, ok := cronPredefined[trimmed]; ok {
		trimmed = predefined
	}
	if trimmed == "" {
		return nil, fmt.Errorf("cron: empty expression")
	}
	atoms := strings.Fields(trimmed)
	if len(atoms) > 6 {
		return nil, fmt.Errorf("cron: invalid cron expression %q (more than 6 fields)", expr)
	}

	start := 6 - len(atoms)
	values := [6]string{}
	for index := 0; index < 6; index++ {
		if index < start {
			values[index] = cronParseDefaults[index]
			continue
		}
		position := index - start
		if position >= len(atoms) || atoms[position] == "" {
			values[index] = cronParseDefaults[index]
			continue
		}
		values[index] = atoms[position]
	}

	// '#' is stripped from the day-of-week field before parsing and becomes the
	// expression-wide occurrence number.
	dowValue, nth, err := parseCronNthDay(values[5])
	if err != nil {
		return nil, err
	}

	secondField, err := parseCronField(values[0], cronSecond)
	if err != nil {
		return nil, fmt.Errorf("cron: invalid second field %q: %w", values[0], err)
	}
	minuteField, err := parseCronField(values[1], cronMinute)
	if err != nil {
		return nil, fmt.Errorf("cron: invalid minute field %q: %w", values[1], err)
	}
	hourField, err := parseCronField(values[2], cronHour)
	if err != nil {
		return nil, fmt.Errorf("cron: invalid hour field %q: %w", values[2], err)
	}
	domField, err := parseCronField(values[3], cronDayOfMonth)
	if err != nil {
		return nil, fmt.Errorf("cron: invalid day-of-month field %q: %w", values[3], err)
	}
	monthField, err := parseCronField(values[4], cronMonth)
	if err != nil {
		return nil, fmt.Errorf("cron: invalid month field %q: %w", values[4], err)
	}
	dowField, err := parseCronField(dowValue, cronDayOfWeek)
	if err != nil {
		return nil, fmt.Errorf("cron: invalid day-of-week field %q: %w", dowValue, err)
	}

	parsed := &cronExpression{
		expr:            trimmed,
		loc:             loc,
		seconds:         secondField.numbers,
		minutes:         minuteField.numbers,
		hours:           hourField.numbers,
		domCount:        domField.count,
		domHasL:         domField.hasL,
		dowLastWeekdays: dowField.lastWeekdays,
		dowCount:        dowField.count,
		nth:             nth,
	}
	for _, value := range domField.numbers {
		if value >= 1 && value <= 31 {
			parsed.domSet[value] = true
		}
	}
	for _, value := range monthField.numbers {
		if value >= 1 && value <= 12 {
			parsed.months[value] = true
		}
	}
	for _, value := range dowField.numbers {
		if value >= 0 && value <= 6 {
			parsed.dowSet[value] = true
		}
	}
	for _, weekday := range dowField.lastWeekdays {
		parsed.dowLastWeekdays = append(parsed.dowLastWeekdays, weekday%7)
	}
	return parsed, nil
}

// parseCronNthDay is parseNthDay.
func parseCronNthDay(value string) (string, int, error) {
	atoms := strings.Split(value, "#")
	if len(atoms) <= 1 {
		return value, 0, nil
	}
	if strings.Contains(value, ",") {
		return "", 0, fmt.Errorf("cron: day-of-week '#' cannot be combined with ','")
	}
	if strings.Contains(value, "/") {
		return "", 0, fmt.Errorf("cron: day-of-week '#' cannot be combined with '/'")
	}
	if strings.Contains(value, "-") {
		return "", 0, fmt.Errorf("cron: day-of-week '#' cannot be combined with '-'")
	}
	nth, err := strconv.Atoi(atoms[len(atoms)-1])
	if len(atoms) > 2 || err != nil || nth < 1 || nth > 5 {
		return "", 0, fmt.Errorf("cron: invalid day-of-week occurrence number (#)")
	}
	return atoms[0], nth, nil
}

// cronFieldResult is the interpreted field: the numeric values (duplicates and
// the range-produced 7 kept), the 'L' markers and the total parsed value count.
type cronFieldResult struct {
	numbers      []int
	hasL         bool
	lastWeekdays []int
	count        int
}

// parseCronField is CronExpression._parseField.
func parseCronField(raw string, kind cronFieldKind) (cronFieldResult, error) {
	value := raw
	if kind == cronMonth || kind == cronDayOfWeek {
		replaced, err := replaceCronAliases(value, kind)
		if err != nil {
			return cronFieldResult{}, err
		}
		value = replaced
	}
	switch kind {
	case cronDayOfMonth:
		if !cronDOMCharacters.MatchString(value) {
			return cronFieldResult{}, fmt.Errorf("invalid characters, got value %q", value)
		}
	case cronDayOfWeek:
		if !cronDOWCharacters.MatchString(value) {
			return cronFieldResult{}, fmt.Errorf("invalid characters, got value %q", value)
		}
	default:
		if !cronStandardCharacters.MatchString(value) {
			return cronFieldResult{}, fmt.Errorf("invalid characters, got value %q", value)
		}
	}

	min, max := cronFieldBounds(kind)
	if strings.Contains(value, "*") {
		value = strings.ReplaceAll(value, "*", strconv.Itoa(min)+"-"+strconv.Itoa(max))
	} else if strings.Contains(value, "?") {
		value = strings.ReplaceAll(value, "?", strconv.Itoa(min)+"-"+strconv.Itoa(max))
	}

	atoms := strings.Split(value, ",")
	for _, atom := range atoms {
		if atom == "" {
			return cronFieldResult{}, fmt.Errorf("invalid list value format")
		}
	}
	tokens := make([]cronToken, 0, len(atoms))
	for _, atom := range atoms {
		expanded, err := parseCronRepeat(atom, kind)
		if err != nil {
			return cronFieldResult{}, err
		}
		tokens = append(tokens, expanded...)
	}

	result := cronFieldResult{count: len(tokens)}
	for _, token := range tokens {
		if strings.Contains(token.text, "L") {
			if kind == cronDayOfMonth {
				if token.text != "L" {
					return cronFieldResult{}, fmt.Errorf("invalid day-of-month value %q", token.text)
				}
				result.hasL = true
				continue
			}
			if kind == cronDayOfWeek {
				weekday, err := parseCronLastWeekday(token.text)
				if err != nil {
					return cronFieldResult{}, err
				}
				result.lastWeekdays = append(result.lastWeekdays, weekday)
				continue
			}
			return cronFieldResult{}, fmt.Errorf("invalid value %q", token.text)
		}
		number, err := strconv.Atoi(token.text)
		if err != nil {
			return cronFieldResult{}, fmt.Errorf("constraint error, got value %q expected range %d-%d", token.text, min, max)
		}
		if number < min || number > max {
			return cronFieldResult{}, fmt.Errorf("constraint error, got value %d expected range %d-%d", number, min, max)
		}
		if kind == cronDayOfWeek && token.scalar {
			number %= 7
		}
		result.numbers = append(result.numbers, number)
	}
	if result.count == 0 {
		return cronFieldResult{}, fmt.Errorf("field contains no values")
	}
	return result, nil
}

// cronToken is one expanded field value. scalar marks values that went through
// the single-value path, which is the only path cron-parser takes modulo 7 for
// day-of-week.
type cronToken struct {
	text   string
	scalar bool
}

// replaceCronAliases is the value.replace(/[a-z]{3}/gi, …) step.
func replaceCronAliases(value string, kind cronFieldKind) (string, error) {
	matches := cronThreeLetters.FindAllStringIndex(value, -1)
	if len(matches) == 0 {
		return value, nil
	}
	var builder strings.Builder
	last := 0
	for _, match := range matches {
		builder.WriteString(value[last:match[0]])
		label := strings.ToUpper(value[match[0]:match[1]])
		number := 0
		found := false
		if kind == cronMonth {
			number, found = cronMonthNames[label]
		} else {
			number, found = cronDayNames[label]
		}
		if !found {
			return "", fmt.Errorf("cannot resolve alias %q", label)
		}
		builder.WriteString(strconv.Itoa(number))
		last = match[1]
	}
	builder.WriteString(value[last:])
	return builder.String(), nil
}

// parseCronRepeat is parseRepeat.
func parseCronRepeat(value string, kind cronFieldKind) ([]cronToken, error) {
	atoms := strings.Split(value, "/")
	if len(atoms) > 2 {
		return nil, fmt.Errorf("invalid repeat: %q", value)
	}
	if len(atoms) > 1 {
		if isCronNumber(atoms[0]) {
			_, max := cronFieldBounds(kind)
			atoms[0] = atoms[0] + "-" + strconv.Itoa(max)
		}
		return parseCronRange(atoms[0], atoms[1], kind)
	}
	return parseCronRange(value, "1", kind)
}

// parseCronRange is parseRange.
func parseCronRange(value, repeatText string, kind cronFieldKind) ([]cronToken, error) {
	atoms := strings.Split(value, "-")
	min, max := cronFieldBounds(kind)
	if len(atoms) > 1 {
		if atoms[0] == "" {
			if atoms[1] == "" {
				return nil, fmt.Errorf("invalid range: %q", value)
			}
			return nil, fmt.Errorf("constraint error, got range %q expected range %d-%d", value, min, max)
		}
		rangeMin, minErr := strconv.Atoi(atoms[0])
		rangeMax, maxErr := strconv.Atoi(atoms[1])
		if minErr != nil || maxErr != nil || rangeMin < min || rangeMax > max {
			return nil, fmt.Errorf("constraint error, got range %q expected range %d-%d", value, min, max)
		}
		if rangeMin > rangeMax {
			return nil, fmt.Errorf("invalid range: %q", value)
		}
		repeat, repeatErr := strconv.Atoi(repeatText)
		if repeatErr != nil || repeat <= 0 {
			return nil, fmt.Errorf("constraint error, cannot repeat at every %q time", repeatText)
		}
		tokens := []cronToken{}
		if kind == cronDayOfWeek && rangeMax%7 == 0 {
			tokens = append(tokens, cronToken{text: "0"})
		}
		repeatIndex := repeat
		for index := rangeMin; index <= rangeMax; index++ {
			exists := false
			for _, token := range tokens {
				if token.text == strconv.Itoa(index) {
					exists = true
					break
				}
			}
			if !exists && repeatIndex > 0 && repeatIndex%repeat == 0 {
				repeatIndex = 1
				tokens = append(tokens, cronToken{text: strconv.Itoa(index)})
				continue
			}
			repeatIndex++
		}
		return tokens, nil
	}
	if isCronNumber(value) {
		return []cronToken{{text: value, scalar: true}}, nil
	}
	if strings.Contains(value, "L") {
		// The token is validated by the caller: bare L for day-of-month and nL
		// for day-of-week.
		return []cronToken{{text: value}}, nil
	}
	return nil, fmt.Errorf("constraint error, got value %q expected range %d-%d", value, min, max)
}

// parseCronLastWeekday validates an nL token and returns the weekday prefix.
func parseCronLastWeekday(value string) (int, error) {
	prefix := strings.TrimSuffix(value, "L")
	if prefix == "" || !isCronNumber(prefix) {
		return 0, fmt.Errorf("invalid last weekday of the month expression: %q", value)
	}
	number, err := strconv.Atoi(prefix)
	if err != nil || number < 0 || number > 7 {
		return 0, fmt.Errorf("invalid last weekday of the month expression: %q", value)
	}
	return number, nil
}

// isCronNumber reports whether the value is entirely ASCII digits.
func isCronNumber(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// Next returns the first occurrence strictly after `after`, expressed in the
// expression's location (zero nanoseconds).
func (e *cronExpression) Next(after time.Time) (time.Time, error) {
	if e == nil || e.loc == nil {
		return time.Time{}, fmt.Errorf("cron: cannot compute the next time of an uninitialized expression")
	}
	after = after.In(e.loc)
	start := after.Truncate(time.Second).Add(time.Second)
	year, month, day := start.Date()
	hour, minute, second := start.Clock()
	startYear := year

	for iterations := 0; iterations < cronMaxSearchIterations; iterations++ {
		if year > startYear+cronMaxSearchYears {
			return time.Time{}, fmt.Errorf(
				"cron: expression %q has no matching time within %d years after %s",
				e.expr, cronMaxSearchYears, after.Format(time.RFC3339))
		}
		if !e.months[int(month)] {
			year, month = nextCronMonth(year, month)
			day, hour, minute, second = 1, 0, 0, 0
			continue
		}
		if !e.dayMatches(year, month, day) {
			year, month, day, hour, minute, second = nextCronDay(year, month, day)
			continue
		}
		nextHour, nextMinute, nextSecond, ok := e.nextTimeOfDay(hour, minute, second)
		if !ok {
			year, month, day, hour, minute, second = nextCronDay(year, month, day)
			continue
		}
		hour, minute, second = nextHour, nextMinute, nextSecond

		candidate := resolveCronWallClock(year, month, day, hour, minute, second, e.loc)
		if candidate.After(after) {
			return candidate, nil
		}
		// A fall-back overlap can map a later wall-clock value to an instant at
		// or before `after`; advance one wall-clock second and retry.
		year, month, day, hour, minute, second = nextCronSecond(year, month, day, hour, minute, second)
	}
	return time.Time{}, fmt.Errorf("cron: expression %q exceeded %d search steps after %s",
		e.expr, cronMaxSearchIterations, after.Format(time.RFC3339))
}

// dayMatches reproduces the day-of-month/day-of-week block of _findSchedule.
func (e *cronExpression) dayMatches(year int, month time.Month, day int) bool {
	realDays := cronDaysInMonth(year, month)
	domMatch := e.domSet[day] || (e.domHasL && day == realDays)
	weekday := int(time.Date(year, month, day, 12, 0, 0, 0, time.UTC).Weekday())
	dowMatch := e.dowSet[weekday]
	if !dowMatch && len(e.dowLastWeekdays) > 0 {
		for _, candidate := range e.dowLastWeekdays {
			if candidate == weekday && day+7 > realDays {
				dowMatch = true
				break
			}
		}
	}
	domWildcard := e.domCount >= cronParserDaysInMonth[int(month)-1]
	dowWildcard := e.dowCount == 8

	if !domMatch && (!dowMatch || dowWildcard) {
		return false
	}
	if !domWildcard && dowWildcard && !domMatch {
		return false
	}
	if domWildcard && !dowWildcard && !dowMatch {
		return false
	}
	if e.nth > 0 && !isNthCronDayMatch(day, e.nth) {
		return false
	}
	return true
}

// isNthCronDayMatch is isNthDayMatch.
func isNthCronDayMatch(day, nth int) bool {
	if nth >= 6 {
		return false
	}
	if day < 8 && nth == 1 {
		return true
	}
	offset := 0
	if day%7 != 0 {
		offset = 1
	}
	adjusted := day - day%7
	occurrence := adjusted/7 + offset
	return occurrence == nth
}

// nextTimeOfDay returns the earliest allowed (hour, minute, second) that is
// greater than or equal to the given wall-clock time of day.
func (e *cronExpression) nextTimeOfDay(hour, minute, second int) (int, int, int, bool) {
	nextHour, ok := nextCronAtLeast(e.hours, hour)
	if !ok {
		return 0, 0, 0, false
	}
	if nextHour > hour {
		return nextHour, e.minutes[0], e.seconds[0], true
	}
	nextMinute, ok := nextCronAtLeast(e.minutes, minute)
	if !ok {
		nextHour, ok = nextCronAtLeast(e.hours, hour+1)
		if !ok {
			return 0, 0, 0, false
		}
		return nextHour, e.minutes[0], e.seconds[0], true
	}
	if nextMinute > minute {
		return hour, nextMinute, e.seconds[0], true
	}
	nextSecond, ok := nextCronAtLeast(e.seconds, second)
	if ok {
		return hour, minute, nextSecond, true
	}
	nextMinute, ok = nextCronAtLeast(e.minutes, minute+1)
	if !ok {
		nextHour, ok = nextCronAtLeast(e.hours, hour+1)
		if !ok {
			return 0, 0, 0, false
		}
		return nextHour, e.minutes[0], e.seconds[0], true
	}
	return hour, nextMinute, e.seconds[0], true
}

func nextCronAtLeast(values []int, at int) (int, bool) {
	for _, value := range values {
		if value >= at {
			return value, true
		}
	}
	return 0, false
}

func nextCronMonth(year int, month time.Month) (int, time.Month) {
	month++
	if month > time.December {
		month = time.January
		year++
	}
	return year, month
}

func nextCronDay(year int, month time.Month, day int) (int, time.Month, int, int, int, int) {
	day++
	if day > cronDaysInMonth(year, month) {
		day = 1
		year, month = nextCronMonth(year, month)
	}
	return year, month, day, 0, 0, 0
}

func nextCronSecond(year int, month time.Month, day, hour, minute, second int) (int, time.Month, int, int, int, int) {
	second++
	if second < 60 {
		return year, month, day, hour, minute, second
	}
	second = 0
	minute++
	if minute < 60 {
		return year, month, day, hour, minute, second
	}
	minute = 0
	hour++
	if hour < 24 {
		return year, month, day, hour, minute, second
	}
	hour = 0
	day++
	if day > cronDaysInMonth(year, month) {
		day = 1
		year, month = nextCronMonth(year, month)
	}
	return year, month, day, hour, minute, second
}

func cronDaysInMonth(year int, month time.Month) int {
	return time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

// resolveCronWallClock converts wall-clock components in loc to an instant.
func resolveCronWallClock(year int, month time.Month, day, hour, minute, second int, loc *time.Location) time.Time {
	candidate := time.Date(year, month, day, hour, minute, second, 0, loc)
	if candidate.Year() == year && candidate.Month() == month && candidate.Day() == day &&
		candidate.Hour() == hour && candidate.Minute() == minute && candidate.Second() == second {
		return candidate
	}
	return resolveCronGap(year, month, day, hour, minute, second, loc)
}

// resolveCronGap mirrors Luxon's fixOffset for a nonexistent local time: the
// wall time shifts forward by the DST gap, which is what cron-parser produces.
func resolveCronGap(year int, month time.Month, day, hour, minute, second int, loc *time.Location) time.Time {
	wall := time.Date(year, month, day, hour, minute, second, 0, time.UTC)
	offset := cronZoneOffset(loc, wall)

	guess := wall.Add(-time.Duration(offset) * time.Second)
	nextOffset := cronZoneOffset(loc, guess)
	if offset == nextOffset {
		return guess.In(loc)
	}
	guess = guess.Add(-time.Duration(nextOffset-offset) * time.Second)
	finalOffset := cronZoneOffset(loc, guess)
	if nextOffset == finalOffset {
		return guess.In(loc)
	}
	minOffset := nextOffset
	if finalOffset < minOffset {
		minOffset = finalOffset
	}
	return wall.Add(-time.Duration(minOffset) * time.Second).In(loc)
}

func cronZoneOffset(loc *time.Location, instant time.Time) int {
	_, offset := instant.In(loc).Zone()
	return offset
}
