package economic

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	anomalyZScore         = 2.5
	trendPercentChange    = 5
	volatilityCoefficient = 0.2
	minSampleCount        = 5
	messageDecimals       = 1
)

type seriesPoint struct {
	recordedAt  time.Time
	value       float64
	unit        *string
	sourceField *string
	slug        string
	defaultUnit *string
}

func insightsFromDataPoints(points []dataPoint) []EconomicSeriesInsightModel {
	inputs := make([]seriesPoint, 0, len(points))
	for _, point := range points {
		input := seriesPoint{
			recordedAt: point.recordedAt,
			value:      point.value,
			slug:       point.item.slug,
		}
		if point.unit.Valid {
			input.unit = stringPtr(point.unit.String)
		}
		if point.sourceField.Valid {
			input.sourceField = stringPtr(point.sourceField.String)
		}
		if point.item.defaultUnit.Valid {
			input.defaultUnit = stringPtr(point.item.defaultUnit.String)
		}
		inputs = append(inputs, input)
	}
	return computeEconomicSeriesInsights(inputs)
}

func computeEconomicSeriesInsights(points []seriesPoint) []EconomicSeriesInsightModel {
	type group struct {
		itemSlug    string
		sourceField *string
		seriesKey   string
		defaultUnit *string
		points      []seriesPoint
	}
	order := make([]string, 0)
	groups := map[string]*group{}
	for _, point := range points {
		slug := strings.TrimSpace(point.slug)
		if slug == "" {
			continue
		}
		var sourceField *string
		seriesKey := slug + "-default"
		if point.sourceField != nil {
			trimmed := strings.TrimSpace(*point.sourceField)
			sourceField = stringPtr(trimmed)
			seriesKey = trimmed
		}
		mapKey := slug + "::" + seriesKey
		entry := groups[mapKey]
		if entry == nil {
			var defaultUnit *string
			if point.defaultUnit != nil {
				defaultUnit = stringPtr(*point.defaultUnit)
			}
			entry = &group{
				itemSlug:    slug,
				sourceField: sourceField,
				seriesKey:   seriesKey,
				defaultUnit: defaultUnit,
			}
			groups[mapKey] = entry
			order = append(order, mapKey)
		}
		entry.points = append(entry.points, point)
	}
	results := make([]EconomicSeriesInsightModel, 0, len(order))
	for _, key := range order {
		entry := groups[key]
		insight := computeSeriesInsight(entry.points)
		insight.ItemSlug = entry.itemSlug
		insight.SeriesKey = entry.seriesKey
		insight.SourceField = entry.sourceField
		insight.Unit = resolveUnit(entry.points, entry.defaultUnit)
		results = append(results, insight)
	}
	sort.SliceStable(results, func(i, j int) bool {
		if results[i].ItemSlug != results[j].ItemSlug {
			return results[i].ItemSlug < results[j].ItemSlug
		}
		return results[i].SeriesKey < results[j].SeriesKey
	})
	return results
}

func resolveUnit(points []seriesPoint, defaultUnit *string) *string {
	var current *string
	if defaultUnit != nil {
		current = stringPtr(*defaultUnit)
	}
	for _, point := range points {
		unit := ""
		if point.unit != nil {
			unit = strings.TrimSpace(*point.unit)
		}
		if unit == "" {
			continue
		}
		if current == nil || unit != *current {
			current = stringPtr(unit)
		}
	}
	return current
}

