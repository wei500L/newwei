package dashboardwarmap

import (
	"context"
	"encoding/json"
	"math"
	"sort"
	"strings"
	"time"
)

type snapshotReader interface {
	LatestAdsb(ctx context.Context, orgID string) (*adsbSnapshot, error)
	LatestAis(ctx context.Context, orgID string) (*aisSnapshot, error)
	SourceState(ctx context.Context, orgID, source string) (map[string]any, error)
}

type adsbCraft struct {
	ID, ICAO24, Callsign, Registration, AircraftType string
	Lat, Lng                                         float64
	Heading, AltitudeFt, GroundSpeedKt               *float64
	CountryCode, CountryName, ObservedAt, Source     string
}

type adsbSnapshot struct {
	Endpoint, UpdatedAt, LatestObserved string
	Total, Valid, StaleSec              int
	DiagnosticsLatest                   string
	Retained                            bool
	Aircraft                            []adsbCraft
}

type aisVessel struct {
	MMSI, Name, ObservedAt string
	Lat, Lng               float64
	ShipType               *float64
	Heading, Speed, Course *float64
}

type aisZone struct {
	ID, Name, Note string
	Lat, Lng       float64
	Intensity      float64
	DeltaPct       *float64
	ShipsPerDay    *float64
}

type aisBreak struct {
	ID, Name, Type, Severity, Region, Description string
	Lat, Lng                                      float64
	ChangePct, WindowHours, VesselCount, Dark     *float64
}

type aisSnapshot struct {
	Endpoint, UpdatedAt string
	Connected           bool
	Vessels, Messages, Clients, Dropped int
	HasVessels          bool
	Health              string
	ReasonCode, Reason  string
	Seen, Processed, Ignored, ParseErrors int
	Disruptions         []aisBreak
	Density             []aisZone
	Candidates, Ships   []aisVessel
}

type redisSnapshots struct{ cache blobCache }

