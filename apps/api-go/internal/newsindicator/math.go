// Package newsindicator 翻译 NestJS apps/api 的新闻指标关联分析：
// 皮尔逊相关、滞后搜索、Z-score 回测，以及 3 条 HTTP 与 2 个 GraphQL
// 只读 query。数值路径逐段对齐 apps/api/src/modules/news-indicator/
// news-indicator-math.ts；不在本包内调用 AkShare，也不外网拉经济数据。
package newsindicator

import (
	"math"
	"time"
)

const dayMs = 24 * 60 * 60 * 1000

// DailySeries 是「UTC 整日 -> 数值」的序列（对应 TS 的 Map<number, number>）。
type DailySeries = map[int64]float64

// CorrelationResult 与 TS 的 CorrelationResult 一致。
type CorrelationResult struct {
	LagDays     int
	Correlation float64
	PValue      float64
	SampleSize  int
}

// BacktestConfig 与 TS 的 BacktestConfig 一致。
type BacktestConfig struct {
	TriggerZScore              float64
	BaselineDays               int
	HoldoutDays                int
	EvaluationTargetStartDayMs int64
	EvaluationTargetEndDayMs   int64
}

// BacktestMetrics 与 TS 的 BacktestMetrics 一致。字段名保持 TS 拼写，供
// refresh 直接写回 JSON 列。
type BacktestMetrics struct {
	Samples           int     `json:"samples"`
	Triggers          int     `json:"triggers"`
	EvaluatedSignals  int     `json:"evaluatedSignals"`
	Hits              int     `json:"hits"`
	HitRate           float64 `json:"hitRate"`
	AvgSignedReturn   float64 `json:"avgSignedReturn"`
	TotalSignedReturn float64 `json:"totalSignedReturn"`
	BaselineDays      int     `json:"baselineDays"`
}

// NumericSeriesPoint 是 EconomicDataPoint 的一行（recordedAt 用真实时间）。
type NumericSeriesPoint struct {
	ID         string
	RecordedAt time.Time
	Value      float64
}

// LagSearchOptions 对应 TS computeBestLagCorrelation 的 options。
type LagSearchOptions struct {
	MaxLagDays              int
	MinSampleSize           int
	MaxTargetDayMsExclusive int64
	HasMaxTargetDayMs       bool
}

// AssociationRef 对应 TS runBacktest 的 association 参数。
type AssociationRef struct {
	LagDays     int
	Correlation float64
}

// ToUtcDayStartMs 是 TS toUtcDayStartMs：取 UTC 当日 00:00:00.000。
func ToUtcDayStartMs(value time.Time) int64 {
	utc := value.UTC()
	return time.Date(utc.Year(), utc.Month(), utc.Day(), 0, 0, 0, 0, time.UTC).UnixMilli()
}

func clampFloat(value, min, max float64) float64 {
	if !isFinite(value) {
		return min
	}
	return math.Min(math.Max(value, min), max)
}

func isFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func normalCDF(x float64) float64 {
	const (
		a1 = 0.254829592
		a2 = -0.284496736
		a3 = 1.421413741
		a4 = -1.453152027
		a5 = 1.061405429
		p  = 0.3275911
	)

	sign := 1.0
	if x < 0 {
		sign = -1
	}
	scaled := math.Abs(x) / math.Sqrt(2)
	t := 1.0 / (1.0 + p*scaled)
	y := 1.0 - ((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*math.Exp(-scaled*scaled)
	return 0.5 * (1.0 + sign*y)
}

func approximatePValue(tStatistic float64, df int) float64 {
	if df > 30 {
		return 2 * (1 - normalCDF(tStatistic))
	}
	x := float64(df) / (float64(df) + tStatistic*tStatistic)
	return x
}

func pearsonCorrelation(x, y []float64) (correlation, pValue float64) {
	n := len(x)
	if len(y) < n {
		n = len(y)
	}
	if n < 2 {
		return 0, 1
	}

	// 与 TS 一致：均值是对全部元素求和后除以 n（对齐后 x/y 等长，通常
	// 等价；此处保留 TS 的精确写法）。
	sumXAll := 0.0
	for _, v := range x {
		sumXAll += v
	}
	sumYAll := 0.0
	for _, v := range y {
		sumYAll += v
	}
	muX := sumXAll / float64(n)
	muY := sumYAll / float64(n)

	sumXY := 0.0
	sumX2 := 0.0
	sumY2 := 0.0
	for i := 0; i < n; i++ {
		dx := x[i] - muX
		dy := y[i] - muY
		sumXY += dx * dy
		sumX2 += dx * dx
		sumY2 += dy * dy
	}

	if sumX2 == 0 || sumY2 == 0 {
		return 0, 1
	}

	correlation = sumXY / math.Sqrt(sumX2*sumY2)
	clamped := clampFloat(correlation, -0.999999, 0.999999)
	tStatistic := math.Abs(clamped) * math.Sqrt(float64(n-2)/(1-clamped*clamped))
	return clamped, approximatePValue(tStatistic, n-2)
}

// BuildDailyEconomicValues 与 TS buildDailyEconomicValues 一致：同一 UTC 日
// 取 recordedAt 最大、再按 id 字典序最大的点；非有限值跳过。
func BuildDailyEconomicValues(points []NumericSeriesPoint) DailySeries {
	type record struct {
		recordedAt int64
		value      float64
		id         string
	}
	byDay := map[int64]record{}

	for _, point := range points {
		dayKey := ToUtcDayStartMs(point.RecordedAt)
		value := point.Value
		if !isFinite(value) {
			continue
		}

		recordedAt := point.RecordedAt.UnixMilli()
		existing, ok := byDay[dayKey]
		if !ok {
			byDay[dayKey] = record{recordedAt: recordedAt, value: value, id: point.ID}
			continue
		}
		if recordedAt > existing.recordedAt {
			byDay[dayKey] = record{recordedAt: recordedAt, value: value, id: point.ID}
			continue
		}
		if recordedAt == existing.recordedAt && point.ID > existing.id {
			byDay[dayKey] = record{recordedAt: recordedAt, value: value, id: point.ID}
		}
	}

	series := make(DailySeries, len(byDay))
	for dayKey, item := range byDay {
		series[dayKey] = item.value
	}
	return series
}

// BuildDailyReturns 与 TS buildDailyReturns 一致。
func BuildDailyReturns(valuesByDay DailySeries) DailySeries {
	keys := sortedKeys(valuesByDay)
	returns := make(DailySeries, len(keys))
	for i := 1; i < len(keys); i++ {
		day := keys[i]
		prevDay := keys[i-1]
		prevValue, okPrev := valuesByDay[prevDay]
		value, okValue := valuesByDay[day]
		if !okPrev || !okValue {
			continue
		}
		diff := value - prevValue
		pct := diff
		if prevValue != 0 {
			pct = diff / math.Abs(prevValue)
		}
		if !isFinite(pct) {
			continue
		}
		returns[day] = pct
	}
	return returns
}

// ComputeBestLagCorrelation 与 TS computeBestLagCorrelation 一致。
func ComputeBestLagCorrelation(
	feature DailySeries,
	targetReturns DailySeries,
	options LagSearchOptions,
) (best *CorrelationResult, all []CorrelationResult) {
	maxLagDays := clampIntTrunc(options.MaxLagDays, 0, 30)
	minSampleSize := clampIntTrunc(options.MinSampleSize, 2, 10_000)

	results := make([]CorrelationResult, 0, maxLagDays+1)

	for lagDays := 0; lagDays <= maxLagDays; lagDays++ {
		alignedX := make([]float64, 0, len(feature))
		alignedY := make([]float64, 0, len(feature))

		for day, featureValue := range feature {
			shiftedDay := day + int64(lagDays)*dayMs
			if options.HasMaxTargetDayMs && shiftedDay >= options.MaxTargetDayMsExclusive {
				continue
			}
			targetValue, ok := targetReturns[shiftedDay]
			if !ok {
				continue
			}
			alignedX = append(alignedX, featureValue)
			alignedY = append(alignedY, targetValue)
		}

		if len(alignedX) < minSampleSize {
			continue
		}

		correlation, pValue := pearsonCorrelation(alignedX, alignedY)
		results = append(results, CorrelationResult{
			LagDays:     lagDays,
			Correlation: correlation,
			PValue:      pValue,
			SampleSize:  len(alignedX),
		})
	}

	for i := range results {
		result := results[i]
		if best == nil {
			best = &results[i]
			continue
		}
		abs := math.Abs(result.Correlation)
		bestAbs := math.Abs(best.Correlation)
		if abs > bestAbs {
			best = &results[i]
			continue
		}
		if abs == bestAbs && result.PValue < best.PValue {
			best = &results[i]
		}
	}

	return best, results
}

// RunBacktest 与 TS runBacktest 一致。
func RunBacktest(
	feature DailySeries,
	targetReturns DailySeries,
	association AssociationRef,
	config BacktestConfig,
) BacktestMetrics {
	keys := sortedKeys(feature)
	triggerZScore := clampFloat(config.TriggerZScore, 0, 10)
	baselineDays := clampIntTrunc(config.BaselineDays, 5, 365)
	direction := sign(config.Correlation)
	evaluationStartDayMs := config.EvaluationTargetStartDayMs
	evaluationEndDayMs := config.EvaluationTargetEndDayMs

	samples := 0
	for _, day := range keys {
		if value, ok := feature[day]; ok && isFinite(value) {
			samples++
		}
	}

	triggers := 0
	evaluatedSignals := 0
	hits := 0
	totalSignedReturn := 0.0

	baselineWindow := make([]float64, 0, baselineDays+1)
	baselineSum := 0.0
	baselineSumSq := 0.0

	for _, day := range keys {
		featureValue, ok := feature[day]
		if !ok || !isFinite(featureValue) {
			continue
		}

		if len(baselineWindow) >= 5 {
			mu := baselineSum / float64(len(baselineWindow))
			variance := baselineSumSq/float64(len(baselineWindow)) - mu*mu
			sigma := 0.0
			if variance > 0 {
				sigma = math.Sqrt(variance)
			}
			if sigma > 0 {
				z := (featureValue - mu) / sigma
				if z >= triggerZScore {
					triggers++
					shiftedDay := day + int64(association.LagDays)*dayMs
					inWindow := shiftedDay >= evaluationStartDayMs && shiftedDay < evaluationEndDayMs
					targetValue := 0.0
					hasTarget := false
					if inWindow {
						targetValue, hasTarget = targetReturns[shiftedDay]
					}
					if hasTarget && isFinite(targetValue) && direction != 0 {
						evaluatedSignals++
						signedReturn := targetValue * direction
						totalSignedReturn += signedReturn
						if signedReturn > 0 {
							hits++
						}
					}
				}
			}
		}

		baselineWindow = append(baselineWindow, featureValue)
		baselineSum += featureValue
		baselineSumSq += featureValue * featureValue
		if len(baselineWindow) > baselineDays {
			removed := baselineWindow[0]
			baselineWindow = baselineWindow[1:]
			baselineSum -= removed
			baselineSumSq -= removed * removed
		}
	}

	hitRate := 0.0
	if evaluatedSignals > 0 {
		hitRate = float64(hits) / float64(evaluatedSignals)
	}
	avgSignedReturn := 0.0
	if evaluatedSignals > 0 {
		avgSignedReturn = totalSignedReturn / float64(evaluatedSignals)
	}

	return BacktestMetrics{
		Samples:           samples,
		Triggers:          triggers,
		EvaluatedSignals:  evaluatedSignals,
		Hits:              hits,
		HitRate:           hitRate,
		AvgSignedReturn:   avgSignedReturn,
		TotalSignedReturn: totalSignedReturn,
		BaselineDays:      baselineDays,
	}
}

func sortedKeys(series DailySeries) []int64 {
	keys := make([]int64, 0, len(series))
	for key := range series {
		keys = append(keys, key)
	}
	// 小规模序列（<= 50000 点/指标），插入排序足够且无排序依赖。
	for i := 1; i < len(keys); i++ {
		current := keys[i]
		j := i - 1
		for j >= 0 && keys[j] > current {
			keys[j+1] = keys[j]
			j--
		}
		keys[j+1] = current
	}
	return keys
}

func clampIntTrunc(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func sign(value float64) float64 {
	if value > 0 {
		return 1
	}
	if value < 0 {
		return -1
	}
	return 0
}
