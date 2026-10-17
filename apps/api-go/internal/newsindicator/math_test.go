package newsindicator

import (
	"math"
	"testing"
	"time"
)

func utcDay(year int, month time.Month, day int) time.Time {
	return time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
}

func almostEqual(a, b float64) bool {
	return math.Abs(a-b) <= 1e-12
}

func TestToUtcDayStartMs(t *testing.T) {
	value := time.Date(2026, 3, 4, 23, 59, 59, 999_000_000, time.UTC)
	want := time.Date(2026, 3, 4, 0, 0, 0, 0, time.UTC).UnixMilli()
	if got := ToUtcDayStartMs(value); got != want {
		t.Fatalf("ToUtcDayStartMs = %d, want %d", got, want)
	}
}

func TestPearsonCorrelation(t *testing.T) {
	correlation, pValue := pearsonCorrelation([]float64{1, 2, 3, 4, 5}, []float64{2, 4, 6, 8, 10})
	if !almostEqual(correlation, 0.999999) {
		t.Fatalf("correlation = %v, want clamped 0.999999", correlation)
	}
	if pValue >= 1e-3 {
		t.Fatalf("pValue = %v, want small", pValue)
	}
	if correlation, pValue := pearsonCorrelation([]float64{1}, []float64{2}); correlation != 0 || pValue != 1 {
		t.Fatalf("n<2 = %v,%v want 0,1", correlation, pValue)
	}
	if correlation, pValue := pearsonCorrelation([]float64{1, 1, 1}, []float64{1, 2, 3}); correlation != 0 || pValue != 1 {
		t.Fatalf("zero variance = %v,%v want 0,1", correlation, pValue)
	}
}

func TestBuildDailyEconomicValues(t *testing.T) {
	series := BuildDailyEconomicValues([]NumericSeriesPoint{
		{ID: "b", RecordedAt: time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC), Value: 10},
		{ID: "a", RecordedAt: time.Date(2026, 1, 1, 15, 0, 0, 0, time.UTC), Value: 20},
		{ID: "x", RecordedAt: time.Date(2026, 1, 2, 8, 0, 0, 0, time.UTC), Value: 1},
		{ID: "y", RecordedAt: time.Date(2026, 1, 2, 8, 0, 0, 0, time.UTC), Value: 2},
		{ID: "z", RecordedAt: time.Date(2026, 1, 3, 8, 0, 0, 0, time.UTC), Value: math.Inf(1)},
	})

	if got := series[utcDay(2026, 1, 1).UnixMilli()]; got != 20 {
		t.Fatalf("day1 = %v, want 20 (latest recordedAt wins)", got)
	}
	if got := series[utcDay(2026, 1, 2).UnixMilli()]; got != 2 {
		t.Fatalf("day2 = %v, want 2 (largest id wins on tie)", got)
	}
	if _, ok := series[utcDay(2026, 1, 3).UnixMilli()]; ok {
		t.Fatal("non-finite value was kept")
	}
	if len(series) != 2 {
		t.Fatalf("len = %d, want 2", len(series))
	}
}

func TestBuildDailyReturns(t *testing.T) {
	d1 := utcDay(2026, 1, 1).UnixMilli()
	d2 := utcDay(2026, 1, 2).UnixMilli()
	d3 := utcDay(2026, 1, 3).UnixMilli()

	returns := BuildDailyReturns(DailySeries{d1: 100, d2: 110, d3: 99})
	if !almostEqual(returns[d2], 0.1) {
		t.Fatalf("d2 return = %v, want 0.1", returns[d2])
	}
	if !almostEqual(returns[d3], -0.1) {
		t.Fatalf("d3 return = %v, want -0.1", returns[d3])
	}

	zeroPrev := BuildDailyReturns(DailySeries{d1: 0, d2: 5})
	if !almostEqual(zeroPrev[d2], 5) {
		t.Fatalf("zero-prev return = %v, want 5", zeroPrev[d2])
	}
}

