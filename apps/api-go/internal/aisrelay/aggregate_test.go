package aisrelay

import (
	"math"
	"strconv"
	"testing"
	"time"
)

// Aggregation contract. Expected values are derived from the Node implementation
// (cleanupAggregates / detectDisruptions / calculateDensityZones / buildSnapshot) and
// from the ECMAScript helpers in this package, not from running the Node relay.

// relayTestBaseMillis is 2023-11-14T22:13:20.000Z, a round millisecond timestamp that
// makes the ISO expectations readable.
const relayTestBaseMillis int64 = 1700000000000

// relayTestClock drives the injectable aggregation clock.
type relayTestClock struct {
	millis int64
}

func (c *relayTestClock) now() time.Time {
	return time.UnixMilli(c.millis)
}

func (c *relayTestClock) set(millis int64) {
	c.millis = millis
}

func (c *relayTestClock) advance(duration time.Duration) {
	c.millis += duration.Milliseconds()
}

// relayTestConfig mirrors the defaults LoadConfig resolves.
func relayTestConfig() Config {
	return Config{
		UpstreamURL:                     "ws://upstream.test/stream",
		UpstreamAPIKey:                  "test-key",
		ListenHost:                      "0.0.0.0",
		ListenPort:                      3004,
		SnapshotCacheTTL:                5 * time.Second,
		UpstreamQueueHardCap:            8000,
		UpstreamDrainBatch:              250,
		UpstreamDrainBudget:             20 * time.Millisecond,
		HealthMinPositionReports:        25,
		HealthMaxIgnoredRatioPercent:    85,
		HealthMaxParseErrorRatioPercent: 20,
		HealthNoMessagesAfterConnect:    60 * time.Second,
		HealthStaleMessages:             90 * time.Second,
		MaxVessels:                      20000,
		MaxVesselHistory:                20000,
		MaxCandidateReports:             1500,
	}
}

// relayTestEngine builds an engine whose clock starts at the given millisecond value.
func relayTestEngine(t *testing.T, clock *relayTestClock) *engine {
	t.Helper()
	return newEngine(relayTestConfig(), clock.now)
}

// relayTestFeed folds one raw upstream payload through the real parsing path.
func relayTestFeed(t *testing.T, target *engine, payload string) {
	t.Helper()
	target.processRawMessageLocked([]byte(payload))
}

// relayTestPositionReport renders the AISStream envelope used throughout the tests.
func relayTestPositionReport(mmsi int, name string, shipType int, lat float64, lon float64, extra string) string {
	return `{"MessageType":"PositionReport","MetaData":{"MMSI":` + relayTestJSONNumber(mmsi) +
		relayTestJSONStringField("ShipName", name) +
		relayTestJSONNumberField("ShipType", shipType) +
		`,"latitude":` + relayTestJSONFloat(lat) + `,"longitude":` + relayTestJSONFloat(lon) + `}` +
		`,"Message":{"PositionReport":{"Latitude":` + relayTestJSONFloat(lat) +
		`,"Longitude":` + relayTestJSONFloat(lon) + extra + `}}}`
}

func relayTestJSONNumber(value int) string {
	return strconv.Itoa(value)
}

func relayTestJSONFloat(value float64) string {
	return jsNumberString(value)
}

func relayTestJSONStringField(key string, value string) string {
	if value == "" {
		return ""
	}
	return `,"` + key + `":"` + value + `"`
}

func relayTestJSONNumberField(key string, value int) string {
	if value == 0 {
		return ""
	}
	return `,"` + key + `":` + relayTestJSONNumber(value)
}

