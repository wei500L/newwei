package realtimesignals

import (
	"encoding/json"
	"testing"
)

func TestResolveRefreshStatePrefersNextEligibleAt(t *testing.T) {
	now := int64(1_700_000_000_000)
	next := formatISO(now + 30_000)
	state := &SourceState{NextEligibleAt: next}
	result := resolveRefreshState(state, nil, 600, now)
	if result.shouldRun {
		t.Fatal("shouldRun = true before nextEligibleAt")
	}
	result = resolveRefreshState(state, nil, 600, now+30_000)
	if !result.shouldRun {
		t.Fatal("shouldRun = false at nextEligibleAt")
	}
}

func TestResolveRefreshStateFallsBackToLastAttempt(t *testing.T) {
	now := int64(1_700_000_000_000)
	state := &SourceState{LastAttemptAt: formatISO(now - 11_000)}
	if result := resolveRefreshState(state, nil, 10, now); !result.shouldRun {
		t.Fatal("11s since last attempt must run for the 10s floor")
	}
	if result := resolveRefreshState(state, nil, 60, now); result.shouldRun {
		t.Fatal("11s since last attempt must not run for a 60s interval")
	}
	if result := resolveRefreshState(nil, nil, 60, now); !result.shouldRun || result.lastRunMs != nil {
		t.Fatal("a source with no state must run with lastRunMs nil")
	}
	lastRun := float64(now - 120_000)
	result := resolveRefreshState(nil, &lastRun, 60, now)
	if !result.shouldRun || result.lastRunMs == nil || *result.lastRunMs != lastRun {
		t.Fatalf("lastRun fallback = %+v", result)
	}
}

func TestComputeNextEligibleAtUsesRetryAfter(t *testing.T) {
	now := int64(1_700_000_000_000)
	if got := computeNextEligibleAt(now, 60, nil); got != formatISO(now+60_000) {
		t.Fatalf("default delay = %s", got)
	}
	shortRetry := int64(1_000)
	if got := computeNextEligibleAt(now, 60, &upstreamError{retryAfterMs: &shortRetry}); got != formatISO(now+60_000) {
		t.Fatalf("short Retry-After must not shorten the interval: %s", got)
	}
	longRetry := int64(120_000)
	if got := computeNextEligibleAt(now, 60, &upstreamError{retryAfterMs: &longRetry}); got != formatISO(now+120_000) {
		t.Fatalf("long Retry-After = %s", got)
	}
}

func TestCarryForwardInsightSnapshotFreshness(t *testing.T) {
	now := int64(1_700_000_000_000)
	current := emptyInsightSnapshot()
	current.KeywordSpikes = []KeywordSpike{{ID: "keyword:one", Term: "one"}}
	current.Tensions = []TensionRow{{ID: "gdelt:usa_russia"}}

	lastRun := float64(now - 60_000)
	next := emptyInsightSnapshot()
	carryForwardInsightSnapshot(&next, current, SourceKeywordSpike, &lastRun, 600, now)
	if len(next.KeywordSpikes) != 1 {
		t.Fatal("fresh keyword spike was not carried forward")
	}

	staleRun := float64(now - 21*60_000)
	next = emptyInsightSnapshot()
	carryForwardInsightSnapshot(&next, current, SourceKeywordSpike, &staleRun, 600, now)
	if len(next.KeywordSpikes) != 0 {
		t.Fatal("stale keyword spike must not be carried forward")
	}

	next = emptyInsightSnapshot()
	carryForwardInsightSnapshot(&next, current, SourceUnrest, &lastRun, 600, now)
	if len(next.KeywordSpikes) != 0 || len(next.Tensions) != 0 {
		t.Fatal("a non-insight source must not carry insight data")
	}

	next = emptyInsightSnapshot()
	carryForwardInsightSnapshot(&next, current, SourceGdeltTension, nil, 600, now)
	if len(next.Tensions) != 0 {
		t.Fatal("a source with no lastRun must not carry insight data")
	}
}