func TestComputeBestLagCorrelation(t *testing.T) {
	base := utcDay(2026, 1, 1)
	feature := DailySeries{}
	target := DailySeries{}
	values := []float64{1, 4, 9, 16, 25}
	for i, value := range values {
		feature[base.AddDate(0, 0, i).UnixMilli()] = value
		target[base.AddDate(0, 0, i+1).UnixMilli()] = value
	}

	best, all := ComputeBestLagCorrelation(feature, target, LagSearchOptions{MaxLagDays: 2, MinSampleSize: 2})
	if best == nil {
		t.Fatal("best is nil")
	}
	if best.LagDays != 1 {
		t.Fatalf("best lag = %d, want 1", best.LagDays)
	}
	if !almostEqual(best.Correlation, 0.999999) {
		t.Fatalf("best correlation = %v, want clamped 0.999999", best.Correlation)
	}
	if best.SampleSize != 5 {
		t.Fatalf("best sampleSize = %d, want 5", best.SampleSize)
	}
	if len(all) != 3 {
		t.Fatalf("len(all) = %d, want 3", len(all))
	}

	// minSampleSize 过滤掉所有 lag。
	if best, all := ComputeBestLagCorrelation(feature, target, LagSearchOptions{MaxLagDays: 2, MinSampleSize: 6}); best != nil || len(all) != 0 {
		t.Fatalf("minSampleSize filter = %v, %d", best, len(all))
	}

	// maxTargetDayMsExclusive 截掉 holdout 段。
	exclusive := base.AddDate(0, 0, 4).UnixMilli()
	best, _ = ComputeBestLagCorrelation(feature, target, LagSearchOptions{
		MaxLagDays:              2,
		MinSampleSize:           1,
		MaxTargetDayMsExclusive: exclusive,
		HasMaxTargetDayMs:       true,
	})
	for _, result := range []*CorrelationResult{best} {
		if result == nil {
			continue
		}
		// 只有 shiftedDay < exclusive 的样本参与。
		if result.SampleSize > 4 {
			t.Fatalf("exclusive window kept %d samples, want <= 4", result.SampleSize)
		}
	}
}

func TestRunBacktest(t *testing.T) {
	base := utcDay(2026, 1, 1)
	values := []float64{1, 2, 1, 2, 1, 2, 1, 2, 1, 20}
	feature := DailySeries{}
	for i, value := range values {
		feature[base.AddDate(0, 0, i).UnixMilli()] = value
	}
	triggerDay := base.AddDate(0, 0, 9).UnixMilli()
	target := DailySeries{triggerDay: 0.05}

	metrics := RunBacktest(feature, target, AssociationRef{LagDays: 0, Correlation: 0.5}, BacktestConfig{
		TriggerZScore:              2,
		BaselineDays:               5,
		HoldoutDays:                1,
		EvaluationTargetStartDayMs: triggerDay,
		EvaluationTargetEndDayMs:   triggerDay + dayMs,
	})
	if metrics.Samples != 10 {
		t.Fatalf("samples = %d, want 10", metrics.Samples)
	}
	if metrics.Triggers != 1 {
		t.Fatalf("triggers = %d, want 1", metrics.Triggers)
	}
	if metrics.EvaluatedSignals != 1 || metrics.Hits != 1 {
		t.Fatalf("evaluated/hits = %d/%d, want 1/1", metrics.EvaluatedSignals, metrics.Hits)
	}
	if !almostEqual(metrics.HitRate, 1) || !almostEqual(metrics.AvgSignedReturn, 0.05) || !almostEqual(metrics.TotalSignedReturn, 0.05) {
		t.Fatalf("metrics = %+v", metrics)
	}

	// 评估窗口不含触发日：仍计触发器，但无评估信号、无命中。
	outside := RunBacktest(feature, target, AssociationRef{LagDays: 0, Correlation: 0.5}, BacktestConfig{
		TriggerZScore:              2,
		BaselineDays:               5,
		HoldoutDays:                1,
		EvaluationTargetStartDayMs: triggerDay + dayMs,
		EvaluationTargetEndDayMs:   triggerDay + 2*dayMs,
	})
	if outside.Triggers != 1 || outside.EvaluatedSignals != 0 || outside.Hits != 0 || outside.HitRate != 0 {
		t.Fatalf("outside window metrics = %+v", outside)
	}

	// 相关系数为 0：不评估信号。
	zeroDirection := RunBacktest(feature, target, AssociationRef{LagDays: 0, Correlation: 0}, BacktestConfig{
		TriggerZScore:              2,
		BaselineDays:               5,
		HoldoutDays:                1,
		EvaluationTargetStartDayMs: triggerDay,
		EvaluationTargetEndDayMs:   triggerDay + dayMs,
	})
	if zeroDirection.Triggers != 1 || zeroDirection.EvaluatedSignals != 0 {
		t.Fatalf("zero-direction metrics = %+v", zeroDirection)
	}

	// baselineDays 下限为 5（截断到合法范围）。
	clamped := RunBacktest(feature, target, AssociationRef{LagDays: 0, Correlation: 0.5}, BacktestConfig{
		TriggerZScore:              2,
		BaselineDays:               1,
		EvaluationTargetStartDayMs: triggerDay,
		EvaluationTargetEndDayMs:   triggerDay + dayMs,
	})
	if clamped.BaselineDays != 5 {
		t.Fatalf("baselineDays = %d, want clamped 5", clamped.BaselineDays)
	}
}