// TestAggregateSnapshotJSONIsByteExact pins the entire serialised snapshot for a fixed
// message sequence.
//
// The scenario is arranged so that every aggregation branch produces output:
//   - seven vessels, two of which are military candidates (ShipType 35 and 52 and a naval
//     name), so candidateReports is non-empty,
//   - four vessels share the 2-degree grid cell "26,56", so the density zone is eligible
//     (a cell needs >= 2 vessels) while the other cells stay below the threshold,
//   - five vessels sit within the 2-degree radius of the Strait of Hormuz chokepoint, so a
//     chokepoint congestion disruption is emitted,
//   - every vessel has the same millisecond timestamp, so the stable sorts fall back to
//     JS Map insertion order.
//
// Clock layout: the engine is created at T-120s (which becomes lastHealthyAt), the
// upstream handshake completes at T-60s (lastConnectedAt), and all seven reports arrive at
// T = 2023-11-14T22:13:20.000Z (lastMessageAt, snapshot timestamp).
func TestAggregateSnapshotJSONIsByteExact(t *testing.T) {
	clock := &relayTestClock{millis: relayTestBaseMillis - 120_000}
	target := relayTestEngine(t, clock)

	clock.set(relayTestBaseMillis - 60_000)
	target.markUpstreamOpen()

	clock.set(relayTestBaseMillis)
	payloads := []string{
		// Candidate via ShipType 35 and the USS prefix, with every optional position field.
		relayTestPositionReport(111111111, "USS Test", 35, -0.5, -0.5, `,"TrueHeading":88,"Sog":12.5,"Cog":90`),
		relayTestPositionReport(222222222, "Cargo One", 70, 1.5, 1.5, ""),
		// Candidate via ShipType 52, without a name.
		relayTestPositionReport(333333333, "", 52, 26.5, 56.5, ""),
		relayTestPositionReport(444444444, "Merchant", 0, 26.6, 56.6, ""),
		relayTestPositionReport(555555555, "", 0, 27, 56, ""),
		relayTestPositionReport(666666666, "", 0, 25.5, 57.5, ""),
		relayTestPositionReport(777777777, "", 0, 26, 57, ""),
	}
	for _, payload := range payloads {
		relayTestFeed(t, target, payload)
	}

	if target.positionReportsSeen != 7 || target.positionReportsProcessed != 7 || target.ignoredPositionReports != 0 {
		t.Fatalf("counters = seen %d, processed %d, ignored %d; want 7/7/0",
			target.positionReportsSeen, target.positionReportsProcessed, target.ignoredPositionReports)
	}

	target.buildSnapshotLocked()

	// Derivation of every literal below:
	//   sequence            1 (first rebuild)
	//   timestamp           T
	//   status.connected    state is connOpen after markUpstreamOpen
	//   status.vessels      7 retained vessels
	//   status.messages     7 accepted upstream payloads
	//   status.clients      constant 0 in the Node payload
	//   diagnostics         healthState ok: connected, messages arrived after the
	//                       handshake, 7 reports are below the 25-report sample floor,
	//                       no parse errors; lastIssueAt is absent because the relay was
	//                       never degraded
	//   disruptions         Hormuz holds 5 vessels (radius 2 around 26.5/56.5), which is
	//                       above the minimum of 5; normalTraffic = radius*10 = 20, so
	//                       5 > 30 is false and 5 > 20 is false -> severity "low";
	//                       changePct = round((5/20 - 1)*100) = -75
	//   density             only cell "26,56" reaches 2 vessels (it holds 4). min == max == 4
	//                       makes logMax == logMin, so intensity falls back to 0.5;
	//                       previousCount is 0 on the first build, so deltaPct = 0;
	//                       shipsPerDay = 4*48 = 192; note is omitted below 10 vessels
	//   candidateReports    111111111 (USS prefix) and 333333333 (ShipType 52), newest first
	//                       with stable insertion order on equal timestamps
	//   vessels             all seven, insertion order preserved by the stable sort
	const wantWithCandidates = `{"sequence":1,"timestamp":"2023-11-14T22:13:20.000Z",` +
		`"status":{"connected":true,"vessels":7,"messages":7,"clients":0,"droppedMessages":0},` +
		`"diagnostics":{"healthState":"ok","positionReportsSeen":7,"positionReportsProcessed":7,` +
		`"ignoredPositionReports":0,"parseErrors":0,` +
		`"lastHealthyAt":"2023-11-14T22:11:20.000Z","lastConnectedAt":"2023-11-14T22:12:20.000Z",` +
		`"lastMessageAt":"2023-11-14T22:13:20.000Z"},` +
		`"disruptions":[{"id":"chokepoint-strait-of-hormuz","name":"Strait of Hormuz",` +
		`"type":"chokepoint_congestion","lat":26.5,"lon":56.5,"severity":"low","changePct":-75,` +
		`"windowHours":1,"vesselCount":5,"region":"Strait of Hormuz",` +
		`"description":"5 vessels in Strait of Hormuz"}],` +
		`"density":[{"id":"density-26,56","name":"Zone 26,56","lat":27,"lon":57,` +
		`"intensity":0.5,"deltaPct":0,"shipsPerDay":192}],` +
		`"candidateReports":[` +
		`{"mmsi":"111111111","name":"USS Test","lat":-0.5,"lon":-0.5,"shipType":35,` +
		`"heading":88,"speed":12.5,"course":90,"timestamp":1700000000000},` +
		`{"mmsi":"333333333","lat":26.5,"lon":56.5,"shipType":52,"timestamp":1700000000000}],` +
		`"vessels":[` +
		`{"mmsi":"111111111","name":"USS Test","lat":-0.5,"lon":-0.5,"shipType":35,` +
		`"heading":88,"speed":12.5,"course":90,"timestamp":1700000000000},` +
		`{"mmsi":"222222222","name":"Cargo One","lat":1.5,"lon":1.5,"shipType":70,` +
		`"timestamp":1700000000000},` +
		`{"mmsi":"333333333","lat":26.5,"lon":56.5,"shipType":52,"timestamp":1700000000000},` +
		`{"mmsi":"444444444","name":"Merchant","lat":26.6,"lon":56.6,"timestamp":1700000000000},` +
		`{"mmsi":"555555555","lat":27,"lon":56,"timestamp":1700000000000},` +
		`{"mmsi":"666666666","lat":25.5,"lon":57.5,"timestamp":1700000000000},` +
		`{"mmsi":"777777777","lat":26,"lon":57,"timestamp":1700000000000}]}`

	if got := string(target.lastSnapshotJSONWithCandidates); got != wantWithCandidates {
		t.Fatalf("snapshot JSON mismatch\n got: %s\nwant: %s", got, wantWithCandidates)
	}

	// The candidates=false variant is the same payload with an empty candidate array, which
	// is the second cached body the HTTP handler serves.
	wantWithoutCandidates := `{"sequence":1,"timestamp":"2023-11-14T22:13:20.000Z",` +
		`"status":{"connected":true,"vessels":7,"messages":7,"clients":0,"droppedMessages":0},` +
		`"diagnostics":{"healthState":"ok","positionReportsSeen":7,"positionReportsProcessed":7,` +
		`"ignoredPositionReports":0,"parseErrors":0,` +
		`"lastHealthyAt":"2023-11-14T22:11:20.000Z","lastConnectedAt":"2023-11-14T22:12:20.000Z",` +
		`"lastMessageAt":"2023-11-14T22:13:20.000Z"},` +
		`"disruptions":[{"id":"chokepoint-strait-of-hormuz","name":"Strait of Hormuz",` +
		`"type":"chokepoint_congestion","lat":26.5,"lon":56.5,"severity":"low","changePct":-75,` +
		`"windowHours":1,"vesselCount":5,"region":"Strait of Hormuz",` +
		`"description":"5 vessels in Strait of Hormuz"}],` +
		`"density":[{"id":"density-26,56","name":"Zone 26,56","lat":27,"lon":57,` +
		`"intensity":0.5,"deltaPct":0,"shipsPerDay":192}],` +
		`"candidateReports":[],` +
		`"vessels":[` +
		`{"mmsi":"111111111","name":"USS Test","lat":-0.5,"lon":-0.5,"shipType":35,` +
		`"heading":88,"speed":12.5,"course":90,"timestamp":1700000000000},` +
		`{"mmsi":"222222222","name":"Cargo One","lat":1.5,"lon":1.5,"shipType":70,` +
		`"timestamp":1700000000000},` +
		`{"mmsi":"333333333","lat":26.5,"lon":56.5,"shipType":52,"timestamp":1700000000000},` +
		`{"mmsi":"444444444","name":"Merchant","lat":26.6,"lon":56.6,"timestamp":1700000000000},` +
		`{"mmsi":"555555555","lat":27,"lon":56,"timestamp":1700000000000},` +
		`{"mmsi":"666666666","lat":25.5,"lon":57.5,"timestamp":1700000000000},` +
		`{"mmsi":"777777777","lat":26,"lon":57,"timestamp":1700000000000}]}`

	if got := string(target.lastSnapshotJSONWithoutCandidates); got != wantWithoutCandidates {
		t.Fatalf("snapshot JSON without candidates mismatch\n got: %s\nwant: %s", got, wantWithoutCandidates)
	}
}

