package realtimesignals

import (
	"encoding/json"
	"math"
	"testing"
	"time"
)

func TestParseAisSnapshotNormalizesTheRelayContract(t *testing.T) {
	payload := json.RawMessage(`{
		"timestamp":"2026-10-20T12:00:00.000Z",
		"status":{"connected":true,"vessels":12,"messages":"120","clients":3,"droppedMessages":1},
		"diagnostics":{"healthState":"degraded","statusReasonCode":"ais_upstream_stalled","positionReportsSeen":10,"parseErrors":2},
		"disruptions":[{"id":"d1","name":"Hormuz","type":"chokepoint","lat":26.5,"lon":56.2,"severity":"MEDIUM","changePct":"12.5","darkShips":3,"region":"Iran"}],
		"density":[{"lat":1,"lng":2,"intensity":1.5,"shipsPerDay":10}],
		"candidateReports":[{"mmsi":123456789,"lat":1,"lng":2,"shipType":55,"name":"SHIP","observedAt":"2026-10-20T11:00:00.000Z"}],
		"vessels":[{"MMSI":"987654321","lat":3,"lon":4}]
	}`)
	snapshot, err := parseAisSnapshot(payload, "http://relay/ais/snapshot")
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.UpdatedAt != "2026-10-20T12:00:00.000Z" || snapshot.SourceEndpoint != "http://relay/ais/snapshot" {
		t.Fatalf("snapshot header = %+v", snapshot)
	}
	if !snapshot.Status.Connected || snapshot.Status.Vessels != 12 || snapshot.Status.Messages != 120 {
		t.Fatalf("status = %+v", snapshot.Status)
	}
	if snapshot.Diagnostics.HealthState != "degraded" || snapshot.Diagnostics.StatusReasonCode != "ais_upstream_stalled" {
		t.Fatalf("diagnostics = %+v", snapshot.Diagnostics)
	}
	if len(snapshot.Disruptions) != 1 {
		t.Fatalf("disruptions = %+v", snapshot.Disruptions)
	}
	disruption := snapshot.Disruptions[0]
	if disruption.ID != "d1" || disruption.Severity != "elevated" || disruption.ChangePct == nil || *disruption.ChangePct != 12.5 {
		t.Fatalf("disruption = %+v", disruption)
	}
	if len(snapshot.Density) != 1 || snapshot.Density[0].ID != "ais-density-1" || snapshot.Density[0].Intensity != 1 {
		t.Fatalf("density = %+v", snapshot.Density)
	}
	if len(snapshot.CandidateReports) != 1 || snapshot.CandidateReports[0].MMSI != "123456789" || snapshot.CandidateReports[0].ShipType == nil {
		t.Fatalf("candidates = %+v", snapshot.CandidateReports)
	}
	if len(snapshot.Vessels) != 1 || snapshot.Vessels[0].MMSI != "987654321" || !snapshot.HasVesselSnapshot {
		t.Fatalf("vessels = %+v", snapshot.Vessels)
	}
}

func TestParseAisSnapshotRejectsMissingArrays(t *testing.T) {
	if _, err := parseAisSnapshot(json.RawMessage(`{"density":[]}`), "http://relay/ais/snapshot"); err == nil {
		t.Fatal("missing disruptions[] must fail")
	}
	if _, err := parseAisSnapshot(json.RawMessage(`[]`), "http://relay/ais/snapshot"); err == nil {
		t.Fatal("a non-object payload must fail")
	}
}

func TestParseTensionPayloadUsesDataContainer(t *testing.T) {
	service := &Service{now: func() time.Time { return time.UnixMilli(1_700_000_000_000) }}
	rows := parseTensionPayload(json.RawMessage(`{
		"data":{
			"usa_russia":[{"t":"2026-10-13","v":10},{"t":"2026-10-20","v":12}],
			"usa_china":[{"date":"2026-10-20","score":5}]
		}
	}`))
	if len(rows) != 2 {
		t.Fatalf("rows = %+v", rows)
	}
	if rows[0].ID != "gdelt:usa_russia" || rows[0].Score != 12 || rows[0].Trend != "rising" || rows[0].ChangePercent != 20 {
		t.Fatalf("first row = %+v", rows[0])
	}
	if rows[0].Label != "USA / RUSSIA" || len(rows[0].Countries) != 2 || rows[0].Countries[0] != "US" || rows[0].Countries[1] != "RU" {
		t.Fatalf("first row labels = %+v", rows[0])
	}
	if rows[1].ID != "gdelt:usa_china" || rows[1].Score != 5 || rows[1].Trend != "stable" || rows[1].UpdatedAt != "2026-10-20" {
		t.Fatalf("second row = %+v", rows[1])
	}
	_ = service
}

