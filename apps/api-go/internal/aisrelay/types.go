package aisrelay

import "time"

// Wire and state types of the relay.
//
// The JSON structs below are the relay's public contract: field order matches the
// object literal order in the Node implementation because JSON.stringify emits
// properties in insertion order, and consumers diff payloads byte for byte while
// both versions run side by side. Optional members are pointers with omitempty,
// which reproduces the JS behaviour where an `undefined` property is dropped by
// JSON.stringify while a present 0 or "" is still emitted.

// HealthState is the relay health verdict reported in `diagnostics.healthState`.
type HealthState string

const (
	// HealthStateOK means every degradation rule is currently satisfied.
	HealthStateOK HealthState = "ok"
	// HealthStateDegraded means at least one rule tripped; the reason code says which.
	HealthStateDegraded HealthState = "degraded"
)

// ReasonCode is a relay degradation reason. The values are constrained to
// AIS_RELAY_REASON_CODES in packages/utils/src/realtime-signals-contract.ts, which
// the Web console and the API share, so the Go relay must not invent new ones.
type ReasonCode string

const (
	// ReasonUpstreamDisconnected: the AISStream socket is not open.
	ReasonUpstreamDisconnected ReasonCode = "ais_upstream_disconnected"
	// ReasonUpstreamNoMessagesAfterConnect: the socket opened but stayed silent.
	ReasonUpstreamNoMessagesAfterConnect ReasonCode = "ais_upstream_no_messages_after_connect"
	// ReasonUpstreamStalled: an established stream stopped delivering messages.
	ReasonUpstreamStalled ReasonCode = "ais_upstream_stalled"
	// ReasonPositionReportsNotRetained: reports arrive but no vessel is retained.
	ReasonPositionReportsNotRetained ReasonCode = "ais_position_reports_not_retained"
	// ReasonPositionReportsMostlyIgnored: most reports are discarded on normalisation.
	ReasonPositionReportsMostlyIgnored ReasonCode = "ais_position_reports_mostly_ignored"
	// ReasonPayloadParseErrors: upstream payloads frequently fail to parse.
	ReasonPayloadParseErrors ReasonCode = "ais_payload_parse_errors"
)

// ReasonCodes lists every reason code in contract order.
var ReasonCodes = []ReasonCode{
	ReasonUpstreamDisconnected,
	ReasonUpstreamNoMessagesAfterConnect,
	ReasonUpstreamStalled,
	ReasonPositionReportsNotRetained,
	ReasonPositionReportsMostlyIgnored,
	ReasonPayloadParseErrors,
}

// Aggregation constants copied from the Node relay.
const (
	// gridSizeDeg is the density grid cell size in degrees.
	gridSizeDeg = 2.0
	// densityWindow is how long a vessel stays in the snapshots after its last report.
	densityWindow = 30 * time.Minute
	// gapThreshold is the silence that qualifies a vessel as a dark ship.
	gapThreshold = 60 * time.Minute
	// darkShipFreshness bounds how recently a dark ship must have reappeared to count.
	darkShipFreshness = 10 * time.Minute
	// candidateRetention bounds how long a military candidate stays in the report set.
	candidateRetention = 2 * time.Hour
	// maxDensityZones caps the density zones returned per snapshot.
	maxDensityZones = 200
	// maxDensityCells caps the tracked density grid cells.
	maxDensityCells = 5_000
	// reconnectBaseDelay and reconnectMaxDelay bound the upstream backoff.
	reconnectBaseDelay       = 5 * time.Second
	reconnectMaxDelay        = 60 * time.Second
	reconnectMaxAttemptShift = 8
	// upstreamHandshakeTimeout bounds the websocket upgrade. The Node relay needs
	// it explicitly because the ws library has no handshake timeout and a
	// black-holed DNS path would otherwise leave the socket in CONNECTING forever.
	upstreamHandshakeTimeout = 15 * time.Second
	// vesselHistoryDepth is how many recent sightings are kept per vessel; the last
	// two are compared when detecting dark ships.
	vesselHistoryDepth = 10
)

// chokepoint is one monitored maritime chokepoint. Vessel counts inside the radius
// drive the synthetic congestion disruptions.
type chokepoint struct {
	name   string
	lat    float64
	lon    float64
	radius float64
}

// chokepoints is the CHOKEPOINTS table from the Node relay, in the same order,
// because the snapshot lists disruptions in table order.
var chokepoints = []chokepoint{
	{name: "Strait of Hormuz", lat: 26.5, lon: 56.5, radius: 2},
	{name: "Suez Canal", lat: 30, lon: 32.5, radius: 1},
	{name: "Malacca Strait", lat: 2.5, lon: 101.5, radius: 2},
	{name: "Bab el-Mandeb Strait", lat: 12.5, lon: 43.5, radius: 1.5},
	{name: "Panama Canal", lat: 9, lon: -79.5, radius: 1},
	{name: "Taiwan Strait", lat: 24.5, lon: 119.5, radius: 2},
	{name: "South China Sea", lat: 15, lon: 115, radius: 5},
	{name: "Black Sea", lat: 43.5, lon: 34, radius: 3},
	{name: "Cape of Good Hope", lat: -34.36, lon: 18.49, radius: 2},
	{name: "Gibraltar Strait", lat: 35.96, lon: -5.35, radius: 1},
	{name: "Bosporus Strait", lat: 40.7, lon: 28, radius: 1.5},
	{name: "Korea Strait", lat: 34, lon: 129, radius: 1.5},
	{name: "Dover Strait", lat: 51.05, lon: 1.45, radius: 0.5},
	{name: "Kerch Strait", lat: 45.33, lon: 36.6, radius: 0.5},
	{name: "Lombok Strait", lat: -8.47, lon: 115.72, radius: 0.5},
}

