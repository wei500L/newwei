package economic

import (
	"encoding/base64"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

const (
	granularityRealtime = "realtime"
	granularityMinute   = "minute"
	granularityHour     = "hour"
	granularityDay      = "day"
	granularityWeek     = "week"
	granularityMonth    = "month"
	granularityQuarter  = "quarter"
	granularityYear     = "year"

	frequencyRealtime = "realtime"
	frequencyHourly   = "hourly"
	frequencyDaily    = "daily"
	frequencyWeekly   = "weekly"
	frequencyMonthly  = "monthly"

	valueTypePercent = "percent"
	valueTypeYield   = "yield"

	modeRealtime = "realtime"
	modeRate     = "rate"
	modeOpen     = "ohlc-open"
	modeHigh     = "ohlc-high"
	modeLow      = "ohlc-low"
	modeClose    = "ohlc-close"
	modeMean     = "mean"
)

// granularityForRange is EconomicDataResolver.resolveDefaultGranularityForRange.
// It is used only when getEconomicData and getEconomicDataWithInsights omit granularity.
func granularityForRange(start, end time.Time) string {
	diffMs := end.UnixMilli() - start.UnixMilli()
	if diffMs < 0 {
		diffMs = 0
	}
	const (
		millisPerMinute int64 = 60 * 1000
		millisPerHour         = 60 * millisPerMinute
		millisPerDay          = 24 * millisPerHour
	)
	if diffMs <= 6*millisPerHour {
		return granularityMinute
	}
	if diffMs <= 2*millisPerDay {
		return granularityHour
	}
	diffDays := int64(math.Round(float64(diffMs) / float64(millisPerDay)))
	if diffDays < 1 {
		diffDays = 1
	}
	switch {
	case diffDays > 1095:
		return granularityYear
	case diffDays > 365:
		return granularityQuarter
	case diffDays > 120:
		return granularityMonth
	case diffDays > 45:
		return granularityWeek
	default:
		return granularityDay
	}
}

func granularityRank(granularity string) int {
	switch granularity {
	case granularityRealtime:
		return 0
	case granularityMinute:
		return 1
	case granularityHour:
		return 2
	case granularityDay:
		return 3
	case granularityWeek:
		return 4
	case granularityMonth:
		return 5
	case granularityQuarter:
		return 6
	case granularityYear:
		return 7
	default:
		return 99
	}
}

func frequencyToGranularity(frequency string) string {
	switch frequency {
	case frequencyRealtime:
		return granularityRealtime
	case frequencyHourly:
		return granularityHour
	case frequencyWeekly:
		return granularityWeek
	case frequencyMonthly:
		return granularityMonth
	case frequencyDaily:
		return granularityDay
	default:
		return granularityDay
	}
}

func coarsest(a, b string) string {
	if granularityRank(a) >= granularityRank(b) {
		return a
	}
	return b
}

// resolveEffectiveGranularity is the resolver helper. An empty requested
// granularity leaves the item frequency (daily when the frequency is unknown).
func resolveEffectiveGranularity(requested, frequency string) string {
	base := frequencyToGranularity(frequency)
	if requested == "" {
		return base
	}
	return coarsest(requested, base)
}

func bucketTimestamp(ts time.Time, granularity string) time.Time {
	t := ts.UTC()
	switch granularity {
	case granularityRealtime:
		return time.UnixMilli(t.UnixMilli()).UTC()
	case granularityMinute:
		return time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), 0, 0, time.UTC)
	case granularityHour:
		return time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), 0, 0, 0, time.UTC)
	case granularityYear:
		return time.Date(t.Year(), time.January, 1, 0, 0, 0, 0, time.UTC)
	case granularityQuarter:
		month := time.Month(((int(t.Month())-1)/3)*3 + 1)
		return time.Date(t.Year(), month, 1, 0, 0, 0, 0, time.UTC)
	case granularityMonth:
		return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
	case granularityWeek:
		delta := int(t.Weekday())
		if delta == 0 {
			delta = 6
		} else {
			delta--
		}
		monday := t.AddDate(0, 0, -delta)
		return time.Date(monday.Year(), monday.Month(), monday.Day(), 0, 0, 0, 0, time.UTC)
	default:
		return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	}
}

func addInterval(start time.Time, granularity string) time.Time {
	base := start.UTC()
	switch granularity {
	case granularityMinute:
		return base.Add(time.Minute)
	case granularityHour:
		return base.Add(time.Hour)
	case granularityDay:
		return base.Add(24 * time.Hour)
	case granularityWeek:
		return base.Add(7 * 24 * time.Hour)
	case granularityMonth:
		return time.Date(base.Year(), base.Month()+1, base.Day(), base.Hour(), base.Minute(), base.Second(), base.Nanosecond(), time.UTC)
	case granularityQuarter:
		return time.Date(base.Year(), base.Month()+3, base.Day(), base.Hour(), base.Minute(), base.Second(), base.Nanosecond(), time.UTC)
	case granularityYear:
		return time.Date(base.Year()+1, base.Month(), base.Day(), base.Hour(), base.Minute(), base.Second(), base.Nanosecond(), time.UTC)
	default:
		return base
	}
}

