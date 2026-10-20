package gdeltsnapshot

import (
	"context"
	"math"
	"testing"
	"time"
)

// TestNextScheduledAtMatchesComputeNextScheduledAt pins the quarter-hour
// boundaries, including the exact-boundary and hour-rollover cases.
func TestNextScheduledAtMatchesComputeNextScheduledAt(t *testing.T) {
	cases := []struct {
		now  string
		want string
	}{
		{"2026-10-20T12:00:00.000Z", "2026-10-20T12:15:00.000Z"},
		{"2026-10-20T12:00:00.001Z", "2026-10-20T12:15:00.000Z"},
		{"2026-10-20T12:14:59.999Z", "2026-10-20T12:15:00.000Z"},
		{"2026-10-20T12:15:00.000Z", "2026-10-20T12:30:00.000Z"},
		{"2026-10-20T12:29:30.000Z", "2026-10-20T12:30:00.000Z"},
		{"2026-10-20T12:45:00.000Z", "2026-10-20T13:00:00.000Z"},
		{"2026-10-20T12:59:59.999Z", "2026-10-20T13:00:00.000Z"},
		{"2026-10-20T23:59:00.000Z", "2026-10-21T00:00:00.000Z"},
	}
	for _, testCase := range cases {
		now, err := time.Parse(time.RFC3339Nano, testCase.now)
		if err != nil {
			t.Fatalf("parse %q: %v", testCase.now, err)
		}
		if got := isoTime(nextScheduledAt(now)); got != testCase.want {
			t.Errorf("nextScheduledAt(%s) = %s, want %s", testCase.now, got, testCase.want)
		}
	}
}

// TestComputeStatusMetricsRoundsLikeNestJS covers the two rounding expressions
// and the null cases of a window without rows or without valid payloads.
func TestComputeStatusMetricsRoundsLikeNestJS(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 34, 0, 0, time.UTC)
	fullSuccess := time.Date(2026, 10, 20, 9, 15, 0, 0, time.UTC)
	nonSuccess := time.Date(2026, 10, 20, 9, 30, 0, 0, time.UTC)

	cases := []struct {
		name            string
		row             aggregateRow
		wantSuccessRate *float64
		wantAverage     *float64
	}{
		{
			name: "empty window",
			row:  aggregateRow{},
		},
		{
			name:            "quarter success",
			row:             aggregateRow{RecentCount: 96, ValidPayloadCount: 96, CompletedCount: 24, AvailableCategorySum: 96},
			wantSuccessRate: floatPtr(25),
			wantAverage:     floatPtr(1),
		},
		{
			name:            "no valid payloads keeps the average null",
			row:             aggregateRow{RecentCount: 4, ValidPayloadCount: 0, CompletedCount: 1},
			wantSuccessRate: floatPtr(25),
		},
		{
			name:            "success rate tie rounds up",
			row:             aggregateRow{RecentCount: 16, ValidPayloadCount: 16, CompletedCount: 1, AvailableCategorySum: 0},
			wantSuccessRate: floatPtr(6.3),
			wantAverage:     floatPtr(0),
		},
		{
			name:            "average tie rounds up",
			row:             aggregateRow{RecentCount: 1, ValidPayloadCount: 20, CompletedCount: 1, AvailableCategorySum: 1},
			wantSuccessRate: floatPtr(100),
			wantAverage:     floatPtr(0.1),
		},
		{
			name:            "average keeps one decimal",
			row:             aggregateRow{RecentCount: 3, ValidPayloadCount: 3, CompletedCount: 2, AvailableCategorySum: 11},
			wantSuccessRate: floatPtr(66.7),
			wantAverage:     floatPtr(3.7),
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			row := testCase.row
			row.LastFullSuccessAt = &fullSuccess
			row.LastNonSuccessAt = &nonSuccess
			metrics := computeStatusMetrics(row, now)
			assertOptionalFloat(t, "successRate", metrics.Rolling24hSuccessRate, testCase.wantSuccessRate)
			assertOptionalFloat(t, "average", metrics.Rolling24hAverageAvailableCategoryCount, testCase.wantAverage)
			if metrics.LastFullSuccessAt == nil || *metrics.LastFullSuccessAt != "2026-10-20T09:15:00.000Z" {
				t.Errorf("lastFullSuccessAt = %v", metrics.LastFullSuccessAt)
			}
			if metrics.NextScheduledAt != "2026-10-20T12:45:00.000Z" {
				t.Errorf("nextScheduledAt = %s", metrics.NextScheduledAt)
			}
			if metrics.Rolling24hRateLimitedCount != testCase.row.RateLimitedCount {
				t.Errorf("rateLimitedCount = %d", metrics.Rolling24hRateLimitedCount)
			}
		})
	}
}

// TestComputeStatusMetricsFormulaMatchesTranscription re-derives the two
// metrics with the literal NestJS expressions on the same inputs.
func TestComputeStatusMetricsFormulaMatchesTranscription(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	for recent := 1; recent <= 96; recent++ {
		for _, completed := range []int{0, 1, recent / 2, recent} {
			for _, available := range []int{0, 1, 5, 6} {
				row := aggregateRow{
					RecentCount:          recent,
					ValidPayloadCount:    recent,
					CompletedCount:       completed,
					AvailableCategorySum: available * recent,
				}
				metrics := computeStatusMetrics(row, now)
				wantRate := math.Round(float64(completed)/float64(recent)*1000) / 10
				wantAverage := math.Round(float64(available*recent)/float64(recent)*10) / 10
				if metrics.Rolling24hSuccessRate == nil || *metrics.Rolling24hSuccessRate != wantRate {
					t.Fatalf("recent=%d completed=%d rate = %v, want %v", recent, completed, metrics.Rolling24hSuccessRate, wantRate)
				}
				if metrics.Rolling24hAverageAvailableCategoryCount == nil ||
					*metrics.Rolling24hAverageAvailableCategoryCount != wantAverage {
					t.Fatalf("recent=%d available=%d average = %v, want %v", recent, available,
						metrics.Rolling24hAverageAvailableCategoryCount, wantAverage)
				}
			}
		}
	}
}

