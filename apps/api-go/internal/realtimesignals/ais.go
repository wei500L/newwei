package realtimesignals

import (
	"bytes"
	"context"
	"errors"
	"log"
	"math"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/dataruntimesettings"
)

// AIS: the relay snapshot and its transport documents. The relay response is
// global, so the round fetches it once (O1); the snapshot write, the transport
// write and the status-change log stay per organization.

func aisSnapshotTTLSeconds(intervalSec int) int {
	safe := intervalSec
	if safe < 60 {
		safe = 60
	}
	return maxInt(aisSnapshotMinTTL, safe*2)
}

// normalizeAisMmsi mirrors normalizeAisMmsi: a finite number is truncated and
// stringified, a string is trimmed.
func normalizeAisMmsi(raw jsonRawMessage) string {
	if value, ok := toFiniteNumber(raw); ok && isJSONNumber(raw) {
		return strconvFormatInt(jsTrunc(value))
	}
	return normalizeStringRaw(raw)
}

func strconvFormatInt(value int64) string {
	return jsNumberString(float64(value))
}

func isJSONNumber(raw jsonRawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return false
	}
	first := trimmed[0]
	return (first >= '0' && first <= '9') || first == '-' || first == '+'
}

// aisStatusPayload is the status object.
type aisStatusPayload struct {
	Connected       jsonRawMessage `json:"connected"`
	Vessels         jsonRawMessage `json:"vessels"`
	Messages        jsonRawMessage `json:"messages"`
	Clients         jsonRawMessage `json:"clients"`
	DroppedMessages jsonRawMessage `json:"droppedMessages"`
}

// aisDiagnosticsPayload is the relay diagnostics object.
type aisDiagnosticsPayload struct {
	HealthState              jsonRawMessage `json:"healthState"`
	StatusReasonCode         jsonRawMessage `json:"statusReasonCode"`
	StatusReason             jsonRawMessage `json:"statusReason"`
	PositionReportsSeen      jsonRawMessage `json:"positionReportsSeen"`
	PositionReportsProcessed jsonRawMessage `json:"positionReportsProcessed"`
	IgnoredPositionReports   jsonRawMessage `json:"ignoredPositionReports"`
	ParseErrors              jsonRawMessage `json:"parseErrors"`
	LastHealthyAt            jsonRawMessage `json:"lastHealthyAt"`
	LastIssueAt              jsonRawMessage `json:"lastIssueAt"`
	LastConnectedAt          jsonRawMessage `json:"lastConnectedAt"`
	LastMessageAt            jsonRawMessage `json:"lastMessageAt"`
	LastUpstreamErrorAt      jsonRawMessage `json:"lastUpstreamErrorAt"`
	LastUpstreamError        jsonRawMessage `json:"lastUpstreamError"`
	LastParseErrorAt         jsonRawMessage `json:"lastParseErrorAt"`
	LastParseError           jsonRawMessage `json:"lastParseError"`
}

// aisSnapshotPayload is the relay response.
type aisSnapshotPayload struct {
	Timestamp        jsonRawMessage `json:"timestamp"`
	Status           jsonRawMessage `json:"status"`
	Diagnostics      jsonRawMessage `json:"diagnostics"`
	Disruptions      jsonRawMessage `json:"disruptions"`
	Density          jsonRawMessage `json:"density"`
	CandidateReports jsonRawMessage `json:"candidateReports"`
	Vessels          jsonRawMessage `json:"vessels"`
}

// aisDisruptionPayload is one disruptions[] entry.
type aisDisruptionPayload struct {
	ID          jsonRawMessage `json:"id"`
	Name        jsonRawMessage `json:"name"`
	Type        jsonRawMessage `json:"type"`
	Lat         jsonRawMessage `json:"lat"`
	Lon         jsonRawMessage `json:"lon"`
	Lng         jsonRawMessage `json:"lng"`
	Severity    jsonRawMessage `json:"severity"`
	ChangePct   jsonRawMessage `json:"changePct"`
	WindowHours jsonRawMessage `json:"windowHours"`
	VesselCount jsonRawMessage `json:"vesselCount"`
	DarkShips   jsonRawMessage `json:"darkShips"`
	Region      jsonRawMessage `json:"region"`
	Description jsonRawMessage `json:"description"`
}