func TestMergeUnrestEventsPrefersAcledAndMaxReports(t *testing.T) {
	occurred := "2026-10-20T10:00:00.000Z"
	acled := []UnrestEvent{{
		ID: "acled-1", Lat: 10.04, Lon: 20.04, OccurredAt: occurred, Source: "acled", CountryCode: "IRN", Reports: 2,
	}}
	gdelt := []UnrestEvent{{
		ID: "gdelt-1", Lat: 10.0, Lon: 20.0, OccurredAt: occurred, Source: "gdelt", Reports: 5,
	}}
	merged := mergeUnrestEvents(acled, gdelt)
	if len(merged) != 1 {
		t.Fatalf("merged = %+v", merged)
	}
	if merged[0].Source != "acled" || merged[0].Reports != 5 || merged[0].CountryCode != "IRN" {
		t.Fatalf("merged event = %+v", merged[0])
	}
	if key := buildUnrestMergeKey(merged[0]); key != "10:20:2026-10-20" {
		t.Fatalf("merge key = %s", key)
	}
}

func TestExtractProcessedArticleTerms(t *testing.T) {
	article := processedArticleRow{
		Title:   "Breaking: China Taiwan tensions rise",
		Summary: "china taiwan report",
		Source:  " Reuters ",
		Topics:  json.RawMessage(`["market",{"name":"Taiwan"},{"label":"Semiconductors"}]`),
	}
	terms := extractProcessedArticleTerms(article)
	seen := map[string]bool{}
	for _, term := range terms {
		seen[term] = true
	}
	for _, want := range []string{"china", "taiwan", "tensions", "rise", "semiconductors"} {
		if !seen[want] {
			t.Fatalf("missing term %q in %v", want, terms)
		}
	}
	if seen["breaking"] || seen["report"] || seen["market"] {
		t.Fatalf("stopword retained in %v", terms)
	}
	if got := normalizeProcessedArticleSource(article.Source); got != "reuters" {
		t.Fatalf("source = %s", got)
	}
}

func TestResolvePolymarketYesPrice(t *testing.T) {
	if value, ok := resolvePolymarketYesPrice(polymarketEventPayload{
		Markets: json.RawMessage(`[{"yesPrice":0.42}]`),
	}); !ok || value != 42 {
		t.Fatalf("market yesPrice = %v/%t", value, ok)
	}
	if value, ok := resolvePolymarketYesPrice(polymarketEventPayload{
		Markets: json.RawMessage(`[{"lastTradePrice":0.55}]`),
	}); !ok || math.Abs(value-55) > 1e-9 {
		t.Fatalf("market lastTradePrice = %v/%t", value, ok)
	}
	if value, ok := resolvePolymarketYesPrice(polymarketEventPayload{
		Markets: json.RawMessage(`[{"outcomePrice":70}]`),
	}); !ok || value != 70 {
		t.Fatalf("market outcomePrice = %v/%t", value, ok)
	}
	if value, ok := resolvePolymarketYesPrice(polymarketEventPayload{
		Probability: json.RawMessage(`0.3`),
	}); !ok || value != 30 {
		t.Fatalf("direct probability = %v/%t", value, ok)
	}
	if _, ok := resolvePolymarketYesPrice(polymarketEventPayload{}); ok {
		t.Fatal("an event without a price must not resolve")
	}
}

func TestPolymarketActiveUsesStrictBooleans(t *testing.T) {
	cases := []struct {
		active, closed string
		want           bool
	}{
		{``, ``, true},
		{`false`, ``, false},
		{`"false"`, ``, true}, // a string is not the boolean false
		{`true`, `true`, false},
		{`true`, `"true"`, true},
	}
	for _, testCase := range cases {
		got := polymarketEventActive(jsonRawMessage(testCase.active), jsonRawMessage(testCase.closed))
		if got != testCase.want {
			t.Fatalf("active(%s,%s) = %t, want %t", testCase.active, testCase.closed, got, testCase.want)
		}
	}
}