func TestAggregateGridKeyMatchesJSRounding(t *testing.T) {
	cases := []struct {
		name string
		lat  float64
		lon  float64
		want string
	}{
		// Math.floor(lat/2)*2 in both axes.
		{"positive quadrant", 26.5, 56.5, "26,56"},
		{"negative quadrant", -0.5, -0.5, "-2,-2"},
		{"exact grid multiple", 2, 4, "2,4"},
		{"crosses to the next cell at the boundary", 26.6, 56.6, "26,56"},
		{"mixed signs", -34.36, 18.49, "-36,18"},
		// Math.floor(-0/2)*2 is -0 and JS renders it as "0", so a negative-zero coordinate
		// must not produce the key "-0,-0".
		{"negative zero", math.Copysign(0, -1), math.Copysign(0, -1), "0,0"},
		{"zero", 0, 0, "0,0"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := gridKeyOf(testCase.lat, testCase.lon); got != testCase.want {
				t.Fatalf("gridKeyOf(%v, %v) = %q, want %q", testCase.lat, testCase.lon, got, testCase.want)
			}
		})
	}
}

func TestAggregateVesselOrderingIsNewestFirstWithStableTies(t *testing.T) {
	clock := &relayTestClock{millis: relayTestBaseMillis}
	target := relayTestEngine(t, clock)
	target.markUpstreamOpen()

	relayTestFeed(t, target, relayTestPositionReport(111, "First", 0, 1, 1, ""))
	clock.advance(time.Second)
	relayTestFeed(t, target, relayTestPositionReport(222, "Second", 0, 3, 3, ""))
	clock.advance(time.Second)
	relayTestFeed(t, target, relayTestPositionReport(333, "Third", 0, 5, 5, ""))

	target.buildSnapshotLocked()
	if got := relayTestVesselMMSIs(target.lastSnapshot.Vessels); got != "333,222,111" {
		t.Fatalf("vessel order = %s, want newest first 333,222,111", got)
	}

	// Re-reporting an existing MMSI updates the value but keeps the JS Map insertion
	// position; the new timestamp then moves it to the front.
	clock.advance(time.Second)
	relayTestFeed(t, target, relayTestPositionReport(111, "First", 0, 1, 1, ""))

	clock.advance(3 * time.Second)
	target.buildSnapshotLocked()
	if got := relayTestVesselMMSIs(target.lastSnapshot.Vessels); got != "111,333,222" {
		t.Fatalf("vessel order after re-report = %s, want 111,333,222", got)
	}
}

