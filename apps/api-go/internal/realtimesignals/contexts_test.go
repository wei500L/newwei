package realtimesignals

import (
	"encoding/json"
	"testing"
)

// The stored context documents are read by the alert worker and the diagnostics
// endpoint, and the member order is part of the JSON contract. These snapshots
// fail when a field is added, removed or reordered.

func TestOpenSkyMetricContextJSONShape(t *testing.T) {
	age := 1.0
	observedAge := 2.0
	context := &openSkyMetricContext{
		Source: "opensky", SourceEndpoint: "endpoint", Scope: "military", Configured: true,
		AuthRequired: true, AuthMode: "oauth2_client_credentials",
		TotalAircraft: 2, MilitaryCount: 2, ValidPositionCount: 2, SnapshotValidPositionCount: 2,
		LatestObservedAt: "2026-10-20T12:00:00.000Z", SnapshotUpdatedAt: "2026-10-20T12:00:00.000Z",
		SnapshotFreshness: "fresh", SnapshotAgeSec: &age, LatestObservedAgeSec: &observedAge,
		StaleThresholdSec: 600,
		CountryCodes:      []string{"US"},
		openSkyBudgetContext: openSkyBudgetContext{
			DateHKT: "2026-10-20", DailyCreditBudget: 4000, UsedCredits: 24, RemainingCredits: 3976,
			UsagePct: 0.6, CurrentPeriod: "day", EffectiveIntervalSec: 600,
			BudgetDegradation: "normal", AllModeBlocked: false, MilitaryPaused: false,
		},
	}
	raw, err := json.Marshal(context)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"source":"opensky","sourceEndpoint":"endpoint","scope":"military","configured":true,` +
		`"authRequired":true,"authMode":"oauth2_client_credentials","totalAircraft":2,"militaryCount":2,` +
		`"validPositionCount":2,"snapshotValidPositionCount":2,"latestObservedAt":"2026-10-20T12:00:00.000Z",` +
		`"snapshotUpdatedAt":"2026-10-20T12:00:00.000Z","snapshotFreshness":"fresh","snapshotAgeSec":1,` +
		`"latestObservedAgeSec":2,"snapshotRetainedPrevious":false,"staleThresholdSec":600,` +
		`"droppedInvalidPositionCount":0,"droppedMissingIdentityCount":0,"droppedStalePositionCount":0,` +
		`"deduplicatedCount":0,"countryCodes":["US"],"dateHkt":"2026-10-20","dailyCreditBudget":4000,` +
		`"usedCredits":24,"remainingCredits":3976,"usagePct":0.6,"currentPeriod":"day",` +
		`"effectiveIntervalSec":600,"budgetDegradation":"normal","allModeBlocked":false,"militaryPaused":false}`
	if string(raw) != want {
		t.Fatalf("opensky metric context =\n%s\nwant\n%s", raw, want)
	}
}

func TestOpenSkyBudgetFailureFieldsAppendLast(t *testing.T) {
	context := &openSkyMetricContext{
		Source: "opensky", SourceEndpoint: "endpoint", Scope: "military", Configured: true,
		AuthRequired: true, AuthMode: "oauth2_client_credentials",
		openSkyBudgetContext:         openSkyBudgetContext{DateHKT: "2026-10-20"},
		BudgetReservationFailed:      true,
		BudgetReservationFailureCode: "opensky_budget_insufficient_credits",
	}
	raw, err := json.Marshal(context)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if text[len(text)-len(`"budgetReservationFailed":true,"budgetReservationFailureCode":"opensky_budget_insufficient_credits"}`):] != `"budgetReservationFailed":true,"budgetReservationFailureCode":"opensky_budget_insufficient_credits"}` {
		t.Fatalf("failure fields are not last: %s", text)
	}
}

func TestAisContextJSONShape(t *testing.T) {
	raw, err := json.Marshal(&aisContext{Source: "relay", Configured: true, CountryCodes: []string{"IRN"}})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"source":"relay","configured":true,"countryCodes":["IRN"]}`
	if string(raw) != want {
		t.Fatalf("ais context = %s, want %s", raw, want)
	}
}

