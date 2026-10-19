package economicdata

import (
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/economicqueue"
)

func TestSmoothedDailyPatternsAreDistinctAndStable(t *testing.T) {
	service := &Service{env: Env{ScheduleSmoothing: true}}
	configs := []schedulerConfig{
		{ItemID: "b", Slug: "beta", Frequency: FrequencyDaily, IsEnabled: true},
		{ItemID: "a", Slug: "alpha", Frequency: FrequencyDaily, IsEnabled: true},
	}
	available := map[string]bool{"a": true, "b": true}
	first := service.buildSmoothedRepeatPatterns(configs, available)
	second := service.buildSmoothedRepeatPatterns([]schedulerConfig{configs[1], configs[0]}, available)
	if first["a"] == first["b"] {
		t.Fatalf("daily slugs share cron: %q", first["a"])
	}
	if first["a"] != second["a"] || first["b"] != second["b"] {
		t.Fatalf("slot assignment is not slug-stable: %v vs %v", first, second)
	}
}

func TestSmoothingDisabledUsesFixedEvery(t *testing.T) {
	service := &Service{env: Env{ScheduleSmoothing: false}}
	repeat := service.buildRepeatOptions(FrequencyHourly, nil, "")
	if repeat.Pattern != "" || repeat.Every != 3600_000 {
		t.Fatalf("hourly repeat = %+v", repeat)
	}
}

func TestRealtimeSlotPatternIsSixFields(t *testing.T) {
	pattern := buildPatternForSlot(FrequencyRealtime, 29)
	if pattern != "29,59 * * * * *" {
		t.Fatalf("pattern = %q", pattern)
	}
	if next, ok := economicqueue.NextPatternMillis(pattern, timeFixture(), nil); !ok || next == 0 {
		t.Fatalf("realtime pattern did not parse: %q", pattern)
	}
}

func TestRepeatMatchesUsesEveryAndPattern(t *testing.T) {
	if !repeatMatches(economicqueue.RepeatableJob{Every: "30000"}, economicqueue.RepeatOptions{Every: 30000}) {
		t.Fatal("every mismatch")
	}
	if !repeatMatches(economicqueue.RepeatableJob{Pattern: "0 * * * *"}, economicqueue.RepeatOptions{Pattern: "0 * * * *"}) {
		t.Fatal("pattern mismatch")
	}
	if repeatMatches(economicqueue.RepeatableJob{Pattern: "0 * * * *"}, economicqueue.RepeatOptions{Pattern: "5 * * * *"}) {
		t.Fatal("different patterns matched")
	}
}

func TestPresetCategoryMapCoversSevenValues(t *testing.T) {
	want := map[string]string{
		"keyMonitor":       "key-monitor",
		"militaryAlert":    "military-alert",
		"economicAlert":    "economic-alert",
		"economicShort":    "economic-short",
		"economicMedium":   "economic-medium",
		"economicLong":     "economic-long",
		"livelihoodPrices": "livelihood-prices",
	}
	if len(PresetCategoryKeys) != len(want) {
		t.Fatalf("preset count = %d", len(PresetCategoryKeys))
	}
	for key, category := range want {
		if PresetCategoryKeys[key] != category {
			t.Fatalf("%s = %q", key, PresetCategoryKeys[key])
		}
	}
}

func timeFixture() time.Time {
	return time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
}