func TestAggregateVesselCapEvictsOldest(t *testing.T) {
	clock := &relayTestClock{millis: relayTestBaseMillis}
	config := relayTestConfig()
	config.MaxVessels = 2
	target := newEngine(config, clock.now)
	target.markUpstreamOpen()

	relayTestFeed(t, target, relayTestPositionReport(111, "Oldest", 0, 1, 1, ""))
	clock.advance(time.Second)
	relayTestFeed(t, target, relayTestPositionReport(222, "Middle", 0, 3, 3, ""))
	clock.advance(time.Second)
	relayTestFeed(t, target, relayTestPositionReport(333, "Newest", 0, 5, 5, ""))

	target.buildSnapshotLocked()

	if target.vessels.Len() != 2 {
		t.Fatalf("retained vessels = %d, want 2", target.vessels.Len())
	}
	if _, ok := target.vessels.Get("111"); ok {
		t.Fatal("oldest vessel was not evicted")
	}
	if got := relayTestVesselMMSIs(target.lastSnapshot.Vessels); got != "333,222" {
		t.Fatalf("vessel order = %s, want 333,222", got)
	}
	// Eviction also removes the vessel from its density cell.
	if _, ok := target.vesselGridKeys.Get("111"); ok {
		t.Fatal("evicted vessel still has a grid key")
	}
	if cell, ok := target.densityGrid.Get("0,0"); ok && cell.vesselIDs.Has("111") {
		t.Fatal("evicted vessel still occupies a density cell")
	}
}

func TestAggregateVesselExpiryAfterDensityWindow(t *testing.T) {
	clock := &relayTestClock{millis: relayTestBaseMillis}
	target := relayTestEngine(t, clock)
	target.markUpstreamOpen()
	relayTestFeed(t, target, relayTestPositionReport(111, "Aging", 0, 1, 1, ""))

	// A vessel stays for exactly the 30 minute density window and is dropped afterwards.
	clock.advance(densityWindow)
	target.cleanupAggregatesLocked()
	if target.vessels.Len() != 1 {
		t.Fatalf("vessel dropped at the window boundary: vessels = %d, want 1", target.vessels.Len())
	}

	clock.advance(time.Millisecond)
	target.cleanupAggregatesLocked()
	if target.vessels.Len() != 0 {
		t.Fatalf("vessel survived past the window: vessels = %d, want 0", target.vessels.Len())
	}
	if target.vesselHistory.Len() != 0 {
		t.Fatalf("history survived past the window: %d", target.vesselHistory.Len())
	}
}

