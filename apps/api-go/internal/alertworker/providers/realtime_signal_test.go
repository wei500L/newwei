package providers

import (
	"encoding/json"
	"testing"
	"time"
)

func TestNormalizeRealtimeSignalMetricSlug(t *testing.T) {
	cases := []struct {
		name  string
		value string
		want  string
	}{
		{name: "empty", value: "", want: ""},
		{name: "blank", value: "   ", want: ""},
		{name: "trimmed", value: "  realtime.ais.disruptions  ", want: "realtime.ais.disruptions"},
		// The four alias entries of REALTIME_SIGNAL_METRIC_SLUG_ALIASES.
		{name: "opensky identity", value: "realtime.opensky.military_flights", want: "realtime.opensky.military_flights"},
		{name: "adsb military redirect", value: "realtime.adsb.military_flights", want: "realtime.opensky.military_flights"},
		{name: "opensky health identity", value: "realtime.opensky.snapshot_health", want: "realtime.opensky.snapshot_health"},
		{name: "adsb health redirect", value: "realtime.adsb.snapshot_health", want: "realtime.opensky.snapshot_health"},
		{name: "unknown passthrough", value: "realtime.uniswap.count", want: "realtime.uniswap.count"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := normalizeRealtimeSignalMetricSlug(testCase.value); got != testCase.want {
				t.Fatalf("want %q, got %q", testCase.want, got)
			}
		})
	}
}

func TestDecodeRealtimeSeries(t *testing.T) {
	payload := []byte(`{
		"metricSlug": "realtime.opensky.military_flights",
		"points": [
			{"ts":"2026-10-20T02:00:00.000Z","value":5},
			{"ts":"2026-10-20T01:00:00.000Z","value":3,"context":{"a":1}},
			{"ts":123,"value":1},
			{"ts":"2026-10-20T03:00:00.000Z","value":"9"},
			{"ts":"2026-10-20T04:00:00.000Z","value":7.5,"context":[1,2]},
			null
		]
	}`)
	points, err := decodeRealtimeSeries(payload)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(points) != 3 {
		t.Fatalf("want 3 valid points, got %#v", points)
	}
	// Sorted by ts (byte order == localeCompare for ISO strings).
	if points[0].TS != "2026-10-20T01:00:00.000Z" || points[0].Value != 3 {
		t.Fatalf("first point: %#v", points[0])
	}
	if string(points[0].Context) != `{"a":1}` {
		t.Fatalf("context should be kept as an object, got %s", points[0].Context)
	}
	if points[1].TS != "2026-10-20T02:00:00.000Z" || points[2].Value != 7.5 {
		t.Fatalf("order/value mismatch: %#v", points)
	}
	// A non-object context is dropped like the NestJS Array.isArray guard.
	if points[2].Context != nil {
		t.Fatalf("array context should be dropped, got %s", points[2].Context)
	}

	// Equal timestamps keep their stored order (JavaScript's sort is stable).
	sameTimestamp, err := decodeRealtimeSeries([]byte(`{"points":[
		{"ts":"2026-10-20T01:00:00.000Z","value":1},
		{"ts":"2026-10-20T01:00:00.000Z","value":2}
	]}`))
	if err != nil {
		t.Fatalf("same timestamp decode: %v", err)
	}
	if len(sameTimestamp) != 2 || sameTimestamp[0].Value != 1 || sameTimestamp[1].Value != 2 {
		t.Fatalf("stable sort expected, got %#v", sameTimestamp)
	}

	// A non-object payload yields no points; invalid JSON is an error.
	if points, err := decodeRealtimeSeries([]byte(`[]`)); err != nil || len(points) != 0 {
		t.Fatalf("array payload: want empty/nil error, got %#v/%v", points, err)
	}
	if _, err := decodeRealtimeSeries([]byte(`{`)); err == nil {
		t.Fatal("invalid JSON should be an error")
	}
	if points, err := decodeRealtimeSeries([]byte(`{"points":{}}`)); err != nil || len(points) != 0 {
		t.Fatalf("non-array points: want empty/nil error, got %#v/%v", points, err)
	}
}

func TestEvaluateRealtimeSeriesEmpty(t *testing.T) {
	evaluation := evaluateRealtimeSeries(nil, nil, time.Now().UTC())
	if evaluation.Latest != nil || evaluation.Previous != nil || evaluation.ChangePercent != nil || evaluation.Context != nil {
		t.Fatalf("empty series must be all nil, got %#v", evaluation)
	}
}