func (r redisSnapshots) LatestAdsb(ctx context.Context, orgID string) (*adsbSnapshot, error) {
	raw, ok, err := r.get(ctx, "realtime-signals:opensky-latest:"+orgID)
	if err != nil || !ok {
		return nil, err
	}
	var wire struct {
		SourceEndpoint     string `json:"sourceEndpoint"`
		UpdatedAt          string `json:"updatedAt"`
		TotalAircraft      int    `json:"totalAircraft"`
		ValidPositionCount int    `json:"validPositionCount"`
		LatestObservedAt   string `json:"latestObservedAt"`
		Diagnostics        struct {
			LatestObservedAt         string `json:"latestObservedAt"`
			StaleThresholdSec        int    `json:"staleThresholdSec"`
			RetainedPreviousSnapshot bool   `json:"retainedPreviousSnapshot"`
		} `json:"diagnostics"`
		Aircraft []struct {
			ID            string   `json:"id"`
			ICAO24        string   `json:"icao24"`
			Callsign      string   `json:"callsign"`
			Registration  string   `json:"registration"`
			AircraftType  string   `json:"aircraftType"`
			Lat           float64  `json:"lat"`
			Lng           float64  `json:"lng"`
			Heading       *float64 `json:"heading"`
			AltitudeFt    *float64 `json:"altitudeFt"`
			GroundSpeedKt *float64 `json:"groundSpeedKt"`
			CountryCode   string   `json:"countryCode"`
			CountryName   string   `json:"countryName"`
			ObservedAt    string   `json:"observedAt"`
			Source        string   `json:"source"`
		} `json:"aircraft"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		return nil, err
	}
	snap := &adsbSnapshot{
		Endpoint: wire.SourceEndpoint, UpdatedAt: wire.UpdatedAt, LatestObserved: wire.LatestObservedAt,
		Total: wire.TotalAircraft, Valid: wire.ValidPositionCount, StaleSec: wire.Diagnostics.StaleThresholdSec,
		DiagnosticsLatest: wire.Diagnostics.LatestObservedAt, Retained: wire.Diagnostics.RetainedPreviousSnapshot,
	}
	for _, craft := range wire.Aircraft {
		snap.Aircraft = append(snap.Aircraft, adsbCraft{
			ID: craft.ID, ICAO24: craft.ICAO24, Callsign: craft.Callsign, Registration: craft.Registration,
			AircraftType: craft.AircraftType, Lat: craft.Lat, Lng: craft.Lng, Heading: craft.Heading,
			AltitudeFt: craft.AltitudeFt, GroundSpeedKt: craft.GroundSpeedKt, CountryCode: craft.CountryCode,
			CountryName: craft.CountryName, ObservedAt: craft.ObservedAt, Source: craft.Source,
		})
	}
	return snap, nil
}

func (r redisSnapshots) LatestAis(ctx context.Context, orgID string) (*aisSnapshot, error) {
	raw, ok, err := r.get(ctx, "realtime-signals:ais-latest:"+orgID)
	if err != nil || !ok {
		return nil, err
	}
	var wire struct {
		SourceEndpoint string `json:"sourceEndpoint"`
		UpdatedAt      string `json:"updatedAt"`
		HasVesselSnapshot bool `json:"hasVesselSnapshot"`
		Status struct {
			Connected       bool `json:"connected"`
			Vessels         int  `json:"vessels"`
			Messages        int  `json:"messages"`
			Clients         int  `json:"clients"`
			DroppedMessages int  `json:"droppedMessages"`
		} `json:"status"`
		Diagnostics struct {
			HealthState              string `json:"healthState"`
			StatusReason             string `json:"statusReason"`
			StatusReasonCode         string `json:"statusReasonCode"`
			PositionReportsSeen      int    `json:"positionReportsSeen"`
			PositionReportsProcessed int    `json:"positionReportsProcessed"`
			IgnoredPositionReports   int    `json:"ignoredPositionReports"`
			ParseErrors              int    `json:"parseErrors"`
		} `json:"diagnostics"`
		Disruptions []struct {
			ID          string   `json:"id"`
			Name        string   `json:"name"`
			Type        string   `json:"type"`
			Severity    string   `json:"severity"`
			Region      string   `json:"region"`
			Description string   `json:"description"`
			Lat         float64  `json:"lat"`
			Lng         float64  `json:"lng"`
			ChangePct   *float64 `json:"changePct"`
			WindowHours *float64 `json:"windowHours"`
			VesselCount *float64 `json:"vesselCount"`
			DarkShips   *float64 `json:"darkShips"`
		} `json:"disruptions"`
		Density []struct {
			ID          string   `json:"id"`
			Name        string   `json:"name"`
			Note        string   `json:"note"`
			Lat         float64  `json:"lat"`
			Lng         float64  `json:"lng"`
			Intensity   float64  `json:"intensity"`
			DeltaPct    *float64 `json:"deltaPct"`
			ShipsPerDay *float64 `json:"shipsPerDay"`
		} `json:"density"`
		CandidateReports []vesselWire `json:"candidateReports"`
		Vessels          []vesselWire `json:"vessels"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		return nil, err
	}
	snap := &aisSnapshot{
		Endpoint: wire.SourceEndpoint, UpdatedAt: wire.UpdatedAt, HasVessels: wire.HasVesselSnapshot,
		Connected: wire.Status.Connected, Vessels: wire.Status.Vessels, Messages: wire.Status.Messages,
		Clients: wire.Status.Clients, Dropped: wire.Status.DroppedMessages, Health: wire.Diagnostics.HealthState,
		ReasonCode: wire.Diagnostics.StatusReasonCode, Reason: wire.Diagnostics.StatusReason,
		Seen: wire.Diagnostics.PositionReportsSeen, Processed: wire.Diagnostics.PositionReportsProcessed,
		Ignored: wire.Diagnostics.IgnoredPositionReports, ParseErrors: wire.Diagnostics.ParseErrors,
	}
	for _, item := range wire.Disruptions {
		snap.Disruptions = append(snap.Disruptions, aisBreak{
			ID: item.ID, Name: item.Name, Type: item.Type, Severity: item.Severity, Region: item.Region,
			Description: item.Description, Lat: item.Lat, Lng: item.Lng, ChangePct: item.ChangePct,
			WindowHours: item.WindowHours, VesselCount: item.VesselCount, Dark: item.DarkShips,
		})
	}
	for _, item := range wire.Density {
		snap.Density = append(snap.Density, aisZone{
			ID: item.ID, Name: item.Name, Note: item.Note, Lat: item.Lat, Lng: item.Lng,
			Intensity: item.Intensity, DeltaPct: item.DeltaPct, ShipsPerDay: item.ShipsPerDay,
		})
	}
	snap.Candidates = vesselsOf(wire.CandidateReports)
	snap.Ships = vesselsOf(wire.Vessels)
	return snap, nil
}