func TestAggregateDensityCellRetention(t *testing.T) {
	clock := &relayTestClock{millis: relayTestBaseMillis}
	target := relayTestEngine(t, clock)
	target.markUpstreamOpen()

	// Two vessels in the same cell make the cell eligible for a density zone.
	// floor(1/2)*2 and floor(1.5/2)*2 are both 0, so both land in cell "0,0".
	relayTestFeed(t, target, relayTestPositionReport(111, "A", 0, 1, 1, ""))
	relayTestFeed(t, target, relayTestPositionReport(222, "B", 0, 1.5, 1.5, ""))
	target.buildSnapshotLocked()
	if len(target.lastSnapshot.Density) != 1 {
		t.Fatalf("density zones = %d, want 1", len(target.lastSnapshot.Density))
	}

	// Once both vessels expire the cell is empty; it is only deleted after two windows have
	// passed since its last update.
	clock.advance(densityWindow + 2*time.Millisecond)
	target.cleanupAggregatesLocked()
	if target.densityGrid.Len() != 1 {
		t.Fatalf("cell deleted too early: density cells = %d, want 1", target.densityGrid.Len())
	}

	clock.advance(densityWindow + time.Millisecond)
	target.cleanupAggregatesLocked()
	if target.densityGrid.Len() != 0 {
		t.Fatalf("idle cell survived: density cells = %d, want 0", target.densityGrid.Len())
	}
}

func TestAggregateDensityDeltaPctUsesPreviousBaseline(t *testing.T) {
	clock := &relayTestClock{millis: relayTestBaseMillis}
	target := relayTestEngine(t, clock)
	target.markUpstreamOpen()

	relayTestFeed(t, target, relayTestPositionReport(111, "A", 0, 1, 1, ""))
	relayTestFeed(t, target, relayTestPositionReport(222, "B", 0, 1.5, 1.5, ""))
	target.buildSnapshotLocked()
	// buildSnapshot refreshes the baseline, so the next build compares against 2 vessels.
	if cell, ok := target.densityGrid.Get("0,0"); !ok || cell.previousCount != 2 {
		t.Fatalf("baseline not refreshed: cell = %+v", cell)
	}

	// Grow the cell to 4 vessels, then force a rebuild past the cache window.
	// Flooring 0.5 and 1.9 by the 2-degree grid both stay inside cell "0,0".
	relayTestFeed(t, target, relayTestPositionReport(333, "C", 0, 0.5, 0.5, ""))
	relayTestFeed(t, target, relayTestPositionReport(444, "D", 0, 1.9, 1.9, ""))
	clock.advance(3 * time.Second) // past floor(TTL/2) = 2.5s
	target.buildSnapshotLocked()

	if len(target.lastSnapshot.Density) != 1 {
		t.Fatalf("density zones = %d, want 1", len(target.lastSnapshot.Density))
	}
	// deltaPct = round(((4 - 2) / 2) * 100) = 100.
	if got := target.lastSnapshot.Density[0].DeltaPct; got != 100 {
		t.Fatalf("deltaPct = %d, want 100", got)
	}
	// Four vessels in one cell: min == max, so the log-normalised intensity is the 0.5
	// fallback rather than a normalised value.
	if got := float64(target.lastSnapshot.Density[0].Intensity); got != 0.5 {
		t.Fatalf("intensity = %v, want 0.5", got)
	}
}

func TestAggregateDensityIntensityNormalisesAcrossCells(t *testing.T) {
	clock := &relayTestClock{millis: relayTestBaseMillis}
	target := relayTestEngine(t, clock)
	target.markUpstreamOpen()

	// Cell "0,0" gets 2 vessels, cell "4,4" gets 5: min = 2, max = 5.
	// floor(1/2)*2 = 0 and floor(1.5/2)*2 = 0, so both land in cell "0,0";
	// floor(5/2)*2 = 4 puts the dense cluster in cell "4,4".
	relayTestFeed(t, target, relayTestPositionReport(111, "A", 0, 1, 1, ""))
	relayTestFeed(t, target, relayTestPositionReport(222, "B", 0, 1.5, 1.5, ""))
	for index := 0; index < 5; index++ {
		mmsi := 500 + index
		relayTestFeed(t, target, relayTestPositionReport(mmsi, "", 0, 5+float64(index)/10, 5+float64(index)/10, ""))
	}
	target.buildSnapshotLocked()

	zones := target.lastSnapshot.Density
	if len(zones) != 2 {
		t.Fatalf("density zones = %d, want 2", len(zones))
	}
	// Sorted by descending intensity, so the denser cell comes first.
	if zones[0].ID != "density-4,4" {
		t.Fatalf("first zone = %s, want density-4,4", zones[0].ID)
	}
	// logMin = ln(3), logMax = ln(6); the 5-vessel cell normalises to 1.0 and the 2-vessel
	// cell to 0.2 + 0 = 0.2.
	if got := float64(zones[0].Intensity); math.Abs(got-1) > 1e-12 {
		t.Fatalf("max cell intensity = %v, want 1", got)
	}
	if got := float64(zones[1].Intensity); math.Abs(got-0.2) > 1e-12 {
		t.Fatalf("min cell intensity = %v, want 0.2", got)
	}
	// notes appear from 10 vessels per cell, which neither cell reaches.
	for _, zone := range zones {
		if zone.Note != nil {
			t.Fatalf("zone %s has an unexpected note %q", zone.ID, *zone.Note)
		}
	}
}