func TestExtractTopicTokens(t *testing.T) {
	tokens := extractTopicTokens("Will China invade Taiwan by 2026?")
	want := []string{"china", "invade", "taiwan", "2026"}
	if len(tokens) != len(want) {
		t.Fatalf("tokens = %v", tokens)
	}
	for index := range want {
		if tokens[index] != want[index] {
			t.Fatalf("tokens = %v, want %v", tokens, want)
		}
	}
}

func TestNormalizeAdsbAircraftSnapshot(t *testing.T) {
	raw := json.RawMessage(`["abc123","RCH1","United States",1700000000,1700000000,10,20,10000,false,250,90,0,0,10000,null,false,0]`)
	fetchedAt := int64(1700000000_000)
	aircraft, reason, ok := normalizeAdsbAircraftSnapshot(raw, fetchedAt, 600)
	if !ok || reason != "" {
		t.Fatalf("normalize = %+v/%s/%t", aircraft, reason, ok)
	}
	if aircraft.ID != "abc123" || aircraft.ICAO24 != "abc123" || aircraft.Callsign != "RCH1" {
		t.Fatalf("identity = %+v", aircraft)
	}
	if aircraft.Lat != 20 || aircraft.Lng != 10 || aircraft.CountryCode != "US" || aircraft.CountryName != "United States" {
		t.Fatalf("position/country = %+v", aircraft)
	}
	if aircraft.Heading == nil || *aircraft.Heading != 90 {
		t.Fatalf("heading = %+v", aircraft.Heading)
	}
	if aircraft.AltitudeFt == nil || *aircraft.AltitudeFt != 32808 {
		t.Fatalf("altitude = %+v", aircraft.AltitudeFt)
	}
	if aircraft.GroundSpeedKt == nil || *aircraft.GroundSpeedKt != 486 {
		t.Fatalf("speed = %+v", aircraft.GroundSpeedKt)
	}
	if aircraft.ObservedAt != formatISO(fetchedAt) {
		t.Fatalf("observedAt = %s", aircraft.ObservedAt)
	}

	badPosition := json.RawMessage(`["abc123",null,null,1700000000,1700000000,10,95]`)
	if _, reason, ok := normalizeAdsbAircraftSnapshot(badPosition, fetchedAt, 600); ok || reason != "invalid_position" {
		t.Fatalf("out of range position = %s/%t", reason, ok)
	}

	stale := json.RawMessage(`["abc123",null,null,1600000000,1600000000,10,20]`)
	if _, reason, ok := normalizeAdsbAircraftSnapshot(stale, fetchedAt, 600); ok || reason != "stale_position" {
		t.Fatalf("stale position = %s/%t", reason, ok)
	}
}

func TestBuildAdsbLatestSnapshotDiagnostics(t *testing.T) {
	fetchedAt := int64(1700000000_000)
	raws := []jsonRawMessage{
		json.RawMessage(`["abc123","RCH1","United States",1700000000,1700000000,10,20]`),
		json.RawMessage(`["abc123","RCH1","United States",1700000000,1700000000,10,20]`),
		json.RawMessage(`["def456",null,null,1700000000,1700000000,11,21]`),
		json.RawMessage(`["ghi789",null,null,1700000000,1700000000,200,95]`),
	}
	snapshot := buildAdsbLatestSnapshot("http://opensky/states/all", raws, len(raws), fetchedAt, 600)
	if snapshot.TotalAircraft != 4 || snapshot.ValidPositionCount != 2 || len(snapshot.Aircraft) != 2 {
		t.Fatalf("snapshot counts = %+v", snapshot)
	}
	if snapshot.Diagnostics.DeduplicatedCount != 1 || snapshot.Diagnostics.DroppedInvalidPositionCount != 1 {
		t.Fatalf("snapshot diagnostics = %+v", snapshot.Diagnostics)
	}
	if snapshot.LatestObservedAt == "" || snapshot.Diagnostics.OldestObservedAt == "" {
		t.Fatalf("observed bounds = %+v", snapshot)
	}
}