type vesselWire struct {
	MMSI       string   `json:"mmsi"`
	Name       string   `json:"name"`
	ObservedAt string   `json:"observedAt"`
	Lat        float64  `json:"lat"`
	Lng        float64  `json:"lng"`
	ShipType   *float64 `json:"shipType"`
	Heading    *float64 `json:"heading"`
	Speed      *float64 `json:"speed"`
	Course     *float64 `json:"course"`
}

func vesselsOf(rows []vesselWire) []aisVessel {
	out := make([]aisVessel, 0, len(rows))
	for _, row := range rows {
		out = append(out, aisVessel{
			MMSI: row.MMSI, Name: row.Name, ObservedAt: row.ObservedAt, Lat: row.Lat, Lng: row.Lng,
			ShipType: row.ShipType, Heading: row.Heading, Speed: row.Speed, Course: row.Course,
		})
	}
	return out
}

func (r redisSnapshots) SourceState(ctx context.Context, orgID, source string) (map[string]any, error) {
	raw, ok, err := r.get(ctx, "realtime-signals:source-state:"+orgID+":"+source)
	if err != nil || !ok {
		return nil, err
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	return doc, nil
}

func (r redisSnapshots) get(ctx context.Context, key string) ([]byte, bool, error) {
	if r.cache == nil {
		return nil, false, errString("redis is not configured")
	}
	raw, ok, err := r.cache.Get(ctx, key)
	if err != nil || !ok || len(raw) == 0 || string(raw) == "null" {
		return nil, false, err
	}
	return raw, true, nil
}

func (s *Service) enrichFlights(ctx context.Context, response map[string]any, orgID string, opt viewOptions) error {
	dataset := layerDataset(response, "flights")
	if dataset == nil {
		return nil
	}
	dataset["renderHints"] = map[string]any{"pickable": true, "clusterable": true, "color": layerColors["flights"], "radiusScale": 1.15}
	mode := opt.FlightMode
	if mode == "" {
		mode = "military"
	}
	if mode == "all" {
		if s.sky == nil {
			return nil
		}
		result, err := s.sky.Viewport(ctx, opt.BBox, time.Now())
		if err != nil {
			return err
		}
		applyAllFlights(dataset, mode, opt, result)
		return nil
	}
	if s.snaps == nil {
		return nil
	}
	snap, err := s.snaps.LatestAdsb(ctx, orgID)
	if err != nil {
		return err
	}
	if snap == nil {
		dataset["features"] = []any{}
		delete(dataset, "updatedAt")
		dataset["summary"] = flightSummary(mode, "", "missing", 0, 0, 0, false, false, nil)
		return nil
	}
	if !adsbFresh(snap, time.Now()) {
		dataset["features"] = []any{}
		setString(dataset, "updatedAt", snap.UpdatedAt)
		dataset["summary"] = flightSummary(mode, snap.Endpoint, "stale", snap.Total, snap.Valid, 0, false, snap.Retained, nil)
		return nil
	}
	raw := clampCraft(snap.Aircraft)
	shaped := shapeFlights(raw, opt)
	dataset["features"] = flightFeatures(shaped, snap.UpdatedAt, mode)
	setString(dataset, "updatedAt", snap.UpdatedAt)
	filtered := filterCraft(raw, opt.BBox)
	maxReturned := flightMax(opt)
	dataset["summary"] = flightSummary(mode, snap.Endpoint, "fresh", snap.Total, snap.Valid, len(shaped), len(shaped) < len(filtered), snap.Retained, &maxReturned)
	return nil
}

func applyAllFlights(dataset map[string]any, mode string, opt viewOptions, result openskyResult) {
	if !result.Configured {
		dataset["features"] = []any{}
		delete(dataset, "updatedAt")
		dataset["summary"] = flightSummary(mode, "", "not_configured", 0, 0, 0, false, false, nil)
		return
	}
	if result.BudgetLimited {
		dataset["features"] = []any{}
		delete(dataset, "updatedAt")
		summary := flightSummary(mode, result.Endpoint, "budget_limited", 0, 0, 0, false, false, nil)
		putOpt(summary, "statusReasonCode", result.Code)
		putOpt(summary, "statusReason", result.Reason)
		if result.Remaining != nil {
			summary["remainingCredits"] = *result.Remaining
		}
		if result.Daily != nil {
			summary["dailyBudget"] = *result.Daily
		}
		putOpt(summary, "dateHkt", result.DateHKT)
		putOpt(summary, "degradationLevel", result.Degradation)
		dataset["summary"] = summary
		return
	}
	if result.RequiresZoom {
		dataset["features"] = []any{}
		delete(dataset, "updatedAt")
		summary := flightSummary(mode, result.Endpoint, "zoom_required", 0, 0, 0, false, false, nil)
		summary["requiresZoom"] = true
		dataset["summary"] = summary
		return
	}
	if result.Snapshot == nil {
		dataset["features"] = []any{}
		delete(dataset, "updatedAt")
		dataset["summary"] = flightSummary(mode, result.Endpoint, "missing", 0, 0, 0, false, false, nil)
		return
	}
	snap := result.Snapshot
	raw := clampCraft(snap.Aircraft)
	shaped := shapeFlights(raw, opt)
	dataset["features"] = flightFeatures(shaped, snap.UpdatedAt, mode)
	setString(dataset, "updatedAt", snap.UpdatedAt)
	filtered := filterCraft(raw, opt.BBox)
	maxReturned := flightMax(opt)
	dataset["summary"] = flightSummary(mode, result.Endpoint, "fresh", snap.Total, snap.Valid, len(shaped), len(shaped) < len(filtered), false, &maxReturned)
}

func flightSummary(mode, endpoint, freshness string, raw, valid, returned int, truncated, retained bool, maxReturned *int) map[string]any {
	summary := map[string]any{
		"source": "opensky", "scope": mode, "freshness": freshness,
		"rawAircraftCount": raw, "snapshotValidPositionCount": valid, "returnedCount": returned,
		"truncated": truncated, "retainedPreviousSnapshot": retained,
	}
	putOpt(summary, "sourceEndpoint", endpoint)
	if maxReturned != nil {
		summary["maxReturned"] = *maxReturned
	}
	return summary
}

func adsbFresh(snap *adsbSnapshot, now time.Time) bool {
	if snap.Valid <= 0 {
		return false
	}
	threshold := snap.StaleSec * 1000
	if threshold < 60_000 {
		threshold = 60_000
	}
	updated := parseMillis(snap.UpdatedAt)
	if updated == 0 || now.UnixMilli()-updated > int64(threshold) {
		return false
	}
	latest := snap.LatestObserved
	if latest == "" {
		latest = snap.DiagnosticsLatest
	}
	observed := parseMillis(latest)
	if observed == 0 {
		return false
	}
	return now.UnixMilli()-observed <= int64(threshold)
}

func clampCraft(items []adsbCraft) []adsbCraft {
	out := make([]adsbCraft, len(items))
	for i, item := range items {
		item.Lat = clampFinite(item.Lat, -90, 90)
		item.Lng = clampFinite(item.Lng, -180, 180)
		out[i] = item
	}
	return out
}

func filterCraft(items []adsbCraft, box *[4]float64) []adsbCraft {
	if box == nil {
		return items
	}
	out := make([]adsbCraft, 0, len(items))
	for _, item := range items {
		if insideBBox(item.Lat, item.Lng, *box) {
			out = append(out, item)
		}
	}
	return out
}

func shapeFlights(items []adsbCraft, opt viewOptions) []adsbCraft {
	filtered := filterCraft(items, opt.BBox)
	maxPoints := flightMax(opt)
	if len(filtered) <= maxPoints {
		return filtered
	}
	bounds := clusterBBox(opt.BBox)
	cell := clampFinite(clusterCellSize(opt.Zoom)*0.75, 0.15, 24)
	limit := flightCellLimit(opt.Zoom)
	counts := map[string]int{}
	selected := make([]adsbCraft, 0, maxPoints)
	for _, item := range filtered {
		key := cellKey(item.Lat, item.Lng, bounds, cell)
		if counts[key] >= limit {
			continue
		}
		counts[key]++
		selected = append(selected, item)
		if len(selected) >= maxPoints {
			break
		}
	}
	if len(selected) == 0 {
		return filtered[:maxPoints]
	}
	return selected
}

func flightMax(opt viewOptions) int {
	zoom := clusterZoom(opt.Zoom)
	if opt.BBox == nil {
		switch {
		case zoom <= 2:
			return 180
		case zoom <= 4:
			return 320
		case zoom <= 6:
			return 520
		default:
			return 720
		}
	}
	switch {
	case zoom <= 2:
		return 120
	case zoom <= 4:
		return 220
	case zoom <= 6:
		return 420
	default:
		return 900
	}
}

func flightCellLimit(zoom *float64) int {
	normalized := clusterZoom(zoom)
	switch {
	case normalized <= 2:
		return 1
	case normalized <= 4:
		return 2
	case normalized <= 6:
		return 3
	case normalized <= 8:
		return 5
	default:
		return 8
	}
}

func flightFeatures(items []adsbCraft, updatedAt, mode string) []any {
	out := make([]any, 0, len(items))
	for _, item := range items {
		class := classifyAircraft(item.Callsign, item.ICAO24, mode)
		props := map[string]any{
			"sourceType": "opensky", "source": item.Source, "sourceUpdatedAt": updatedAt,
			"icao24": item.ICAO24, "displayCategory": class.category, "displayCategoryZh": class.categoryZh,
			"role": class.role, "roleZh": class.roleZh, "observedAt": item.ObservedAt,
			"name": flightName(item), "description": flightDescription(item, mode),
		}
		putOpt(props, "callsign", item.Callsign)
		putOpt(props, "registration", item.Registration)
		putOpt(props, "aircraftType", item.AircraftType)
		putOpt(props, "countryCode", item.CountryCode)
		putOpt(props, "countryName", item.CountryName)
		putFloat(props, "heading", item.Heading)
		putFloat(props, "altitudeFt", item.AltitudeFt)
		putFloat(props, "groundSpeedKt", item.GroundSpeedKt)
		out = append(out, map[string]any{
			"id": item.ID, "lat": item.Lat, "lng": item.Lng, "timestamp": item.ObservedAt, "properties": props,
		})
	}
	return out
}

func flightName(item adsbCraft) string {
	if item.Callsign != "" {
		return item.Callsign
	}
	if item.Registration != "" {
		return item.Registration
	}
	return strings.ToUpper(item.ICAO24)
}

func flightDescription(item adsbCraft, mode string) string {
	if item.AircraftType != "" {
		return "OpenSky " + item.AircraftType
	}
	if mode == "military" {
		return "OpenSky military/possibly military flight"
	}
	return "OpenSky flight"
}

type craftClass struct{ category, categoryZh, role, roleZh string }

func classifyAircraft(callsign, icao, mode string) craftClass {
	if !militaryAircraft(callsign, icao, mode) {
		return craftClass{"Civil flight", "民航飞行", "Civil or general aviation", "民航或通用航空"}
	}
	prefix := aircraftPrefix(callsign)
	switch {
	case oneOf(prefix, "RCH", "RRR", "CNV", "CMB", "ASCOT"):
		return craftClass{"Military flight", "军事飞行", "Military transport", "军用运输"}
	case oneOf(prefix, "QID", "SHELL", "MPRS", "TKR"):
		return craftClass{"Military flight", "军事飞行", "Aerial refueling", "空中加油"}
	case oneOf(prefix, "FORTE", "NATO", "MAGMA", "DRAGNET", "AEW"):
		return craftClass{"Military flight", "军事飞行", "ISR / surveillance", "侦察监视"}
	default:
		return craftClass{"Military flight", "军事飞行", "Tactical aircraft", "战术航空器"}
	}
}

func militaryAircraft(callsign, icao, mode string) bool {
	if mode == "military" {
		return true
	}
	text := strings.ToUpper(strings.TrimSpace(callsign))
	if text != "" && (militaryCallsign(text)) {
		return true
	}
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(icao)), "ae")
}