func TestAggregateDensityHighTrafficNote(t *testing.T) {
	clock := &relayTestClock{millis: relayTestBaseMillis}
	target := relayTestEngine(t, clock)
	target.markUpstreamOpen()

	for index := 0; index < 10; index++ {
		mmsi := 900 + index
		relayTestFeed(t, target, relayTestPositionReport(mmsi, "", 0, 1+float64(index)/100, 1+float64(index)/100, ""))
	}
	target.buildSnapshotLocked()

	if len(target.lastSnapshot.Density) != 1 {
		t.Fatalf("density zones = %d, want 1", len(target.lastSnapshot.Density))
	}
	zone := target.lastSnapshot.Density[0]
	if zone.Note == nil || *zone.Note != "High traffic area" {
		t.Fatalf("note = %v, want \"High traffic area\"", zone.Note)
	}
	// shipsPerDay = cellSize * 48.
	if zone.ShipsPerDay != 480 {
		t.Fatalf("shipsPerDay = %d, want 480", zone.ShipsPerDay)
	}
}

// TestAggregateDarkShipDetectionRunsBeforeTheHistoryIsPruned documents a defect that the
// Go port deliberately preserves.
//
// detectDisruptions marks a vessel as a "dark ship" when the two most recent sightings are
// more than 60 minutes apart and the last one is less than 10 minutes old. However
// buildSnapshot calls cleanupAggregates first, and that pass drops every sighting older
// than the 30 minute density window. Two surviving timestamps can therefore never be more
// than 30 minutes apart, so `darkShips` is always 0 and the `global-gap-spike` disruption
// is unreachable through the snapshot path in the Node implementation.
//
// The first half below drives the detector directly to show the logic itself works; the
// second half shows the snapshot path never exposes it. Keeping both halves means the
// behaviour is pinned in both directions and the reason is recorded in code.
func TestAggregateDarkShipDetectionRunsBeforeTheHistoryIsPruned(t *testing.T) {
	clock := &relayTestClock{millis: relayTestBaseMillis}
	target := relayTestEngine(t, clock)
	target.markUpstreamOpen()

	relayTestFeed(t, target, relayTestPositionReport(111, "Silent", 0, 1, 1, ""))
	// A silence longer than the 60 minute gap threshold; the vessel is back right now, so it
	// is inside the 10 minute freshness window.
	clock.advance(gapThreshold + time.Minute)
	relayTestFeed(t, target, relayTestPositionReport(111, "Silent", 0, 1, 1, ""))

	history, ok := target.vesselHistory.Get("111")
	if !ok || len(history) != 2 {
		t.Fatalf("history = %v, want two sightings before cleanup", history)
	}
	if gap := history[1] - history[0]; gap <= gapThreshold.Milliseconds() {
		t.Fatalf("sighting gap = %dms, want more than %dms", gap, gapThreshold.Milliseconds())
	}

	// Direct call: the detector itself does report the gap spike.
	direct := relayTestFindDisruption(target.detectDisruptionsLocked(), "gap_spike")
	if direct == nil {
		t.Fatal("detector did not report a gap spike for a 61 minute silence")
	}
	if direct.DarkShips == nil || *direct.DarkShips != 1 {
		t.Fatalf("darkShips = %v, want 1", direct.DarkShips)
	}
	// severity low for <= 10 dark ships; changePct = count * 10.
	if direct.Severity != "low" {
		t.Fatalf("severity = %q, want low", direct.Severity)
	}
	if direct.ChangePct != 10 {
		t.Fatalf("changePct = %d, want 10", direct.ChangePct)
	}
	if direct.Description != "1 vessels returned after extended AIS silence" {
		t.Fatalf("description = %q", direct.Description)
	}
	// A gap spike carries no chokepoint fields.
	if direct.VesselCount != nil || direct.Region != nil {
		t.Fatalf("gap spike carries chokepoint fields: %+v", direct)
	}

	// Snapshot path: cleanup prunes the older sighting first, so no gap spike appears.
	target.buildSnapshotLocked()
	if spike := relayTestFindDisruption(target.lastSnapshot.Disruptions, "gap_spike"); spike != nil {
		t.Fatalf("snapshot exposed a gap spike (%+v); Node prunes the history before detection", spike)
	}
	pruned, ok := target.vesselHistory.Get("111")
	if !ok || len(pruned) != 1 {
		t.Fatalf("history after cleanup = %v, want a single surviving sighting", pruned)
	}
}