// aisDensityPayload is one density[] entry.
type aisDensityPayload struct {
	ID          jsonRawMessage `json:"id"`
	Name        jsonRawMessage `json:"name"`
	Lat         jsonRawMessage `json:"lat"`
	Lon         jsonRawMessage `json:"lon"`
	Lng         jsonRawMessage `json:"lng"`
	Intensity   jsonRawMessage `json:"intensity"`
	DeltaPct    jsonRawMessage `json:"deltaPct"`
	ShipsPerDay jsonRawMessage `json:"shipsPerDay"`
	Note        jsonRawMessage `json:"note"`
}

// aisVesselPayload is one vessel entry. It carries every alias the NestJS
// normalizer accepts.
type aisVesselPayload struct {
	MMSI        jsonRawMessage `json:"mmsi"`
	MMSIUpper   jsonRawMessage `json:"MMSI"`
	MMSIString  jsonRawMessage `json:"MMSI_String"`
	Lat         jsonRawMessage `json:"lat"`
	Lon         jsonRawMessage `json:"lon"`
	Lng         jsonRawMessage `json:"lng"`
	ShipType    jsonRawMessage `json:"shipType"`
	ShipTypeAlt jsonRawMessage `json:"ship_type"`
	ShipTypeCap jsonRawMessage `json:"ShipType"`
	Heading     jsonRawMessage `json:"heading"`
	TrueHeading jsonRawMessage `json:"TrueHeading"`
	Speed       jsonRawMessage `json:"speed"`
	Sog         jsonRawMessage `json:"Sog"`
	Course      jsonRawMessage `json:"course"`
	Cog         jsonRawMessage `json:"Cog"`
	Name        jsonRawMessage `json:"name"`
	ShipName    jsonRawMessage `json:"ShipName"`
	ObservedAt  jsonRawMessage `json:"observedAt"`
	Timestamp   jsonRawMessage `json:"timestamp"`
}

func normalizeAisStatusPayload(raw jsonRawMessage) AisRelayStatus {
	var payload aisStatusPayload
	if len(bytes.TrimSpace(raw)) > 0 && !isJSONNull(raw) {
		_ = decodeJSONPayload(raw, &payload)
	}
	return AisRelayStatus{
		Connected:       rawBool(payload.Connected),
		Vessels:         nonNegativeRounded(payload.Vessels),
		Messages:        nonNegativeRounded(payload.Messages),
		Clients:         nonNegativeRounded(payload.Clients),
		DroppedMessages: nonNegativeRounded(payload.DroppedMessages),
	}
}

func normalizeAisRelayDiagnostics(raw jsonRawMessage) AisRelayDiagnostics {
	var payload aisDiagnosticsPayload
	if len(bytes.TrimSpace(raw)) > 0 && !isJSONNull(raw) {
		_ = decodeJSONPayload(raw, &payload)
	}
	healthState := "ok"
	if normalizeStringRaw(payload.HealthState) == "degraded" {
		healthState = "degraded"
	}
	diagnostics := AisRelayDiagnostics{
		HealthState:              healthState,
		StatusReasonCode:         normalizeStringRaw(payload.StatusReasonCode),
		StatusReason:             normalizeStringRaw(payload.StatusReason),
		PositionReportsSeen:      nonNegativeRounded(payload.PositionReportsSeen),
		PositionReportsProcessed: nonNegativeRounded(payload.PositionReportsProcessed),
		IgnoredPositionReports:   nonNegativeRounded(payload.IgnoredPositionReports),
		ParseErrors:              nonNegativeRounded(payload.ParseErrors),
	}
	if normalizeStringRaw(payload.LastHealthyAt) != "" {
		diagnostics.LastHealthyAt = toIsoTimestamp(payload.LastHealthyAt)
	}
	if normalizeStringRaw(payload.LastIssueAt) != "" {
		diagnostics.LastIssueAt = toIsoTimestamp(payload.LastIssueAt)
	}
	if normalizeStringRaw(payload.LastConnectedAt) != "" {
		diagnostics.LastConnectedAt = toIsoTimestamp(payload.LastConnectedAt)
	}
	if normalizeStringRaw(payload.LastMessageAt) != "" {
		diagnostics.LastMessageAt = toIsoTimestamp(payload.LastMessageAt)
	}
	if normalizeStringRaw(payload.LastUpstreamErrorAt) != "" {
		diagnostics.LastUpstreamErrorAt = toIsoTimestamp(payload.LastUpstreamErrorAt)
	}
	if value := normalizeStringRaw(payload.LastUpstreamError); value != "" {
		diagnostics.LastUpstreamError = value
	}
	if normalizeStringRaw(payload.LastParseErrorAt) != "" {
		diagnostics.LastParseErrorAt = toIsoTimestamp(payload.LastParseErrorAt)
	}
	if value := normalizeStringRaw(payload.LastParseError); value != "" {
		diagnostics.LastParseError = value
	}
	return diagnostics
}

