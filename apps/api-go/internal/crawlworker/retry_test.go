package crawlworker

import (
	"encoding/json"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
)

func TestJSRoundRoundsHalfUp(t *testing.T) {
	cases := []struct {
		value float64
		want  int
	}{
		{0, 0},
		{0.4, 0},
		{0.5, 1},
		{1.4, 1},
		{1.5, 2},
		{2.5, 3},
		{-0.5, 0},
		{-1.5, -1},
		{-2.6, -3},
		{2.6, 3},
		{119_999.6, 120_000},
	}
	for _, testCase := range cases {
		if got := jsRound(testCase.value); got != testCase.want {
			t.Errorf("jsRound(%v) = %d, want %d", testCase.value, got, testCase.want)
		}
	}
}

func TestResolveInitialWorkerConcurrency(t *testing.T) {
	cases := []struct {
		configured int
		fallback   int
		want       int
	}{
		{0, 0, 1},
		{0, 7, 7},
		{5, 7, 5},
		{1, 0, 1},
		{20, 3, 20},
		{-4, 6, 6},
		{-4, -6, 1},
	}
	for _, testCase := range cases {
		if got := resolveInitialWorkerConcurrency(testCase.configured, testCase.fallback); got != testCase.want {
			t.Errorf("resolveInitialWorkerConcurrency(%d,%d) = %d, want %d",
				testCase.configured, testCase.fallback, got, testCase.want)
		}
	}
}

func TestResolveManualLimiterMax(t *testing.T) {
	cases := map[int]int64{1: 100, 3: 300, 20: 2_000, 0: 1, -2: 1, 200: 10_000}
	for concurrency, want := range cases {
		if got := resolveManualLimiterMax(concurrency); got != want {
			t.Errorf("resolveManualLimiterMax(%d) = %d, want %d", concurrency, got, want)
		}
	}
}

func TestResolveMaxAttempts(t *testing.T) {
	cases := map[int]int{0: 1, -3: 1, 1: 1, 5: 5}
	for value, want := range cases {
		if got := resolveMaxAttempts(value); got != want {
			t.Errorf("resolveMaxAttempts(%d) = %d, want %d", value, got, want)
		}
	}
}

func TestResolveAttemptsStartedPrefersATS(t *testing.T) {
	cases := []struct {
		attemptsStarted int
		attemptsMade    int
		want            int
	}{
		{0, 0, 1},
		{0, 4, 5},
		{0, -1, 1},
		{7, 4, 7},
		{2, 0, 2},
		{-5, 2, 3},
	}
	for _, testCase := range cases {
		if got := resolveAttemptsStarted(testCase.attemptsStarted, testCase.attemptsMade); got != testCase.want {
			t.Errorf("resolveAttemptsStarted(%d,%d) = %d, want %d",
				testCase.attemptsStarted, testCase.attemptsMade, got, testCase.want)
		}
	}
}

func TestResolveAttemptIsCappedByMaxAttempts(t *testing.T) {
	if got := resolveAttempt(3, 5); got != 3 {
		t.Errorf("resolveAttempt(3,5) = %d, want 3", got)
	}
	if got := resolveAttempt(5, 2); got != 2 {
		t.Errorf("resolveAttempt(5,2) = %d, want 2", got)
	}
}