func computeSeriesInsight(input []seriesPoint) EconomicSeriesInsightModel {
	ordered := append([]seriesPoint(nil), input...)
	sort.SliceStable(ordered, func(i, j int) bool {
		return ordered[i].recordedAt.UnixMilli() < ordered[j].recordedAt.UnixMilli()
	})
	valid := make([]seriesPoint, 0, len(ordered))
	for _, point := range ordered {
		if math.IsNaN(point.value) || math.IsInf(point.value, 0) {
			continue
		}
		valid = append(valid, point)
	}
	sampleCount := len(valid)
	if sampleCount < 2 {
		insight := EconomicSeriesInsightModel{
			SampleCount:    sampleCount,
			Direction:      "flat",
			Classification: "insufficient_data",
			Message:        "Not enough data to infer a trend.",
		}
		if sampleCount == 1 {
			insight.CurrentValue = floatPtr(valid[0].value)
			insight.Mean = floatPtr(valid[0].value)
			insight.StdDev = floatPtr(0)
		}
		return insight
	}

	current := valid[len(valid)-1].value
	previous := valid[len(valid)-2].value
	change := current - previous
	var percent *float64
	if previous != 0 {
		value := (change / previous) * 100
		percent = &value
	}
	values := make([]float64, len(valid))
	for i, point := range valid {
		values[i] = point.value
	}
	meanValue := meanOf(values)
	stdValue := stdDevOf(values, meanValue)
	var z *float64
	if stdValue > 0 {
		value := (current - meanValue) / stdValue
		z = &value
	}
	direction := resolveDirection(change, percent)
	var coefficient *float64
	if meanValue != 0 {
		value := math.Abs(stdValue / meanValue)
		coefficient = &value
	}
	classification := "stable"
	if sampleCount >= minSampleCount && z != nil && math.Abs(*z) >= anomalyZScore {
		classification = "anomaly"
	} else if percent != nil && math.Abs(*percent) >= trendPercentChange {
		classification = "trend"
	} else if sampleCount >= minSampleCount && coefficient != nil && *coefficient >= volatilityCoefficient {
		classification = "volatility"
	}
	return EconomicSeriesInsightModel{
		SampleCount:    sampleCount,
		CurrentValue:   floatPtr(current),
		PreviousValue:  floatPtr(previous),
		Change:         floatPtr(change),
		PercentChange:  percent,
		Mean:           floatPtr(meanValue),
		StdDev:         floatPtr(stdValue),
		ZScore:         z,
		Direction:      direction,
		Classification: classification,
		Message:        insightMessage(classification, direction, percent, z, coefficient),
	}
}

func meanOf(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sum := 0.0
	for _, value := range values {
		sum += value
	}
	return sum / float64(len(values))
}

func stdDevOf(values []float64, mean float64) float64 {
	if len(values) == 0 {
		return 0
	}
	variance := 0.0
	for _, value := range values {
		delta := value - mean
		variance += delta * delta
	}
	variance /= float64(len(values))
	return math.Sqrt(variance)
}

func resolveDirection(change float64, percent *float64) string {
	basis := change
	if percent != nil {
		basis = *percent
	}
	switch {
	case basis > 0:
		return "up"
	case basis < 0:
		return "down"
	default:
		return "flat"
	}
}

func insightMessage(classification, direction string, percent, z, coefficient *float64) string {
	switch classification {
	case "anomaly":
		if z == nil {
			return "Latest value deviates materially from the series mean."
		}
		place := "below"
		if *z > 0 {
			place = "above"
		}
		return fmt.Sprintf("Latest value is %s sigma %s the series mean.", toFixedSafe(math.Abs(*z), messageDecimals), place)
	case "trend":
		if percent == nil {
			switch direction {
			case "up":
				return "Latest value increased vs previous point."
			case "down":
				return "Latest value decreased vs previous point."
			default:
				return "Latest value is unchanged vs previous point."
			}
		}
		word := "down"
		if direction == "up" {
			word = "up"
		}
		return fmt.Sprintf("Latest value changed %s%% %s vs previous point.", toFixedSafe(math.Abs(*percent), messageDecimals), word)
	case "volatility":
		if coefficient == nil {
			return "Series volatility is elevated."
		}
		return fmt.Sprintf("Series volatility is elevated (CV %s).", toFixedSafe(*coefficient, messageDecimals))
	case "stable":
		return "Series is stable around its recent mean."
	default:
		return "Not enough data to infer a trend."
	}
}

func toFixedSafe(value float64, decimals int) string {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return "0"
	}
	if decimals < 0 {
		decimals = 0
	}
	if decimals > 6 {
		decimals = 6
	}
	return strconv.FormatFloat(value, 'f', decimals, 64)
}