// TestBuildStatusSummaryDerivesPayloadFields checks the payload-derived members
// and the disabled/idle statuses.
func TestBuildStatusSummaryDerivesPayloadFields(t *testing.T) {
	rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
	payload, err := rig.service.rebuild(context.Background())
	if err != nil {
		t.Fatalf("rebuild: %v", err)
	}
	summary, err := rig.service.buildStatusSummary(context.Background(), payload, true, true)
	if err != nil {
		t.Fatalf("summary: %v", err)
	}
	if !summary.Enabled || summary.Status != string(StatusCompleted) || !summary.Stale {
		t.Errorf("summary = %+v", summary)
	}
	if summary.IntervalMinutes != 15 || summary.HistoryRetentionDays != 7 {
		t.Errorf("interval/retention = %d/%d", summary.IntervalMinutes, summary.HistoryRetentionDays)
	}
	if summary.AvailableCategoryCount != 6 || summary.WarningCount != 0 {
		t.Errorf("available/warnings = %d/%d", summary.AvailableCategoryCount, summary.WarningCount)
	}
	if summary.GeneratedAt == nil || *summary.GeneratedAt != payload.GeneratedAt {
		t.Errorf("generatedAt = %v", summary.GeneratedAt)
	}
	if summary.ExpiresAt == nil || *summary.ExpiresAt != payload.ExpiresAt {
		t.Errorf("expiresAt = %v", summary.ExpiresAt)
	}
	if summary.NextScheduledAt == nil || *summary.NextScheduledAt != "2026-10-20T12:45:00.000Z" {
		t.Errorf("nextScheduledAt = %v", summary.NextScheduledAt)
	}
	if summary.Warnings == nil {
		t.Error("warnings = nil, want an empty array")
	}

	disabled, err := rig.service.buildStatusSummary(context.Background(), payload, false, false)
	if err != nil {
		t.Fatalf("disabled summary: %v", err)
	}
	if disabled.Status != "disabled" || disabled.NextScheduledAt != nil || disabled.Enabled {
		t.Errorf("disabled summary = %+v", disabled)
	}

	idle, err := rig.service.buildStatusSummary(context.Background(), nil, false, true)
	if err != nil {
		t.Fatalf("idle summary: %v", err)
	}
	if idle.Status != "idle" || idle.GeneratedAt != nil || idle.AvailableCategoryCount != 0 {
		t.Errorf("idle summary = %+v", idle)
	}
}

func floatPtr(value float64) *float64 {
	return &value
}

func assertOptionalFloat(t *testing.T, name string, got, want *float64) {
	t.Helper()
	switch {
	case got == nil && want == nil:
		return
	case got == nil || want == nil:
		t.Errorf("%s = %v, want %v", name, got, want)
	case *got != *want:
		t.Errorf("%s = %v, want %v", name, *got, *want)
	}
}

// TestGetStatusSummaryReadsCurrentSnapshot pins the new exported read used by
// the situation settings GET/PUT/DELETE responses: it reads the current
// snapshot and applies the configured enabled flag, without rebuilding.
func TestGetStatusSummaryReadsCurrentSnapshot(t *testing.T) {
	rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
	ctx := context.Background()
	payload, err := rig.service.rebuild(ctx)
	if err != nil {
		t.Fatalf("rebuild: %v", err)
	}
	if err := rig.service.persist(ctx, payload, rig.now, rig.now.Add(15*time.Minute)); err != nil {
		t.Fatalf("persist: %v", err)
	}
	summary, err := rig.service.GetStatusSummary(ctx)
	if err != nil {
		t.Fatalf("GetStatusSummary: %v", err)
	}
	if !summary.Enabled || summary.Status != string(StatusCompleted) {
		t.Fatalf("summary = %+v", summary)
	}
	if summary.GeneratedAt == nil || *summary.GeneratedAt != payload.GeneratedAt {
		t.Fatalf("generatedAt = %v", summary.GeneratedAt)
	}

	disabledRig := newTestRig(t, rigOptions{enabled: false, responses: allCategoriesArticles()})
	disabledPayload, err := disabledRig.service.rebuild(ctx)
	if err != nil {
		t.Fatalf("disabled rebuild: %v", err)
	}
	if err := disabledRig.service.persist(ctx, disabledPayload, disabledRig.now, disabledRig.now.Add(15*time.Minute)); err != nil {
		t.Fatalf("disabled persist: %v", err)
	}
	disabled, err := disabledRig.service.GetStatusSummary(ctx)
	if err != nil {
		t.Fatalf("disabled GetStatusSummary: %v", err)
	}
	if disabled.Enabled || disabled.Status != "disabled" || disabled.NextScheduledAt != nil {
		t.Fatalf("disabled summary = %+v", disabled)
	}
}
