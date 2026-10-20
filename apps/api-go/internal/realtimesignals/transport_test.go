package realtimesignals

import (
	"math"
	"testing"
	"time"
)

func TestTransportGeoCellUsesHalfDegreeFloor(t *testing.T) {
	cases := []struct {
		lat, lng float64
		want     string
	}{
		{12.34, -56.78, "12.0,-57.0"},
		{0, 0, "0.0,0.0"},
		{-0.1, 0.1, "-0.5,0.0"},
		{89.9, 179.9, "89.5,179.5"},
	}
	for _, testCase := range cases {
		if got := buildTransportGeoCell(testCase.lat, testCase.lng); got != testCase.want {
			t.Fatalf("geoCell(%v, %v) = %s, want %s", testCase.lat, testCase.lng, got, testCase.want)
		}
	}
}

func TestTransportAngleDelta(t *testing.T) {
	cases := []struct {
		left, right *float64
		want        float64
	}{
		{floatPointer(350), floatPointer(10), 20},
		{floatPointer(0), floatPointer(180), 180},
		{floatPointer(90), floatPointer(95), 5},
		{nil, floatPointer(10), 0},
		{floatPointer(-10), floatPointer(10), 20},
	}
	for _, testCase := range cases {
		if got := computeTransportAngleDelta(testCase.left, testCase.right); got != testCase.want {
			t.Fatalf("angleDelta(%v, %v) = %v, want %v", testCase.left, testCase.right, got, testCase.want)
		}
	}
}

func TestTransportDistanceKm(t *testing.T) {
	// One degree of latitude at the equator is about 111.19 km with R=6371.
	distance := computeTransportDistanceKm(1, 0, floatPointer(0), floatPointer(0))
	if distance == nil || math.Abs(*distance-111.19) > 0.1 {
		t.Fatalf("distance = %v", distance)
	}
	if computeTransportDistanceKm(1, 0, nil, floatPointer(0)) != nil {
		t.Fatal("distance with no previous latitude must be nil")
	}
}

func TestShouldPersistTransportTrackPoint(t *testing.T) {
	now := "2026-10-20T12:00:00.000Z"
	base := transportRecord{
		EntityKind: "aircraft", ObjectKey: "opensky:abc", Lat: 10, Lng: 20,
		ObservedAt: now, Heading: floatPointer(90), Course: floatPointer(90),
		Speed: floatPointer(100), AltitudeFt: floatPointer(30000),
	}
	if !shouldPersistTransportTrackPoint(base, transportStateDoc{}, false) {
		t.Fatal("a new object must persist a track point")
	}
	existing := transportStateDoc{
		ObjectKey: "opensky:abc", ObservedAt: timePointer(now), Lat: floatPointer(10), Lng: floatPointer(20),
		Heading: floatPointer(90), Course: floatPointer(90), Speed: floatPointer(100), AltitudeFt: floatPointer(30000),
	}
	if shouldPersistTransportTrackPoint(base, existing, true) {
		t.Fatal("an unchanged observation inside the heartbeat must not persist")
	}

	sameTime := base
	sameTime.ObservedAt = now
	if shouldPersistTransportTrackPoint(sameTime, existing, true) {
		t.Fatal("an observation at the existing timestamp must not persist")
	}

	moved := base
	moved.Lat = 10.03 // about 3.3 km north
	if !shouldPersistTransportTrackPoint(moved, existing, true) {
		t.Fatal("a move beyond 2 km must persist")
	}

	turned := base
	turned.Heading = floatPointer(110)
	if !shouldPersistTransportTrackPoint(turned, existing, true) {
		t.Fatal("a heading change beyond 15 degrees must persist")
	}

	faster := base
	faster.Speed = floatPointer(106)
	if !shouldPersistTransportTrackPoint(faster, existing, true) {
		t.Fatal("a speed change beyond 5 knots must persist")
	}

	climbed := base
	climbed.AltitudeFt = floatPointer(31200)
	if !shouldPersistTransportTrackPoint(climbed, existing, true) {
		t.Fatal("an altitude change beyond 1000 ft must persist")
	}

	heartbeat := base
	heartbeat.ObservedAt = "2026-10-20T12:10:00.000Z"
	if !shouldPersistTransportTrackPoint(heartbeat, existing, true) {
		t.Fatal("a ten minute heartbeat must persist")
	}

	vessel := base
	vessel.EntityKind = "vessel"
	vessel.AltitudeFt = floatPointer(31200)
	if shouldPersistTransportTrackPoint(vessel, existing, true) {
		t.Fatal("the altitude threshold must not apply to vessels")
	}
}

func TestDedupeTransportRecords(t *testing.T) {
	older := transportRecord{ObjectKey: "opensky:abc", ObservedAt: "2026-10-20T12:00:00.000Z", Callsign: "OLD"}
	newer := transportRecord{ObjectKey: "opensky:abc", ObservedAt: "2026-10-20T12:01:00.000Z", Callsign: "NEW"}
	deduped := dedupeTransportRecords([]transportRecord{older, newer})
	if len(deduped) != 1 || deduped[0].Callsign != "NEW" {
		t.Fatalf("dedupe = %+v", deduped)
	}
	// Equal timestamps prefer the richer record (higher score).
	left := transportRecord{ObjectKey: "opensky:abc", ObservedAt: "2026-10-20T12:00:00.000Z"}
	right := transportRecord{ObjectKey: "opensky:abc", ObservedAt: "2026-10-20T12:00:00.000Z", Callsign: "RICH"}
	deduped = dedupeTransportRecords([]transportRecord{left, right})
	if len(deduped) != 1 || deduped[0].Callsign != "RICH" {
		t.Fatalf("dedupe equal timestamps = %+v", deduped)
	}
}

func TestClassifyAircraftAndShip(t *testing.T) {
	civil := classifyAircraftTransport("UAL123", "a1b2c3", "all")
	if civil.IsMilitaryCandidate || civil.Role != "Civil or general aviation" {
		t.Fatalf("civil = %+v", civil)
	}
	transport := classifyAircraftTransport("RCH123", "ae1234", "all")
	if !transport.IsMilitaryCandidate || transport.Role != "Military transport" {
		t.Fatalf("transport = %+v", transport)
	}
	refuel := classifyAircraftTransport("QID44", "ae1234", "all")
	if refuel.Role != "Aerial refueling" {
		t.Fatalf("refuel = %+v", refuel)
	}
	surveillance := classifyAircraftTransport("NATO01", "ae1234", "all")
	if surveillance.Role != "ISR / surveillance" {
		t.Fatalf("surveillance = %+v", surveillance)
	}
	militaryScope := classifyAircraftTransport("", "a1b2c3", "military")
	if !militaryScope.IsMilitaryCandidate {
		t.Fatal("military scope must classify as a military candidate")
	}

	if got := classifyAisShipType(floatPointer(70), false); got.ShipTypeLabel != "Cargo" || got.IsMilitaryCandidate {
		t.Fatalf("cargo = %+v", got)
	}
	if got := classifyAisShipType(floatPointer(55), false); got.ShipTypeLabel != "Military / government" || !got.IsMilitaryCandidate {
		t.Fatalf("military ship type = %+v", got)
	}
	if got := classifyAisShipType(nil, true); got.ShipTypeLabel != "Other" || got.VesselRole != "Military / government" {
		t.Fatalf("candidate with no type = %+v", got)
	}
}

func floatPointer(value float64) *float64 { return &value }

func timePointer(value string) *time.Time {
	parsed := timeFromISO(value)
	return &parsed
}