// relayTestFindDisruption returns the first disruption of the given type.
func relayTestFindDisruption(disruptions []disruption, disruptionType string) *disruption {
	for index := range disruptions {
		if disruptions[index].Type == disruptionType {
			return &disruptions[index]
		}
	}
	return nil
}

func TestAggregateSnapshotCacheRespectsHalfTTL(t *testing.T) {
	clock := &relayTestClock{millis: relayTestBaseMillis}
	target := relayTestEngine(t, clock)
	target.markUpstreamOpen()

	first := target.buildSnapshotLocked()
	if first.Sequence != 1 {
		t.Fatalf("sequence = %d, want 1", first.Sequence)
	}

	// Within floor(TTL/2) = 2500ms the cached snapshot is returned unchanged.
	clock.advance(2 * time.Second)
	second := target.buildSnapshotLocked()
	if second != first {
		t.Fatal("snapshot was rebuilt inside the cache window")
	}

	// Past the window the sequence advances.
	clock.advance(time.Second)
	third := target.buildSnapshotLocked()
	if third.Sequence != 2 {
		t.Fatalf("sequence = %d, want 2", third.Sequence)
	}
}

func TestAggregateIgnoredPositionReports(t *testing.T) {
	clock := &relayTestClock{millis: relayTestBaseMillis}
	target := relayTestEngine(t, clock)

	cases := []string{
		// Missing MetaData.
		`{"MessageType":"PositionReport","Message":{"PositionReport":{"Latitude":1,"Longitude":1}}}`,
		// Missing Message.
		`{"MessageType":"PositionReport","MetaData":{"MMSI":111,"latitude":1,"longitude":1}}`,
		// MetaData is an array, which the Node guard rejects.
		`{"MessageType":"PositionReport","MetaData":[1],"Message":{"PositionReport":{"Latitude":1,"Longitude":1}}}`,
		// No usable MMSI.
		`{"MessageType":"PositionReport","MetaData":{"latitude":1,"longitude":1},"Message":{"PositionReport":{"Latitude":1,"Longitude":1}}}`,
		// No usable coordinates.
		`{"MessageType":"PositionReport","MetaData":{"MMSI":111},"Message":{"PositionReport":{}}}`,
	}
	for _, payload := range cases {
		relayTestFeed(t, target, payload)
	}

	if target.positionReportsSeen != len(cases) {
		t.Fatalf("positionReportsSeen = %d, want %d", target.positionReportsSeen, len(cases))
	}
	if target.ignoredPositionReports != len(cases) {
		t.Fatalf("ignoredPositionReports = %d, want %d", target.ignoredPositionReports, len(cases))
	}
	if target.positionReportsProcessed != 0 {
		t.Fatalf("positionReportsProcessed = %d, want 0", target.positionReportsProcessed)
	}
	if target.vessels.Len() != 0 {
		t.Fatalf("retained vessels = %d, want 0", target.vessels.Len())
	}
}

func TestAggregateParseErrorsOnlyCountMalformedJSON(t *testing.T) {
	clock := &relayTestClock{millis: relayTestBaseMillis}
	target := relayTestEngine(t, clock)

	// Malformed JSON is a parse error in both implementations.
	relayTestFeed(t, target, `{"MessageType":`)
	relayTestFeed(t, target, `not json at all`)

	// Valid JSON that is not an object parses in JS and simply has no MessageType, so it
	// must not be counted as a parse error.
	relayTestFeed(t, target, `"just a string"`)
	relayTestFeed(t, target, `[1,2,3]`)
	relayTestFeed(t, target, `null`)

	// Valid objects that are not position reports are counted as messages only.
	relayTestFeed(t, target, `{"MessageType":"StaticDataReport"}`)
	relayTestFeed(t, target, `{"MessageType":" positionreport "}`)

	if target.parseErrors != 2 {
		t.Fatalf("parseErrors = %d, want 2", target.parseErrors)
	}
	if target.messageCount != 7 {
		t.Fatalf("messageCount = %d, want 7", target.messageCount)
	}
	if target.positionReportsSeen != 0 {
		t.Fatalf("positionReportsSeen = %d, want 0", target.positionReportsSeen)
	}
}