func TestEvaluateRealtimeSeriesChangePercent(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	contextJSON := json.RawMessage(`{"fresh":true}`)
	points := []realtimeSeriesPoint{
		{TS: "2026-10-20T11:00:00.000Z", Value: 2},
		{TS: "2026-10-20T11:30:00.000Z", Value: 4},
		{TS: "2026-10-20T12:00:00.000Z", Value: 6, Context: contextJSON},
	}
	window := 60

	evaluation := evaluateRealtimeSeries(points, &window, now)
	pipelineFloatEqual(t, "latest", evaluation.Latest, evaluationNumber(6))
	// targetTs = 11:00, the newest point at or before it is 11:00.
	pipelineFloatEqual(t, "previous", evaluation.Previous, evaluationNumber(2))
	pipelineFloatEqual(t, "change", evaluation.ChangePercent, evaluationNumber(200))
	if string(evaluation.Context) != `{"fresh":true}` {
		t.Fatalf("context should be the latest point context, got %s", evaluation.Context)
	}
}

func TestEvaluateRealtimeSeriesPreviousFallback(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	// No point at or before targetTs (11:00), so the second newest point is used.
	points := []realtimeSeriesPoint{
		{TS: "2026-10-20T11:30:00.000Z", Value: 4},
		{TS: "2026-10-20T12:00:00.000Z", Value: 6},
	}
	window := 60

	evaluation := evaluateRealtimeSeries(points, &window, now)
	pipelineFloatEqual(t, "previous", evaluation.Previous, evaluationNumber(4))
	pipelineFloatEqual(t, "change", evaluation.ChangePercent, evaluationNumber(50))
}

func TestEvaluateRealtimeSeriesSinglePoint(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	points := []realtimeSeriesPoint{{TS: "2026-10-20T12:00:00.000Z", Value: 9}}

	evaluation := evaluateRealtimeSeries(points, nil, now)
	pipelineFloatEqual(t, "latest", evaluation.Latest, evaluationNumber(9))
	if evaluation.Previous != nil || evaluation.ChangePercent != nil {
		t.Fatalf("single point must have no previous/change, got %#v", evaluation)
	}
}

func TestEvaluateRealtimeSeriesZeroPrevious(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	points := []realtimeSeriesPoint{
		{TS: "2026-10-20T11:00:00.000Z", Value: 0},
		{TS: "2026-10-20T12:00:00.000Z", Value: 5},
	}
	window := 60

	evaluation := evaluateRealtimeSeries(points, &window, now)
	pipelineFloatEqual(t, "previous zero", evaluation.Previous, evaluationNumber(0))
	if evaluation.ChangePercent != nil {
		t.Fatalf("previous 0 must yield a nil change, got %v", *evaluation.ChangePercent)
	}
}

func TestEvaluateRealtimeSeriesStale(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	window := 60

	// Freshness limit: max(5, 60*2) = 120 minutes; 180 minutes is stale.
	points := []realtimeSeriesPoint{{
		TS:      "2026-10-20T09:00:00.000Z",
		Value:   5,
		Context: json.RawMessage(`{"snapshotFreshness":"fresh","a":1}`),
	}}
	evaluation := evaluateRealtimeSeries(points, &window, now)
	if evaluation.Latest != nil || evaluation.Previous != nil || evaluation.ChangePercent != nil {
		t.Fatalf("stale evaluation must have nil numbers, got %#v", evaluation)
	}
	want := `{"snapshotFreshness":"fresh","a":1,"stale":true,` +
		`"latestTimestamp":"2026-10-20T09:00:00.000Z","maxStaleMinutes":120}`
	if got := string(evaluation.Context); got != want {
		t.Fatalf("stale context:\nwant %s\ngot  %s", want, got)
	}

	// Without a point context the spread is omitted.
	points = []realtimeSeriesPoint{{TS: "2026-10-20T09:00:00.000Z", Value: 5}}
	evaluation = evaluateRealtimeSeries(points, &window, now)
	want = `{"stale":true,"latestTimestamp":"2026-10-20T09:00:00.000Z","maxStaleMinutes":120}`
	if got := string(evaluation.Context); got != want {
		t.Fatalf("stale context without base:\nwant %s\ngot  %s", want, got)
	}

	// An existing key keeps its position and gets the new value (object spread
	// semantics).
	points = []realtimeSeriesPoint{{
		TS:      "2026-10-20T09:00:00.000Z",
		Value:   5,
		Context: json.RawMessage(`{"stale":false,"b":2}`),
	}}
	evaluation = evaluateRealtimeSeries(points, &window, now)
	want = `{"stale":true,"b":2,"latestTimestamp":"2026-10-20T09:00:00.000Z","maxStaleMinutes":120}`
	if got := string(evaluation.Context); got != want {
		t.Fatalf("stale context with existing key:\nwant %s\ngot  %s", want, got)
	}

	// maxStaleMinutes is floored at 5 for a one minute window.
	window = 1
	points = []realtimeSeriesPoint{{TS: "2026-10-20T11:50:00.000Z", Value: 5}}
	evaluation = evaluateRealtimeSeries(points, &window, now)
	if got := string(evaluation.Context); got !=
		`{"stale":true,"latestTimestamp":"2026-10-20T11:50:00.000Z","maxStaleMinutes":5}` {
		t.Fatalf("short window stale context: %s", got)
	}

	// A recent point is not stale.
	window = 60
	points = []realtimeSeriesPoint{{TS: "2026-10-20T11:30:00.000Z", Value: 5}}
	evaluation = evaluateRealtimeSeries(points, &window, now)
	pipelineFloatEqual(t, "fresh latest", evaluation.Latest, evaluationNumber(5))
}