func militaryCallsign(value string) bool {
	return matchPrefix(value, []string{"RCH", "RRR", "CNV", "QID", "GAF", "BAF", "NVY", "NAF", "VM"}, 1, 6) ||
		(strings.HasPrefix(value, "ASCOT") && len(value) > len("ASCOT") && len(value) <= len("ASCOT")+6 && alphaNum(value[len("ASCOT"):]))
}

func matchPrefix(value string, prefixes []string, minTail, maxTail int) bool {
	for _, prefix := range prefixes {
		if !strings.HasPrefix(value, prefix) {
			continue
		}
		tail := value[len(prefix):]
		if len(tail) >= minTail && len(tail) <= maxTail && alphaNum(tail) {
			return true
		}
	}
	return false
}

func alphaNum(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if (r < 'A' || r > 'Z') && (r < '0' || r > '9') {
			return false
		}
	}
	return true
}

func aircraftPrefix(callsign string) string {
	text := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(callsign), " ", ""))
	i := 0
	for i < len(text) && text[i] >= 'A' && text[i] <= 'Z' {
		i++
	}
	if i == 0 {
		return ""
	}
	return text[:i]
}

func oneOf(value string, options ...string) bool {
	for _, option := range options {
		if value == option {
			return true
		}
	}
	return false
}