func normalizeAisDisruptionSeverity(raw jsonRawMessage) string {
	switch normalizeStringLower(raw) {
	case "high":
		return "high"
	case "elevated", "medium":
		return "elevated"
	default:
		return "low"
	}
}

func normalizeAisDisruptionSnapshot(raw jsonRawMessage, index int) (AisDisruption, bool) {
	var payload aisDisruptionPayload
	if !isJSONObject(raw) || decodeJSONPayload(raw, &payload) != nil {
		return AisDisruption{}, false
	}
	lat, latOK := toFiniteNumber(payload.Lat)
	lng, lngOK := toFiniteNumber(firstRaw(payload.Lon, payload.Lng))
	if !latOK || !lngOK || !isValidCoordinate(&lat, &lng) {
		return AisDisruption{}, false
	}
	id := normalizeStringRaw(payload.ID)
	if id == "" {
		id = "ais-disruption-" + jsNumberString(float64(index+1))
	}
	name := normalizeStringRaw(payload.Name)
	if name == "" {
		name = id
	}
	disruption := AisDisruption{
		ID: id, Name: name, Type: defaultString(normalizeStringRaw(payload.Type), "unknown"),
		Lat: lat, Lng: lng, Severity: normalizeAisDisruptionSeverity(payload.Severity),
		Region:      normalizeStringRaw(payload.Region),
		Description: normalizeStringRaw(payload.Description),
	}
	if value, ok := toFiniteNumber(payload.ChangePct); ok {
		disruption.ChangePct = &value
	}
	if value, ok := toFiniteNumber(payload.WindowHours); ok {
		disruption.WindowHours = &value
	}
	if value, ok := toFiniteNumber(payload.VesselCount); ok {
		disruption.VesselCount = &value
	}
	if value, ok := toFiniteNumber(payload.DarkShips); ok {
		disruption.DarkShips = &value
	}
	return disruption, true
}

func normalizeAisDensitySnapshot(raw jsonRawMessage, index int) (AisDensity, bool) {
	var payload aisDensityPayload
	if !isJSONObject(raw) || decodeJSONPayload(raw, &payload) != nil {
		return AisDensity{}, false
	}
	lat, latOK := toFiniteNumber(payload.Lat)
	lng, lngOK := toFiniteNumber(firstRaw(payload.Lon, payload.Lng))
	intensity, intensityOK := toFiniteNumber(payload.Intensity)
	if !latOK || !lngOK || !intensityOK || !isValidCoordinate(&lat, &lng) {
		return AisDensity{}, false
	}
	id := normalizeStringRaw(payload.ID)
	if id == "" {
		id = "ais-density-" + jsNumberString(float64(index+1))
	}
	density := AisDensity{
		ID: id, Name: normalizeStringRaw(payload.Name), Lat: lat, Lng: lng,
		Intensity: math.Min(1, math.Max(0, intensity)),
		Note:      normalizeStringRaw(payload.Note),
	}
	if value, ok := toFiniteNumber(payload.DeltaPct); ok {
		density.DeltaPct = &value
	}
	if value, ok := toFiniteNumber(payload.ShipsPerDay); ok {
		density.ShipsPerDay = &value
	}
	return density, true
}