func TestUpdateInsightSnapshotMapsEveryInsightSource(t *testing.T) {
	snapshot := emptyInsightSnapshot()
	updateInsightSnapshot(&snapshot, SourceKeywordSpike, []FetchResult{{
		MetricSlug: metricKeywordSpike,
		Value:      1,
		Context: &keywordSpikeContext{Spikes: []KeywordSpike{{
			ID: "", Term: "", Count: 5, Baseline: 1.5, Multiplier: 3.25, SourceCount: 2, Confidence: 0.72,
		}}},
	}}, "2026-01-01T00:00:00.000Z")
	if len(snapshot.KeywordSpikes) != 1 || snapshot.KeywordSpikes[0].ID != "keyword:0" || snapshot.KeywordSpikes[0].Term != "unknown" {
		t.Fatalf("keyword defaults = %+v", snapshot.KeywordSpikes)
	}

	updateInsightSnapshot(&snapshot, SourcePolymarketLeads, []FetchResult{{
		Context: &polymarketContext{Leads: []PredictionLead{{Title: "", Shift: 6}}},
	}}, "2026-01-01T00:00:00.000Z")
	if len(snapshot.PredictionLeads) != 1 || snapshot.PredictionLeads[0].ID != "lead:0" || snapshot.PredictionLeads[0].Title != "unknown" {
		t.Fatalf("lead defaults = %+v", snapshot.PredictionLeads)
	}

	updateInsightSnapshot(&snapshot, SourceGdeltTension, []FetchResult{{
		Context: &gdeltTensionContext{Tensions: []TensionRow{{
			ID: "", Label: "", Score: 70, ChangePercent: 6, Trend: "RISING",
			Countries: []string{"US", "", "RUSSIA"}, UpdatedAt: "",
		}}},
	}}, "2026-01-01T00:00:00.000Z")
	if len(snapshot.Tensions) != 1 {
		t.Fatalf("tensions = %+v", snapshot.Tensions)
	}
	row := snapshot.Tensions[0]
	if row.ID != "tension:0" || row.Label != "Unknown pair" || row.Trend != "rising" ||
		row.UpdatedAt != "2026-01-01T00:00:00.000Z" {
		t.Fatalf("tension defaults = %+v", row)
	}
	if len(row.Countries) != 2 || row.Countries[0] != "USA" || row.Countries[1] != "RUS" {
		t.Fatalf("tension countries = %v", row.Countries)
	}

	updateInsightSnapshot(&snapshot, SourcePizzint, []FetchResult{{
		Context: &pizzintContext{Defcon: 2, AdjustedScore: 88.5, OpenLocations: 12, ActiveSpikes: 3, AvgPop: 58.5},
	}}, "2026-01-01T00:00:00.000Z")
	if snapshot.Pizzint == nil || snapshot.Pizzint.Defcon != 2 || snapshot.Pizzint.UpdatedAt != "2026-01-01T00:00:00.000Z" {
		t.Fatalf("pizzint = %+v", snapshot.Pizzint)
	}
}

func TestEmptyInsightSnapshotSerializesEmptyArrays(t *testing.T) {
	raw, err := json.Marshal(emptyInsightSnapshot())
	if err != nil {
		t.Fatal(err)
	}
	want := `{"keywordSpikes":[],"predictionLeads":[],"tensions":[]}`
	if string(raw) != want {
		t.Fatalf("empty insight = %s, want %s", raw, want)
	}
}

func TestSourceOrderMatchesNest(t *testing.T) {
	want := []SignalSource{
		SourceOpensky, SourceAis, SourceUnrest, SourceOutages,
		SourceKeywordSpike, SourcePizzint, SourceGdeltTension, SourcePolymarketLeads,
	}
	if len(sourceOrder) != len(want) {
		t.Fatalf("sourceOrder length = %d", len(sourceOrder))
	}
	for index := range want {
		if sourceOrder[index] != want[index] {
			t.Fatalf("sourceOrder[%d] = %s, want %s", index, sourceOrder[index], want[index])
		}
	}
}