func layerDataset(response map[string]any, id string) map[string]any {
	layers, _ := response["layers"].(map[string]any)
	dataset, _ := layers[id].(map[string]any)
	return dataset
}

func setString(doc map[string]any, key, value string) {
	if value == "" {
		delete(doc, key)
		return
	}
	doc[key] = value
}

func putOpt(doc map[string]any, key, value string) {
	if value != "" {
		doc[key] = value
	}
}

func putFloat(doc map[string]any, key string, value *float64) {
	if value != nil {
		doc[key] = *value
	}
}

func (s *Service) enrichAIS(ctx context.Context, response map[string]any, orgID string, opt viewOptions) error {
	dataset := layerDataset(response, "ais")
	if dataset == nil || s.snaps == nil {
		return nil
	}
	hints, _ := dataset["renderHints"].(map[string]any)
	next := map[string]any{}
	for key, value := range hints {
		next[key] = value
	}
	next["pickable"] = true
	next["clusterable"] = false
	next["color"] = layerColors["ais"]
	next["radiusScale"] = 1.1
	dataset["renderHints"] = next
	mode := opt.AisMode
	if mode == "" {
		mode = "military"
	}
	snap, err := s.snaps.LatestAis(ctx, orgID)
	if err != nil {
		return err
	}
	state, err := s.snaps.SourceState(ctx, orgID, "ais")
	if err != nil {
		return err
	}
	runtime := aisSemantics(snap, state)
	const staleSec = 20 * 60
	if snap == nil {
		dataset["features"] = []any{}
		if text := cleanString(state["lastSuccessAt"]); text != "" {
			dataset["updatedAt"] = text
		} else {
			delete(dataset, "updatedAt")
		}
		summary := map[string]any{
			"source": "relay", "mode": mode, "configured": runtime.configured, "connected": false,
			"freshness": "missing", "staleThresholdSec": staleSec, "relayVesselCount": 0,
			"disruptionsCount": 0, "densityCount": 0, "candidateCount": 0, "renderedVesselCount": 0,
			"allVesselsAvailable": false,
		}
		if mode == "all" {
			summary["maxReturned"] = aisMax(opt)
			summary["truncated"] = false
			summary["blockedReasonCode"] = "snapshot_unavailable"
			summary["blockedReason"] = "AIS relay snapshot is not available yet."
		}
		putOpt(summary, "statusReasonCode", runtime.code)
		putOpt(summary, "statusReason", runtime.reason)
		dataset["summary"] = summary
		return nil
	}
	updated := parseMillis(snap.UpdatedAt)
	var age *int
	if updated != 0 {
		seconds := int(math.Max(0, math.Round(float64(time.Now().UnixMilli()-updated)/1000)))
		age = &seconds
	}
	freshness := "fresh"
	if age != nil && *age > staleSec {
		freshness = "stale"
	}
	disruptions := disruptionFeatures(filterBreaks(snap.Disruptions, opt.BBox), snap.UpdatedAt)
	var density []any
	if mode != "military" {
		density = densityFeatures(filterZones(snap.Density, opt.BBox))
	}
	pool := []aisVessel{}
	if mode == "all" {
		if snap.HasVessels {
			pool = snap.Ships
		}
	} else if mode == "military" {
		pool = snap.Candidates
	}
	filtered := filterVessels(pool, opt.BBox)
	var viewportCount *int
	if mode == "all" && snap.HasVessels {
		count := len(filtered)
		viewportCount = &count
	}
	shaped := filtered
	if mode == "all" {
		shaped = shapeVessels(pool, opt)
	}
	vesselMode := "military"
	if mode == "all" {
		vesselMode = "all"
	}
	vessels := vesselFeatures(shaped, vesselMode, snap.UpdatedAt)
	features := make([]any, 0, len(density)+len(disruptions)+len(vessels))
	features = append(features, density...)
	features = append(features, disruptions...)
	features = append(features, vessels...)
	dataset["features"] = features
	dataset["updatedAt"] = snap.UpdatedAt
	summary := map[string]any{
		"source": "relay", "sourceEndpoint": snap.Endpoint, "mode": mode, "configured": runtime.configured,
		"connected": runtime.connected, "freshness": freshness, "snapshotUpdatedAt": snap.UpdatedAt,
		"staleThresholdSec": staleSec, "relayVesselCount": snap.Vessels, "disruptionsCount": len(disruptions),
		"densityCount": len(density), "candidateCount": len(snap.Candidates), "renderedVesselCount": len(vessels),
		"allVesselsAvailable": snap.HasVessels, "messageCount": snap.Messages, "clientCount": snap.Clients,
		"droppedMessages": snap.Dropped, "positionReportsSeen": snap.Seen, "positionReportsProcessed": snap.Processed,
		"ignoredPositionReports": snap.Ignored, "parseErrors": snap.ParseErrors,
	}
	if age != nil {
		summary["snapshotAgeSec"] = *age
	}
	putOpt(summary, "statusReasonCode", runtime.code)
	putOpt(summary, "statusReason", runtime.reason)
	if mode == "all" {
		if viewportCount != nil {
			summary["viewportVesselCount"] = *viewportCount
		}
		summary["maxReturned"] = aisMax(opt)
		summary["truncated"] = len(vessels) < len(filtered)
		if !snap.HasVessels {
			summary["blockedReasonCode"] = "missing_vessels_snapshot"
			summary["blockedReason"] = "AIS relay snapshot does not include vessels[] yet."
		}
	}
	dataset["summary"] = summary
	return nil
}

