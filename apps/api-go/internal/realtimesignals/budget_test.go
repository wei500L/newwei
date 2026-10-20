package realtimesignals

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/dataruntimesettings"
)

func testBudgetRuntime() *dataruntimesettings.RealtimeCronRuntime {
	return &dataruntimesettings.RealtimeCronRuntime{
		Opensky: dataruntimesettings.RealtimeCronOpensky{
			DayIntervalSec:       600,
			NightIntervalSec:     1800,
			DayStartHourHKT:      8,
			NightStartHourHKT:    22,
			WarningRemainingPct:  20,
			CriticalRemainingPct: 10,
		},
	}
}

func TestHKTDateAndPeriodUseHongKongFixedOffset(t *testing.T) {
	// 2026-10-20T00:30:00Z is 08:30 in Hong Kong (day period).
	dayStart := time.Date(2026, 10, 20, 0, 30, 0, 0, time.UTC).UnixMilli()
	if got := hktDate(dayStart); got != "2026-10-20" {
		t.Fatalf("hktDate = %s", got)
	}
	runtime := testBudgetRuntime()
	if got := budgetPeriod(runtime, dayStart); got != "day" {
		t.Fatalf("period at 08:30 HKT = %s", got)
	}
	// 2026-10-20T13:59:00Z is 21:59 HKT (still day), 14:00Z is 22:00 (night).
	if got := budgetPeriod(runtime, time.Date(2026, 10, 20, 13, 59, 0, 0, time.UTC).UnixMilli()); got != "day" {
		t.Fatalf("period at 21:59 HKT = %s", got)
	}
	if got := budgetPeriod(runtime, time.Date(2026, 10, 20, 14, 0, 0, 0, time.UTC).UnixMilli()); got != "night" {
		t.Fatalf("period at 22:00 HKT = %s", got)
	}
	// A UTC date that differs from the Hong Kong date at 00:30 UTC.
	if got := hktDate(time.Date(2026, 10, 19, 16, 30, 0, 0, time.UTC).UnixMilli()); got != "2026-10-20" {
		t.Fatalf("hktDate around midnight = %s", got)
	}
}

func TestBudgetDegradationAndEffectiveInterval(t *testing.T) {
	runtime := testBudgetRuntime()
	cases := []struct {
		remaining    float64
		remainingPct float64
		want         string
	}{
		{0, 0, "exhausted"},
		{10, 10, "critical"},
		{20, 20, "warning"},
		{21, 21, "normal"},
	}
	for _, testCase := range cases {
		got := budgetDegradation(runtime, testCase.remaining, testCase.remainingPct)
		if got != testCase.want {
			t.Fatalf("budgetDegradation(%v, %v) = %s, want %s", testCase.remaining, testCase.remainingPct, got, testCase.want)
		}
	}
	if got := effectiveMilitaryInterval(runtime, "day", "normal"); got != 600 {
		t.Fatalf("day normal interval = %d", got)
	}
	if got := effectiveMilitaryInterval(runtime, "night", "normal"); got != 1800 {
		t.Fatalf("night normal interval = %d", got)
	}
	if got := effectiveMilitaryInterval(runtime, "day", "critical"); got != 1800 {
		t.Fatalf("critical interval = %d", got)
	}
	if got := effectiveMilitaryInterval(runtime, "day", "exhausted"); got != 1800 {
		t.Fatalf("exhausted interval = %d", got)
	}
}

func TestEstimateOpenSkyCreditsForBBox(t *testing.T) {
	cases := []struct {
		bbox [4]float64
		want int
	}{
		{[4]float64{0, 0, 5, 5}, 1},   // area 25
		{[4]float64{0, 0, 10, 10}, 2}, // area 100
		{[4]float64{0, 0, 20, 20}, 3}, // area 400
		{[4]float64{-130, 24, -60, 55}, 4},
	}
	for _, testCase := range cases {
		if got := estimateOpenSkyCreditsForBBox(testCase.bbox); got != testCase.want {
			t.Fatalf("estimate(%v) = %d, want %d", testCase.bbox, got, testCase.want)
		}
	}
}

func TestBuildBudgetContextMemberOrder(t *testing.T) {
	summary := budgetSummary{
		DateHKT: "2026-10-20", DailyBudget: 4000, UsedCredits: 100, RemainingCredits: 3900,
		UsagePct: 2.5, CurrentPeriod: "day", EffectiveMilitaryIntervalSec: 600,
		DegradationLevel: "normal", AllModeBlocked: false, MilitaryPaused: false,
	}
	raw, err := json.Marshal(buildBudgetContext(summary))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"dateHkt":"2026-10-20","dailyCreditBudget":4000,"usedCredits":100,"remainingCredits":3900,` +
		`"usagePct":2.5,"currentPeriod":"day","effectiveIntervalSec":600,"budgetDegradation":"normal",` +
		`"allModeBlocked":false,"militaryPaused":false}`
	if string(raw) != want {
		t.Fatalf("budget context = %s\nwant %s", raw, want)
	}
}