func alignRange(start, end time.Time, granularity string) (time.Time, time.Time) {
	if granularity == granularityRealtime {
		return start.UTC(), end.UTC()
	}
	normalizedStart := bucketTimestamp(start, granularity)
	endBucket := bucketTimestamp(end, granularity)
	next := addInterval(endBucket, granularity)
	return normalizedStart, next.Add(-time.Millisecond)
}

func bucketMode(point dataPoint) string {
	if point.item.defaultFrequency == frequencyRealtime {
		return modeRealtime
	}
	if point.dataType == valueTypePercent || point.dataType == valueTypeYield {
		return modeRate
	}
	source := ""
	if point.sourceField.Valid {
		source = point.sourceField.String
	}
	switch source {
	case "open":
		return modeOpen
	case "high":
		return modeHigh
	case "low":
		return modeLow
	case "close":
		return modeClose
	default:
		return modeMean
	}
}

// bucketPoints aggregates per itemId + sourceField at coarsest(requested, item frequency).
// realtime and percent/yield keep the last value; OHLC uses first/max/min/last; everything else uses the mean.
// The result is ordered by bucket time, with equal times left in first-seen order.
func bucketPoints(points []dataPoint, requested string) []dataPoint {
	type accumulator struct {
		timestamp time.Time
		count     int
		first     float64
		max       float64
		min       float64
		sum       float64
		sample    dataPoint
		mode      string
	}
	order := make([]string, 0)
	grouped := make(map[string]*accumulator)
	for _, point := range points {
		seriesGranularity := coarsest(requested, frequencyToGranularity(point.item.defaultFrequency))
		bucketAt := bucketTimestamp(point.recordedAt, seriesGranularity)
		sourceKey := ""
		if point.sourceField.Valid {
			sourceKey = point.sourceField.String
		}
		key := point.itemID + "::" + sourceKey + "::" + contract.FormatDateTime(bucketAt)
		existing := grouped[key]
		if existing != nil {
			existing.count++
			existing.sum += point.value
			if point.value > existing.max {
				existing.max = point.value
			}
			if point.value < existing.min {
				existing.min = point.value
			}
			if point.recordedAt.UnixMilli() >= existing.sample.recordedAt.UnixMilli() {
				existing.sample = point
			}
			continue
		}
		grouped[key] = &accumulator{
			timestamp: bucketAt,
			count:     1,
			first:     point.value,
			max:       point.value,
			min:       point.value,
			sum:       point.value,
			sample:    point,
			mode:      bucketMode(point),
		}
		order = append(order, key)
	}
	out := make([]dataPoint, 0, len(order))
	for _, key := range order {
		entry := grouped[key]
		value := entry.sum / float64(max(entry.count, 1))
		switch entry.mode {
		case modeRealtime, modeRate, modeClose:
			value = entry.sample.value
		case modeOpen:
			value = entry.first
		case modeHigh:
			value = entry.max
		case modeLow:
			value = entry.min
		}
		aggregated := entry.sample
		aggregated.recordedAt = entry.timestamp
		aggregated.value = value
		out = append(out, aggregated)
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].recordedAt.UnixMilli() < out[j].recordedAt.UnixMilli()
	})
	return out
}

type pageCursor struct {
	recordedAt time.Time
	id         string
}

func encodeCursor(recordedAt time.Time, id string) string {
	payload := contract.FormatDateTime(recordedAt) + "|" + id
	return base64.RawURLEncoding.EncodeToString([]byte(payload))
}

// decodeCursor matches AkshareService.decodeCursor. Bad input returns ok=false.
// The caller ignores that and serves the first page; it is not a GraphQL error.
func decodeCursor(cursor string) (pageCursor, bool) {
	if cursor == "" {
		return pageCursor{}, false
	}
	payload, err := decodeBase64URL(cursor)
	if err != nil {
		return pageCursor{}, false
	}
	text := string(payload)
	separator := strings.IndexByte(text, '|')
	if separator < 0 {
		return pageCursor{}, false
	}
	id := text[separator+1:]
	if id == "" {
		return pageCursor{}, false
	}
	recordedAt, ok := parseDateTime(text[:separator])
	if !ok {
		return pageCursor{}, false
	}
	return pageCursor{recordedAt: recordedAt, id: id}, true
}

func decodeBase64URL(value string) ([]byte, error) {
	if decoded, err := base64.RawURLEncoding.DecodeString(value); err == nil {
		return decoded, nil
	}
	if decoded, err := base64.URLEncoding.DecodeString(value); err == nil {
		return decoded, nil
	}
	padded := value
	if rest := len(padded) % 4; rest != 0 {
		padded += strings.Repeat("=", 4-rest)
	}
	return base64.URLEncoding.DecodeString(padded)
}