type aisRuntime struct {
	configured, connected bool
	code, reason          string
}

func aisSemantics(snap *aisSnapshot, state map[string]any) aisRuntime {
	configured := true
	if context, ok := state["context"].(map[string]any); ok {
		if context["configured"] == false {
			configured = false
		}
	}
	if snap == nil {
		runtime := aisRuntime{configured: configured}
		if cleanString(state["status"]) == "error" {
			runtime.code = cleanString(state["lastErrorCode"])
			runtime.reason = cleanString(state["lastError"])
		}
		return runtime
	}
	code, reason := snap.ReasonCode, snap.Reason
	if !aisRelayCode(code) {
		code = ""
	}
	if code == "" && reason == "" && snap.Vessels > 0 && !snap.HasVessels {
		code = "ais_snapshot_missing_vessels_contract"
		reason = "AIS relay reports tracked vessels, but the snapshot payload omits vessels[] and only exposes aggregated signals."
	}
	if code == "" && reason == "" && cleanString(state["status"]) == "error" {
		code = cleanString(state["lastErrorCode"])
		reason = cleanString(state["lastError"])
	}
	return aisRuntime{configured: configured, connected: snap.Connected, code: code, reason: reason}
}

func aisRelayCode(value string) bool {
	switch value {
	case "ais_upstream_disconnected", "ais_upstream_no_messages_after_connect", "ais_upstream_stalled",
		"ais_position_reports_not_retained", "ais_position_reports_mostly_ignored", "ais_payload_parse_errors":
		return true
	default:
		return false
	}
}