func normalizeAisVesselSnapshot(raw jsonRawMessage, fallbackObservedAt string) (AisVessel, bool) {
	var payload aisVesselPayload
	if !isJSONObject(raw) || decodeJSONPayload(raw, &payload) != nil {
		return AisVessel{}, false
	}
	mmsi := normalizeAisMmsi(firstRaw(payload.MMSI, payload.MMSIUpper, payload.MMSIString))
	lat, latOK := toFiniteNumber(payload.Lat)
	lng, lngOK := toFiniteNumber(firstRaw(payload.Lon, payload.Lng))
	if mmsi == "" || !latOK || !lngOK || !isValidCoordinate(&lat, &lng) {
		return AisVessel{}, false
	}
	vessel := AisVessel{
		MMSI:       mmsi,
		Name:       normalizeStringRaw(firstRaw(payload.Name, payload.ShipName)),
		Lat:        lat,
		Lng:        lng,
		ObservedAt: toIsoTimestamp(firstRaw(payload.ObservedAt, payload.Timestamp, jsonStringToken(fallbackObservedAt))),
	}
	if value, ok := toFiniteNumber(firstRaw(payload.ShipType, payload.ShipTypeAlt, payload.ShipTypeCap)); ok {
		vessel.ShipType = &value
	}
	if value, ok := toFiniteNumber(firstRaw(payload.Heading, payload.TrueHeading)); ok {
		vessel.Heading = &value
	}
	if value, ok := toFiniteNumber(firstRaw(payload.Speed, payload.Sog)); ok {
		vessel.Speed = &value
	}
	if value, ok := toFiniteNumber(firstRaw(payload.Course, payload.Cog)); ok {
		vessel.Course = &value
	}
	return vessel, true
}

// parseAisSnapshot mirrors readAisSnapshotPayload plus buildAisLatestSnapshot.
func parseAisSnapshot(payload jsonRawMessage, sourceEndpoint string) (AisSnapshot, error) {
	var body aisSnapshotPayload
	if !isJSONObject(payload) || decodeJSONPayload(payload, &body) != nil {
		return AisSnapshot{}, errors.New("AIS relay returned an invalid snapshot payload. Expected disruptions[] and density[].")
	}
	if !isJSONArray(body.Disruptions) || !isJSONArray(body.Density) {
		return AisSnapshot{}, errors.New("AIS relay returned an invalid snapshot payload. Expected disruptions[] and density[].")
	}
	updatedAt := toIsoTimestamp(body.Timestamp)
	status := normalizeAisStatusPayload(body.Status)
	snapshot := AisSnapshot{
		Source: "relay", SourceEndpoint: sourceEndpoint, UpdatedAt: updatedAt,
		Status: status, Diagnostics: normalizeAisRelayDiagnostics(body.Diagnostics),
		Disruptions: make([]AisDisruption, 0), Density: make([]AisDensity, 0),
		CandidateReports: make([]AisVessel, 0), Vessels: make([]AisVessel, 0),
		HasVesselSnapshot: isJSONArray(body.Vessels),
	}
	for index, entry := range readArray(body.Disruptions) {
		if disruption, ok := normalizeAisDisruptionSnapshot(entry, index); ok {
			snapshot.Disruptions = append(snapshot.Disruptions, disruption)
		}
	}
	for index, entry := range readArray(body.Density) {
		if density, ok := normalizeAisDensitySnapshot(entry, index); ok {
			snapshot.Density = append(snapshot.Density, density)
		}
	}
	for _, entry := range readArray(body.CandidateReports) {
		if vessel, ok := normalizeAisVesselSnapshot(entry, updatedAt); ok {
			snapshot.CandidateReports = append(snapshot.CandidateReports, vessel)
		}
	}
	for _, entry := range readArray(body.Vessels) {
		if vessel, ok := normalizeAisVesselSnapshot(entry, updatedAt); ok {
			snapshot.Vessels = append(snapshot.Vessels, vessel)
		}
	}
	return snapshot, nil
}

// fetchAisSignal mirrors RealtimeAisService.fetchAisSignal. The relay payload is
// shared per round (O1); everything after the parse is per organization.
func (s *Service) fetchAisSignal(ctx context.Context, orgID string, runtime *dataruntimesettings.RealtimeCronRuntime, round *roundContext) ([]FetchResult, error) {
	aisBase := normalizeURL(runtime.AisRelay.BaseURL, "")
	if aisBase == "" {
		if err := s.store.clearLatestAisSnapshot(ctx, orgID); err != nil {
			return nil, err
		}
		return []FetchResult{{
			MetricSlug: metricAis,
			Value:      0,
			Context: &aisContext{
				Source: "relay", Configured: false, CountryCodes: []string{},
			},
		}}, nil
	}
	payload, err := round.aisPayload(ctx, s, runtime, aisBase)
	if err != nil {
		return nil, err
	}
	snapshot, err := parseAisSnapshot(payload, aisBase+"/ais/snapshot")
	if err != nil {
		return nil, err
	}
	s.logAisRelayStatusChange(orgID, snapshot)
	if err := s.store.setLatestAisSnapshot(ctx, orgID, snapshot, aisSnapshotTTLSeconds(runtime.Sources.Ais.IntervalSec)); err != nil {
		return nil, err
	}
	if err := s.transport.persistAisTransportSnapshot(ctx, orgID, snapshot); err != nil {
		return nil, err
	}
	countries := make([]string, 0, len(snapshot.Disruptions))
	for _, disruption := range snapshot.Disruptions {
		if code := extractCountryCode(disruption.Region); code != "" {
			countries = append(countries, code)
		}
	}
	return []FetchResult{{
		MetricSlug: metricAis,
		Value:      float64(len(snapshot.Disruptions)),
		Context: &aisContext{
			Source: "relay", Configured: true, CountryCodes: dedupeStringsPreserve(countries),
		},
	}}, nil
}