func TestResolveBackoffDelayMs(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		attempt int
		want    *int
	}{
		{"absent", "", 1, nil},
		{"null", "null", 1, nil},
		{"number", "1000", 1, intPointer(1000)},
		{"number rounds", "1000.5", 1, intPointer(1001)},
		{"number floors at zero", "-50", 1, intPointer(0)},
		{"exponential first attempt", `{"type":"exponential","delay":1000}`, 1, intPointer(1000)},
		{"exponential third attempt", `{"type":"exponential","delay":1000}`, 3, intPointer(4000)},
		{"exponential attempt zero", `{"type":"exponential","delay":1000}`, 0, intPointer(1000)},
		{"exponential negative attempt", `{"type":"exponential","delay":250}`, -3, intPointer(250)},
		{"fixed", `{"type":"fixed","delay":2500}`, 3, intPointer(2500)},
		{"unknown type uses the delay", `{"type":"custom","delay":700}`, 3, intPointer(700)},
		{"string delay", `{"type":"exponential","delay":"1000"}`, 3, nil},
		{"missing delay", `{"type":"exponential"}`, 3, nil},
		{"empty object", `{}`, 3, nil},
		{"string backoff", `"1000"`, 3, nil},
		{"boolean backoff", `true`, 3, nil},
	}
	for _, testCase := range cases {
		got := resolveBackoffDelayMs(json.RawMessage(testCase.raw), testCase.attempt)
		if (got == nil) != (testCase.want == nil) {
			t.Errorf("%s: got %v, want %v", testCase.name, got, testCase.want)
			continue
		}
		if got != nil && *got != *testCase.want {
			t.Errorf("%s: got %d, want %d", testCase.name, *got, *testCase.want)
		}
	}
}

func TestResolveQueueOverloadCooldownMs(t *testing.T) {
	percent := func(value float64) *float64 { return &value }
	cases := []struct {
		name       string
		configured int
		percent    *float64
		want       int
	}{
		{"default", 0, nil, 30_000},
		{"default with low memory", 0, percent(10), 30_000},
		{"configured", 60_000, nil, 60_000},
		{"configured at 94", 60_000, percent(94), 120_000},
		{"configured at 96", 60_000, percent(96), 180_000},
		{"configured at 98", 60_000, percent(98), 240_000},
		{"configured at 99.5", 60_000, percent(99.5), 240_000},
		{"configured below 94", 60_000, percent(93.9), 60_000},
		{"configured base is clamped low", 1_000, nil, 5_000},
		{"configured base is clamped low with multiplier", 1_000, percent(98), 20_000},
		{"configured base is clamped high", 900_000, nil, 600_000},
		{"multiplied result is clamped high", 900_000, percent(98), 600_000},
		{"negative configured falls back", -5, nil, 30_000},
	}
	for _, testCase := range cases {
		if got := resolveQueueOverloadCooldownMs(testCase.configured, testCase.percent); got != testCase.want {
			t.Errorf("%s: cooldown = %d, want %d", testCase.name, got, testCase.want)
		}
	}
}

func TestResolveRequestTimeoutMs(t *testing.T) {
	settings := crawlqueue.Settings{RequestTimeoutHotMs: 60_000, RequestTimeoutNormalMs: 120_000}
	cases := []struct {
		name     string
		class    crawlqueue.PriorityClass
		settings crawlqueue.Settings
		fallback int
		want     int
	}{
		{"hot", crawlqueue.PriorityClassHot, settings, 90_000, 60_000},
		{"normal", crawlqueue.PriorityClassNormal, settings, 90_000, 120_000},
		{"empty hot uses the fallback", crawlqueue.PriorityClassHot, crawlqueue.Settings{}, 90_000, 90_000},
		{"empty normal uses the fallback", crawlqueue.PriorityClassNormal, crawlqueue.Settings{}, 90_000, 90_000},
		{"no settings and no fallback", crawlqueue.PriorityClassNormal, crawlqueue.Settings{}, 0, 120_000},
		{"below the floor", crawlqueue.PriorityClassNormal, crawlqueue.Settings{RequestTimeoutNormalMs: 500}, 0, 1_000},
		{"fallback below the floor", crawlqueue.PriorityClassHot, crawlqueue.Settings{}, 10, 1_000},
	}
	for _, testCase := range cases {
		if got := resolveRequestTimeoutMs(testCase.class, testCase.settings, testCase.fallback); got != testCase.want {
			t.Errorf("%s: timeout = %d, want %d", testCase.name, got, testCase.want)
		}
	}
}