// vesselState is the retained snapshot of one vessel's latest position report.
type vesselState struct {
	mmsi      string
	name      *string
	lat       float64
	lon       float64
	timestamp int64
	shipType  *float64
	heading   *float64
	speed     *float64
	course    *float64
}

// densityCell is one grid cell of the density map.
type densityCell struct {
	key           string
	lat           float64
	lon           float64
	vesselIDs     *orderedSet
	previousCount int
	lastUpdate    int64
}

// candidateReport is a retained military candidate report.
type candidateReport struct {
	mmsi      string
	name      *string
	lat       float64
	lon       float64
	shipType  *float64
	heading   *float64
	speed     *float64
	course    *float64
	timestamp int64
}

// vesselSnapshotItem is the wire shape shared by `vessels` and `candidateReports`.
type vesselSnapshotItem struct {
	MMSI      string    `json:"mmsi"`
	Name      *string   `json:"name,omitempty"`
	Lat       jsNumber  `json:"lat"`
	Lon       jsNumber  `json:"lon"`
	ShipType  *jsNumber `json:"shipType,omitempty"`
	Heading   *jsNumber `json:"heading,omitempty"`
	Speed     *jsNumber `json:"speed,omitempty"`
	Course    *jsNumber `json:"course,omitempty"`
	Timestamp jsNumber  `json:"timestamp"`
}

// snapshotStatus is the counters block of a snapshot.
type snapshotStatus struct {
	Connected       bool `json:"connected"`
	Vessels         int  `json:"vessels"`
	Messages        int  `json:"messages"`
	Clients         int  `json:"clients"`
	DroppedMessages int  `json:"droppedMessages"`
}

// densityZone is one aggregated density area.
type densityZone struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Lat         jsNumber `json:"lat"`
	Lon         jsNumber `json:"lon"`
	Intensity   jsNumber `json:"intensity"`
	DeltaPct    int      `json:"deltaPct"`
	ShipsPerDay int      `json:"shipsPerDay"`
	Note        *string  `json:"note,omitempty"`
}

// disruption is one detected disruption.
//
// Both Node shapes are represented by this single struct: a chokepoint congestion
// entry fills vesselCount and region, a gap-spike entry fills darkShips, and the
// declaration order reproduces both property orders exactly (vesselCount and region
// precede description, darkShips also precedes description).
type disruption struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Type        string   `json:"type"`
	Lat         jsNumber `json:"lat"`
	Lon         jsNumber `json:"lon"`
	Severity    string   `json:"severity"`
	ChangePct   int      `json:"changePct"`
	WindowHours int      `json:"windowHours"`
	VesselCount *int     `json:"vesselCount,omitempty"`
	Region      *string  `json:"region,omitempty"`
	DarkShips   *int     `json:"darkShips,omitempty"`
	Description string   `json:"description"`
}

// HealthDiagnostics is the diagnostics block shared by the snapshot and /health.
type HealthDiagnostics struct {
	HealthState              HealthState `json:"healthState"`
	StatusReasonCode         *ReasonCode `json:"statusReasonCode,omitempty"`
	StatusReason             *string     `json:"statusReason,omitempty"`
	PositionReportsSeen      int         `json:"positionReportsSeen"`
	PositionReportsProcessed int         `json:"positionReportsProcessed"`
	IgnoredPositionReports   int         `json:"ignoredPositionReports"`
	ParseErrors              int         `json:"parseErrors"`
	LastHealthyAt            *string     `json:"lastHealthyAt,omitempty"`
	LastIssueAt              *string     `json:"lastIssueAt,omitempty"`
	LastConnectedAt          *string     `json:"lastConnectedAt,omitempty"`
	LastMessageAt            *string     `json:"lastMessageAt,omitempty"`
	LastUpstreamErrorAt      *string     `json:"lastUpstreamErrorAt,omitempty"`
	LastUpstreamError        *string     `json:"lastUpstreamError,omitempty"`
	LastParseErrorAt         *string     `json:"lastParseErrorAt,omitempty"`
	LastParseError           *string     `json:"lastParseError,omitempty"`
}

// Snapshot is the GET /ais/snapshot payload.
type Snapshot struct {
	Sequence         int                  `json:"sequence"`
	Timestamp        string               `json:"timestamp"`
	Status           snapshotStatus       `json:"status"`
	Diagnostics      HealthDiagnostics    `json:"diagnostics"`
	Disruptions      []disruption         `json:"disruptions"`
	Density          []densityZone        `json:"density"`
	CandidateReports []vesselSnapshotItem `json:"candidateReports"`
	Vessels          []vesselSnapshotItem `json:"vessels"`
}

// healthPayload is the GET / and GET /health payload.
type healthPayload struct {
	Status              HealthState       `json:"status"`
	Connected           bool              `json:"connected"`
	Vessels             int               `json:"vessels"`
	Messages            int               `json:"messages"`
	DroppedMessages     int               `json:"droppedMessages"`
	DensityZones        int               `json:"densityZones"`
	SharedSecretEnabled bool              `json:"sharedSecretEnabled"`
	Diagnostics         HealthDiagnostics `json:"diagnostics"`
}

// livenessPayload is the GET /healthz/live payload.
type livenessPayload struct {
	Status  string `json:"status"`
	Service string `json:"service"`
	Now     string `json:"now"`
}

// errorPayload is the body of a 401/404/405 response.
type errorPayload struct {
	Error string `json:"error"`
}

// ref returns a pointer to value, for optional wire members.
func ref[T any](value T) *T {
	return &value
}