func filterBreaks(items []aisBreak, box *[4]float64) []aisBreak {
	if box == nil {
		return items
	}
	out := make([]aisBreak, 0)
	for _, item := range items {
		if insideBBox(item.Lat, item.Lng, *box) {
			out = append(out, item)
		}
	}
	return out
}

func filterZones(items []aisZone, box *[4]float64) []aisZone {
	if box == nil {
		return items
	}
	out := make([]aisZone, 0)
	for _, item := range items {
		if insideBBox(item.Lat, item.Lng, *box) {
			out = append(out, item)
		}
	}
	return out
}

func filterVessels(items []aisVessel, box *[4]float64) []aisVessel {
	if box == nil {
		return items
	}
	out := make([]aisVessel, 0)
	for _, item := range items {
		if insideBBox(item.Lat, item.Lng, *box) {
			out = append(out, item)
		}
	}
	return out
}

func shapeVessels(items []aisVessel, opt viewOptions) []aisVessel {
	filtered := filterVessels(items, opt.BBox)
	maxPoints := aisMax(opt)
	if len(filtered) <= maxPoints {
		return filtered
	}
	bounds := clusterBBox(opt.BBox)
	cell := clampFinite(clusterCellSize(opt.Zoom), 0.25, 18)
	limit := flightCellLimit(opt.Zoom)
	counts := map[string]int{}
	sorted := append([]aisVessel(nil), filtered...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].ObservedAt > sorted[j].ObservedAt })
	selected := make([]aisVessel, 0, maxPoints)
	for _, item := range sorted {
		key := cellKey(item.Lat, item.Lng, bounds, cell)
		if counts[key] >= limit {
			continue
		}
		counts[key]++
		selected = append(selected, item)
		if len(selected) >= maxPoints {
			break
		}
	}
	return selected
}

func aisMax(opt viewOptions) int { return flightMax(opt) }