// buildAisHeaders mirrors buildAisHeaders: an optional bearer shared secret.
func buildAisHeaders(runtime *dataruntimesettings.RealtimeCronRuntime) map[string]string {
	secret := jsTrim(runtime.AisRelay.SharedSecret)
	if secret == "" {
		return nil
	}
	return map[string]string{"Authorization": "Bearer " + secret}
}

// aisRelayReasonCodes is the AIS_RELAY_REASON_CODES set.
var aisRelayReasonCodes = map[string]struct{}{
	"ais_upstream_disconnected":              {},
	"ais_upstream_no_messages_after_connect": {},
	"ais_upstream_stalled":                   {},
	"ais_position_reports_not_retained":      {},
	"ais_position_reports_mostly_ignored":    {},
	"ais_payload_parse_errors":               {},
}

// logAisRelayStatusChange mirrors logAisRelayStatusChange: the log is emitted
// only when the issue identity changes for the organization.
func (s *Service) logAisRelayStatusChange(orgID string, snapshot AisSnapshot) {
	identity := aisIssueIdentity(snapshot)
	s.aisIssueMu.Lock()
	previous, exists := s.aisIssueIdentity[orgID]
	if !exists || previous != identity {
		s.aisIssueIdentity[orgID] = identity
	}
	s.aisIssueMu.Unlock()
	if exists && previous == identity {
		return
	}
	if identity == "ok" {
		if previous != "" && previous != "ok" {
			log.Printf("realtimesignals: AIS relay snapshot recovered orgId=%s previousIssueCode=%s updatedAt=%s",
				orgID, previous, snapshot.UpdatedAt)
		}
		return
	}
	log.Printf("realtimesignals: AIS relay snapshot reports degraded state orgId=%s issueIdentity=%s issueCode=%s issueReason=%s connected=%t messages=%s vessels=%s positionReportsSeen=%s positionReportsProcessed=%s ignoredPositionReports=%s parseErrors=%s updatedAt=%s",
		orgID, identity, snapshot.Diagnostics.StatusReasonCode, snapshot.Diagnostics.StatusReason,
		snapshot.Status.Connected, jsNumberString(snapshot.Status.Messages), jsNumberString(snapshot.Status.Vessels),
		jsNumberString(snapshot.Diagnostics.PositionReportsSeen),
		jsNumberString(snapshot.Diagnostics.PositionReportsProcessed),
		jsNumberString(snapshot.Diagnostics.IgnoredPositionReports), jsNumberString(snapshot.Diagnostics.ParseErrors),
		snapshot.UpdatedAt)
}

// aisIssueIdentity mirrors the issueIdentity expression in
// logAisRelayStatusChange, including the relay reason-code filter.
func aisIssueIdentity(snapshot AisSnapshot) string {
	code := snapshot.Diagnostics.StatusReasonCode
	if _, ok := aisRelayReasonCodes[code]; !ok {
		code = ""
	}
	if code != "" {
		return code
	}
	if snapshot.Diagnostics.StatusReason != "" {
		return snapshot.Diagnostics.StatusReason
	}
	if snapshot.Diagnostics.HealthState == "degraded" {
		return "degraded"
	}
	return "ok"
}

func nonNegativeRounded(raw jsonRawMessage) float64 {
	value, ok := toFiniteNumber(raw)
	if !ok {
		value = 0
	}
	return math.Max(0, jsRound(value))
}

func normalizeStringLower(raw jsonRawMessage) string {
	return strings.ToLower(normalizeStringRaw(raw))
}

func defaultString(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