func TestUnrestContextJSONShape(t *testing.T) {
	gdeltError := "boom"
	raw, err := json.Marshal(&unrestContext{
		Source: "acled+gdelt", UnrestCount: 2, ACLEDCount: 1, GDELTCount: 2, DedupeReducedBy: 1,
		ACLEDConfigured: true, ACLEDAPIEnabled: true, ACLEDAPIDisabledReason: "disabled",
		UnrestMode: "acled_gdelt", CountryCodes: []string{"IRN"},
		FeedErrors: unrestFeedErrors{ACLED: nil, GDELT: &gdeltError},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"source":"acled+gdelt","unrestCount":2,"acledCount":1,"gdeltCount":2,"dedupeReducedBy":1,` +
		`"acledConfigured":true,"acledApiEnabled":true,"acledApiDisabledReason":"disabled",` +
		`"unrestMode":"acled_gdelt","countryCodes":["IRN"],"feedErrors":{"acled":null,"gdelt":"boom"}}`
	if string(raw) != want {
		t.Fatalf("unrest context = %s\nwant %s", raw, want)
	}
}

func TestOutagesContextJSONShapes(t *testing.T) {
	missing, err := json.Marshal(&outagesNotConfiguredContext{Configured: false, Source: "cloudflare"})
	if err != nil {
		t.Fatal(err)
	}
	if string(missing) != `{"configured":false,"source":"cloudflare"}` {
		t.Fatalf("outages not configured = %s", missing)
	}
	present, err := json.Marshal(&outagesContext{Source: "cloudflare", Outages: 2, CountryCodes: []string{"IRN"}})
	if err != nil {
		t.Fatal(err)
	}
	if string(present) != `{"source":"cloudflare","outages":2,"countryCodes":["IRN"]}` {
		t.Fatalf("outages = %s", present)
	}
}

func TestKeywordAndPizzintContextJSONShape(t *testing.T) {
	keyword, err := json.Marshal(&keywordSpikeContext{
		Source: "internal", RecentArticleCount: 6, BaselineArticleCount: 0,
		Spikes: []KeywordSpike{{ID: "keyword:taiwan", Term: "taiwan", Count: 6, Baseline: 0, Multiplier: 6, SourceCount: 2, Confidence: 0.95}},
	})
	if err != nil {
		t.Fatal(err)
	}
	wantKeyword := `{"source":"internal","recentArticleCount":6,"baselineArticleCount":0,"spikes":[` +
		`{"id":"keyword:taiwan","term":"taiwan","count":6,"baseline":0,"multiplier":6,"sourceCount":2,"confidence":0.95}]}`
	if string(keyword) != wantKeyword {
		t.Fatalf("keyword context = %s\nwant %s", keyword, wantKeyword)
	}
	pizzint, err := json.Marshal(&pizzintContext{
		Source: "pizzint", Defcon: 2, AdjustedScore: 88.5, OpenLocations: 12, ActiveSpikes: 3, AvgPop: 58.5,
	})
	if err != nil {
		t.Fatal(err)
	}
	wantPizzint := `{"source":"pizzint","defcon":2,"adjustedScore":88.5,"openLocations":12,"activeSpikes":3,"avgPop":58.5}`
	if string(pizzint) != wantPizzint {
		t.Fatalf("pizzint context = %s\nwant %s", pizzint, wantPizzint)
	}
}

func TestTensionAndPolymarketContextJSONShape(t *testing.T) {
	tension, err := json.Marshal(&gdeltTensionContext{
		Source: "pizzint-gdelt",
		Tensions: []TensionRow{{
			ID: "gdelt:usa_russia", Label: "USA / RUSSIA", Score: 75, ChangePercent: 25,
			Trend: "rising", Countries: []string{"US", "RU"}, UpdatedAt: "2026-10-20",
		}},
		CountryCodes: []string{"US", "RU"},
		DateStart:    "20261013", DateEnd: "20261020",
	})
	if err != nil {
		t.Fatal(err)
	}
	wantTension := `{"source":"pizzint-gdelt","tensions":[{"id":"gdelt:usa_russia","label":"USA / RUSSIA",` +
		`"score":75,"changePercent":25,"trend":"rising","countries":["US","RU"],"updatedAt":"2026-10-20"}],` +
		`"countryCodes":["US","RU"],"dateStart":"20261013","dateEnd":"20261020"}`
	if string(tension) != wantTension {
		t.Fatalf("tension context = %s\nwant %s", tension, wantTension)
	}
	polymarket, err := json.Marshal(&polymarketContext{
		Source: "gamma-api",
		Leads:  []PredictionLead{{ID: "evt-1", Title: "Election", Shift: 40, NewsActivity: 0, Confidence: 0.9}},
	})
	if err != nil {
		t.Fatal(err)
	}
	wantPolymarket := `{"source":"gamma-api","leads":[{"id":"evt-1","title":"Election","shift":40,"newsActivity":0,"confidence":0.9}]}`
	if string(polymarket) != wantPolymarket {
		t.Fatalf("polymarket context = %s\nwant %s", polymarket, wantPolymarket)
	}
}