func vesselFeatures(items []aisVessel, mode, updatedAt string) []any {
	out := make([]any, 0, len(items))
	for _, item := range items {
		class := classifyShip(item.ShipType, mode == "military")
		name := item.Name
		if name == "" {
			name = item.MMSI
		}
		description := "AIS vessel"
		if mode == "military" {
			description = "AIS military/government candidate vessel"
		}
		props := map[string]any{
			"sourceType": "ais", "featureKind": "vessel", "mmsi": item.MMSI,
			"shipTypeLabel": class.label, "shipTypeLabelZh": class.labelZh,
			"vesselRole": class.role, "vesselRoleZh": class.roleZh, "isMilitaryCandidate": class.military,
			"observedAt": item.ObservedAt, "sourceUpdatedAt": updatedAt, "name": name, "description": description,
		}
		if item.Name != "" {
			props["name"] = item.Name
		}
		props["name"] = name
		if item.ShipType != nil {
			props["shipType"] = *item.ShipType
		}
		putFloat(props, "heading", item.Heading)
		putFloat(props, "speed", item.Speed)
		putFloat(props, "course", item.Course)
		out = append(out, map[string]any{
			"id": "ais-vessel-" + item.MMSI, "lat": item.Lat, "lng": item.Lng, "timestamp": item.ObservedAt, "properties": props,
		})
	}
	return out
}

type shipClass struct {
	label, labelZh, role, roleZh string
	military                     bool
}

func classifyShip(shipType *float64, military bool) shipClass {
	if shipType == nil || math.IsNaN(*shipType) || math.IsInf(*shipType, 0) {
		role, roleZh := "Other", "其他船舶"
		if military {
			role, roleZh = "Military / government", "军政船舶"
		}
		return shipClass{"Other", "其他船舶", role, roleZh, military}
	}
	normalized := int(math.Trunc(*shipType))
	if military || normalized == 35 || normalized == 55 || (normalized >= 50 && normalized <= 59) {
		return shipClass{"Military / government", "军政船舶", "Military / government", "军政船舶", true}
	}
	switch {
	case normalized >= 30 && normalized <= 39:
		return shipClass{"Fishing", "渔船", "Fishing", "渔业作业", false}
	case normalized >= 40 && normalized <= 49:
		return shipClass{"High-speed craft", "高速船", "High-speed craft", "高速航行", false}
	case normalized >= 60 && normalized <= 69:
		return shipClass{"Passenger", "客船", "Passenger transport", "客运", false}
	case normalized >= 70 && normalized <= 79:
		return shipClass{"Cargo", "货船", "Cargo transport", "货运", false}
	case normalized >= 80 && normalized <= 89:
		return shipClass{"Tanker", "油轮", "Liquid bulk transport", "液货运输", false}
	default:
		return shipClass{"Other", "其他船舶", "Other", "其他船舶", false}
	}
}

func disruptionFeatures(items []aisBreak, updatedAt string) []any {
	out := make([]any, 0, len(items))
	for _, item := range items {
		props := map[string]any{
			"sourceType": "ais", "featureKind": "disruption", "name": item.Name,
			"disruptionType": item.Type, "severity": mapSeverity(item.Severity),
		}
		putFloat(props, "vesselCount", item.VesselCount)
		putFloat(props, "changePct", item.ChangePct)
		putFloat(props, "windowHours", item.WindowHours)
		putOpt(props, "region", item.Region)
		putOpt(props, "description", item.Description)
		putFloat(props, "darkShips", item.Dark)
		row := map[string]any{"id": item.ID, "lat": item.Lat, "lng": item.Lng, "properties": props}
		if updatedAt != "" {
			row["timestamp"] = updatedAt
		}
		out = append(out, row)
	}
	return out
}

func densityFeatures(items []aisZone) []any {
	out := make([]any, 0, len(items))
	for _, item := range items {
		name := item.Name
		if name == "" {
			name = item.ID
		}
		description := item.Note
		if description == "" {
			description = "AIS traffic density zone"
		}
		props := map[string]any{
			"sourceType": "ais", "featureKind": "density", "intensity": item.Intensity,
			"name": name, "description": description,
		}
		putFloat(props, "deltaPct", item.DeltaPct)
		putFloat(props, "shipsPerDay", item.ShipsPerDay)
		putOpt(props, "note", item.Note)
		out = append(out, map[string]any{"id": item.ID, "lat": item.Lat, "lng": item.Lng, "properties": props})
	}
	return out
}

func mapSeverity(value string) string {
	switch value {
	case "high":
		return "high"
	case "elevated":
		return "medium"
	default:
		return "low"
	}
}