func TestEvaluateRealtimeSeriesUnparsableTimestamp(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	window := 60
	// Date.parse("not-a-date") is NaN: no stale check, no target scan, and the
	// second newest point becomes the previous value.
	points := []realtimeSeriesPoint{
		{TS: "also-bad", Value: 2},
		{TS: "not-a-date", Value: 5},
	}

	evaluation := evaluateRealtimeSeries(points, &window, now)
	pipelineFloatEqual(t, "latest", evaluation.Latest, evaluationNumber(5))
	pipelineFloatEqual(t, "previous", evaluation.Previous, evaluationNumber(2))
	pipelineFloatEqual(t, "change", evaluation.ChangePercent, evaluationNumber(150))
	if evaluation.Context != nil {
		t.Fatalf("unparsable timestamp must not produce a stale context, got %s", evaluation.Context)
	}
}

func TestApplyRealtimeSlugOverride(t *testing.T) {
	// Not the OpenSky slug: the evaluation passes through untouched.
	input := Evaluation{
		Latest:  evaluationNumber(3),
		Context: json.RawMessage(`{"snapshotRetainedPrevious":true}`),
	}
	if got := applyRealtimeSlugOverride("realtime.ais.disruptions", input); got.Latest == nil || *got.Latest != 3 {
		t.Fatalf("non-opensky slug must pass through, got %#v", got)
	}

	// A retained snapshot turns into a value-less stale evaluation.
	input = Evaluation{
		Latest:        evaluationNumber(3),
		Previous:      evaluationNumber(2),
		ChangePercent: evaluationNumber(50),
		Context: json.RawMessage(`{"snapshotRetainedPrevious":true,` +
			`"latestObservedAt":"2026-10-20T09:00:00.000Z","staleThresholdSec":90,"count":5}`),
	}
	got := applyRealtimeSlugOverride(realtimeSignalSlugOpensky, input)
	if got.Latest != nil || got.Previous != nil || got.ChangePercent != nil {
		t.Fatalf("retained snapshot must have nil numbers, got %#v", got)
	}
	want := `{"snapshotRetainedPrevious":true,"latestObservedAt":"2026-10-20T09:00:00.000Z",` +
		`"staleThresholdSec":90,"count":5,"stale":true,` +
		`"latestTimestamp":"2026-10-20T09:00:00.000Z","maxStaleMinutes":2}`
	if string(got.Context) != want {
		t.Fatalf("opensky override context:\nwant %s\ngot  %s", want, string(got.Context))
	}

	// snapshotFreshness === "stale" triggers the same branch and falls back to
	// snapshotUpdatedAt; a missing numeric staleThresholdSec omits maxStaleMinutes.
	input = Evaluation{
		Latest: evaluationNumber(3),
		Context: json.RawMessage(`{"snapshotFreshness":"stale",` +
			`"snapshotUpdatedAt":"2026-10-20T08:00:00.000Z","staleThresholdSec":"90"}`),
	}
	got = applyRealtimeSlugOverride(realtimeSignalSlugOpensky, input)
	want = `{"snapshotFreshness":"stale","snapshotUpdatedAt":"2026-10-20T08:00:00.000Z",` +
		`"staleThresholdSec":"90","stale":true,` +
		`"latestTimestamp":"2026-10-20T08:00:00.000Z"}`
	if string(got.Context) != want {
		t.Fatalf("opensky freshness context:\nwant %s\ngot  %s", want, string(got.Context))
	}

	// A short staleThresholdSec still yields maxStaleMinutes 1.
	input = Evaluation{
		Latest:  evaluationNumber(3),
		Context: json.RawMessage(`{"snapshotRetainedPrevious":true,"staleThresholdSec":30}`),
	}
	got = applyRealtimeSlugOverride(realtimeSignalSlugOpensky, input)
	want = `{"snapshotRetainedPrevious":true,"staleThresholdSec":30,"stale":true,"maxStaleMinutes":1}`
	if string(got.Context) != want {
		t.Fatalf("opensky short threshold:\nwant %s\ngot  %s", want, string(got.Context))
	}

	// Without the retained/stale flags nothing is overridden.
	input = Evaluation{
		Latest:  evaluationNumber(3),
		Context: json.RawMessage(`{"snapshotRetainedPrevious":false,"snapshotFreshness":"fresh"}`),
	}
	got = applyRealtimeSlugOverride(realtimeSignalSlugOpensky, input)
	if got.Latest == nil || *got.Latest != 3 {
		t.Fatalf("fresh snapshot must pass through, got %#v", got)
	}
	if string(got.Context) != `{"snapshotRetainedPrevious":false,"snapshotFreshness":"fresh"}` {
		t.Fatalf("fresh context must be untouched, got %s", got.Context)
	}
}