func TestAggregateCoordinateFallbackAndMetaFields(t *testing.T) {
	clock := &relayTestClock{millis: relayTestBaseMillis}
	target := relayTestEngine(t, clock)
	target.markUpstreamOpen()

	// PositionReport carries no coordinates, so getNumber falls back to the MetaData
	// latitude/longitude pair. The MMSI arrives as MMSI_String.
	relayTestFeed(t, target, `{"MessageType":"PositionReport",`+
		`"MetaData":{"MMSI_String":" 123456789 ","ShipName":"Fallback","ShipType":70,`+
		`"latitude":-12.5,"longitude":44.25},`+
		`"Message":{"PositionReport":{"TrueHeading":"88","Sog":"12.5","Cog":"90"}}}`)

	vessel, ok := target.vessels.Get("123456789")
	if !ok {
		t.Fatalf("vessel not retained: %v", target.vessels.Keys())
	}
	if vessel.lat != -12.5 || vessel.lon != 44.25 {
		t.Fatalf("coordinates = %v/%v, want -12.5/44.25", vessel.lat, vessel.lon)
	}
	if vessel.heading == nil || *vessel.heading != 88 {
		t.Fatalf("heading = %v, want 88 (numeric string accepted)", vessel.heading)
	}
	if vessel.speed == nil || *vessel.speed != 12.5 {
		t.Fatalf("speed = %v, want 12.5", vessel.speed)
	}
	if vessel.course == nil || *vessel.course != 90 {
		t.Fatalf("course = %v, want 90", vessel.course)
	}
}

func TestAggregateMMSIFallsBackOnlyWhenNullish(t *testing.T) {
	clock := &relayTestClock{millis: relayTestBaseMillis}
	target := relayTestEngine(t, clock)

	// `meta.MMSI ?? meta.MMSI_String` only falls through on null/undefined: an empty string
	// MMSI wins the race and then normalises to absent, so the report is ignored.
	relayTestFeed(t, target, `{"MessageType":"PositionReport",`+
		`"MetaData":{"MMSI":"","MMSI_String":"123456789","latitude":1,"longitude":1},`+
		`"Message":{"PositionReport":{"Latitude":1,"Longitude":1}}}`)
	if target.ignoredPositionReports != 1 {
		t.Fatalf("ignoredPositionReports = %d, want 1", target.ignoredPositionReports)
	}

	// An explicit null does fall through to MMSI_String.
	relayTestFeed(t, target, `{"MessageType":"PositionReport",`+
		`"MetaData":{"MMSI":null,"MMSI_String":"123456789","latitude":1,"longitude":1},`+
		`"Message":{"PositionReport":{"Latitude":1,"Longitude":1}}}`)
	if target.positionReportsProcessed != 1 {
		t.Fatalf("positionReportsProcessed = %d, want 1", target.positionReportsProcessed)
	}
	if _, ok := target.vessels.Get("123456789"); !ok {
		t.Fatal("MMSI_String fallback did not retain the vessel")
	}
}

func TestAggregateCandidateRetentionWindow(t *testing.T) {
	clock := &relayTestClock{millis: relayTestBaseMillis}
	target := relayTestEngine(t, clock)
	target.markUpstreamOpen()

	relayTestFeed(t, target, relayTestPositionReport(111, "USS One", 35, 1, 1, ""))
	if target.candidateReports.Len() != 1 {
		t.Fatalf("candidate reports = %d, want 1", target.candidateReports.Len())
	}

	// The candidate stays for the 2 hour retention window plus the 30 minute vessel window.
	clock.advance(candidateRetention - time.Minute)
	target.cleanupAggregatesLocked()
	if target.candidateReports.Len() != 1 {
		t.Fatalf("candidate expired early: %d", target.candidateReports.Len())
	}

	clock.advance(2 * time.Minute)
	target.cleanupAggregatesLocked()
	if target.candidateReports.Len() != 0 {
		t.Fatalf("candidate survived retention: %d", target.candidateReports.Len())
	}
}

// relayTestVesselMMSIs renders the MMSI list of a snapshot slice for order assertions.
func relayTestVesselMMSIs(items []vesselSnapshotItem) string {
	result := ""
	for index, item := range items {
		if index > 0 {
			result += ","
		}
		result += item.MMSI
	}
	return result
}
