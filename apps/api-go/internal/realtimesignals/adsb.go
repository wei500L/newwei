package realtimesignals

import (
	"context"
	"errors"
	"math"
	"sort"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/dataruntimesettings"
	"github.com/wei500L/newwei/apps/api-go/internal/geocoding"
)

// ADS-B: the conservative military snapshot, its health metric and the retained
// previous snapshot. This is realtime-adsb.service.ts plus the pure helpers in
// realtime-signals.helpers.ts.

// getAdsbStaleThresholdSeconds mirrors the helper: clamp(intervalSec * 6, 10m,
// 30m) after a 60 second floor.
func getAdsbStaleThresholdSeconds(intervalSec int) int {
	safe := intervalSec
	if safe < 60 {
		safe = 60
	}
	value := safe * 6
	if value < minAdsbStaleThresholdSec {
		value = minAdsbStaleThresholdSec
	}
	if value > maxAdsbStaleThresholdSec {
		value = maxAdsbStaleThresholdSec
	}
	return value
}

func getAdsbSnapshotRetentionGraceSeconds(intervalSec int) int {
	return getAdsbStaleThresholdSeconds(intervalSec)
}

// getAdsbSnapshotTtlSeconds mirrors the helper: max(20 minutes, interval * 2).
func getAdsbSnapshotTtlSeconds(intervalSec int) int {
	safe := intervalSec
	if safe < 60 {
		safe = 60
	}
	return maxInt(adsbSnapshotMinTTL, safe*2)
}

// normalizeAdsbAircraftSnapshot mirrors normalizeAdsbAircraftSnapshot. The drop
// reason is returned so the snapshot diagnostics can count each bucket.
func normalizeAdsbAircraftSnapshot(entry jsonRawMessage, fetchedAtMs int64, staleThresholdSec int) (AdsbAircraft, string, bool) {
	state, ok := parseOpenSkyStateVector(entry)
	if !ok {
		return AdsbAircraft{}, "invalid_position", false
	}
	if state.Latitude == nil || state.Longitude == nil ||
		*state.Latitude < -90 || *state.Latitude > 90 ||
		*state.Longitude < -180 || *state.Longitude > 180 {
		return AdsbAircraft{}, "invalid_position", false
	}
	if state.ICAO24 == "" {
		return AdsbAircraft{}, "missing_identity", false
	}
	observedAt := state.LastContactAt
	if observedAt == "" {
		observedAt = formatISO(fetchedAtMs)
	}
	if observedMs, parsed := parseJSTimeMillis(observedAt); parsed && fetchedAtMs-observedMs > int64(staleThresholdSec)*1000 {
		return AdsbAircraft{}, "stale_position", false
	}
	countryCode := resolveOpenSkyCountryCode(state.CountryName)
	countryName := jsTrim(state.CountryName)
	if countryName == "" && countryCode != "" {
		countryName = geocoding.CountryName(countryCode)
	}
	aircraft := AdsbAircraft{
		ID:            state.ICAO24,
		ICAO24:        state.ICAO24,
		Callsign:      state.Callsign,
		Lat:           *state.Latitude,
		Lng:           *state.Longitude,
		Heading:       state.Heading,
		AltitudeFt:    state.AltitudeFt,
		GroundSpeedKt: state.GroundSpeedKt,
		CountryCode:   countryCode,
		CountryName:   countryName,
		ObservedAt:    observedAt,
		Source:        "opensky",
	}
	return aircraft, "", true
}

// scoreAdsbAircraftSnapshot mirrors scoreAdsbAircraftSnapshot.
func scoreAdsbAircraftSnapshot(snapshot AdsbAircraft) int {
	score := 0
	if snapshot.Callsign != "" {
		score++
	}
	if snapshot.Registration != "" {
		score++
	}
	if snapshot.AircraftType != "" {
		score++
	}
	if snapshot.CountryCode != "" {
		score++
	}
	if snapshot.Heading != nil {
		score++
	}
	if snapshot.AltitudeFt != nil {
		score++
	}
	if snapshot.GroundSpeedKt != nil {
		score++
	}
	return score
}

// selectPreferredAdsbAircraftSnapshot mirrors
// selectPreferredAdsbAircraftSnapshot: newest observation wins, then score.
func selectPreferredAdsbAircraftSnapshot(current, candidate AdsbAircraft) AdsbAircraft {
	currentMs, currentOK := parseJSTimeMillis(current.ObservedAt)
	candidateMs, candidateOK := parseJSTimeMillis(candidate.ObservedAt)
	if candidateOK && currentOK {
		if candidateMs > currentMs {
			return candidate
		}
		if candidateMs < currentMs {
			return current
		}
	}
	if scoreAdsbAircraftSnapshot(candidate) >= scoreAdsbAircraftSnapshot(current) {
		return candidate
	}
	return current
}

// buildAdsbLatestSnapshot mirrors buildAdsbLatestSnapshot.
func buildAdsbLatestSnapshot(endpoint string, aircraft []jsonRawMessage, totalAircraft int, fetchedAtMs int64, staleThresholdSec int) AdsbSnapshot {
	chosen := make(map[string]AdsbAircraft, len(aircraft))
	order := make([]string, 0, len(aircraft))
	droppedInvalid := 0
	droppedMissing := 0
	droppedStale := 0
	deduplicated := 0
	for _, entry := range aircraft {
		snapshot, reason, ok := normalizeAdsbAircraftSnapshot(entry, fetchedAtMs, staleThresholdSec)
		if !ok {
			switch reason {
			case "stale_position":
				droppedStale++
			case "missing_identity":
				droppedMissing++
			default:
				droppedInvalid++
			}
			continue
		}
		existing, exists := chosen[snapshot.ID]
		if exists {
			deduplicated++
			chosen[snapshot.ID] = selectPreferredAdsbAircraftSnapshot(existing, snapshot)
			continue
		}
		order = append(order, snapshot.ID)
		chosen[snapshot.ID] = snapshot
	}
	normalized := make([]AdsbAircraft, 0, len(order))
	for _, key := range order {
		normalized = append(normalized, chosen[key])
	}
	sort.SliceStable(normalized, func(left, right int) bool {
		leftMs, leftOK := parseJSTimeMillis(normalized[left].ObservedAt)
		rightMs, rightOK := parseJSTimeMillis(normalized[right].ObservedAt)
		if leftOK && rightOK && rightMs != leftMs {
			return rightMs < leftMs
		}
		return compareUTF16(normalized[left].ID, normalized[right].ID) < 0
	})
	snapshot := AdsbSnapshot{
		Source:             "opensky",
		SourceEndpoint:     endpoint,
		UpdatedAt:          formatISO(fetchedAtMs),
		TotalAircraft:      totalAircraft,
		ValidPositionCount: len(chosen),
		Diagnostics: AdsbSnapshotDiagnostics{
			StaleThresholdSec:           staleThresholdSec,
			DroppedInvalidPositionCount: droppedInvalid,
			DroppedMissingIdentityCount: droppedMissing,
			DroppedStalePositionCount:   droppedStale,
			DeduplicatedCount:           deduplicated,
			RetainedPreviousSnapshot:    false,
		},
		Aircraft: normalized,
	}
	if len(normalized) > 0 {
		snapshot.LatestObservedAt = normalized[0].ObservedAt
		snapshot.Diagnostics.LatestObservedAt = normalized[0].ObservedAt
		snapshot.Diagnostics.OldestObservedAt = normalized[len(normalized)-1].ObservedAt
	}
	return snapshot
}

// selectAdsbSnapshotToStore mirrors selectAdsbSnapshotToStore: an empty fetch
// keeps the previous snapshot for one retention grace period.
func selectAdsbSnapshotToStore(previous *AdsbSnapshot, next AdsbSnapshot, fetchedAtMs int64, intervalSec int) AdsbSnapshot {
	if next.ValidPositionCount > 0 || previous == nil {
		return next
	}
	previousUpdatedMs, ok := parseJSTimeMillis(previous.UpdatedAt)
	if !ok || fetchedAtMs-previousUpdatedMs > int64(getAdsbSnapshotRetentionGraceSeconds(intervalSec))*1000 {
		return next
	}
	latestObserved := previous.LatestObservedAt
	if latestObserved == "" {
		latestObserved = previous.Diagnostics.LatestObservedAt
	}
	retained := *previous
	retained.SourceEndpoint = next.SourceEndpoint
	retained.TotalAircraft = next.TotalAircraft
	retained.LatestObservedAt = latestObserved
	retained.Diagnostics = AdsbSnapshotDiagnostics{
		LatestObservedAt:            latestObserved,
		OldestObservedAt:            previous.Diagnostics.OldestObservedAt,
		StaleThresholdSec:           next.Diagnostics.StaleThresholdSec,
		DroppedInvalidPositionCount: next.Diagnostics.DroppedInvalidPositionCount,
		DroppedMissingIdentityCount: next.Diagnostics.DroppedMissingIdentityCount,
		DroppedStalePositionCount:   next.Diagnostics.DroppedStalePositionCount,
		DeduplicatedCount:           next.Diagnostics.DeduplicatedCount,
		RetainedPreviousSnapshot:    true,
	}
	return retained
}

// buildAdsbRuntimeDiagnostics mirrors buildAdsbRuntimeDiagnostics.
func buildAdsbRuntimeDiagnostics(snapshot *AdsbSnapshot, rawAircraftCount, currentValidPositionCount int, nowMs int64, intervalSec int) AdsbRuntimeDiagnostics {
	staleThresholdSec := getAdsbStaleThresholdSeconds(intervalSec)
	if snapshot != nil {
		staleThresholdSec = snapshot.Diagnostics.StaleThresholdSec
	}
	if snapshot == nil {
		return AdsbRuntimeDiagnostics{
			Freshness:                 "missing",
			RawAircraftCount:          rawAircraftCount,
			CurrentValidPositionCount: currentValidPositionCount,
			StaleThresholdSec:         staleThresholdSec,
		}
	}
	diagnostics := AdsbRuntimeDiagnostics{
		RawAircraftCount:            rawAircraftCount,
		CurrentValidPositionCount:   currentValidPositionCount,
		SnapshotValidPositionCount:  snapshot.ValidPositionCount,
		SnapshotUpdatedAt:           snapshot.UpdatedAt,
		StaleThresholdSec:           staleThresholdSec,
		RetainedPreviousSnapshot:    snapshot.Diagnostics.RetainedPreviousSnapshot,
		DroppedInvalidPositionCount: snapshot.Diagnostics.DroppedInvalidPositionCount,
		DroppedMissingIdentityCount: snapshot.Diagnostics.DroppedMissingIdentityCount,
		DroppedStalePositionCount:   snapshot.Diagnostics.DroppedStalePositionCount,
		DeduplicatedCount:           snapshot.Diagnostics.DeduplicatedCount,
	}
	if updatedMs, ok := parseJSTimeMillis(snapshot.UpdatedAt); ok {
		age := roundSeconds(nowMs - updatedMs)
		diagnostics.SnapshotAgeSec = &age
	}
	latestObserved := snapshot.LatestObservedAt
	if latestObserved == "" {
		latestObserved = snapshot.Diagnostics.LatestObservedAt
	}
	if latestObserved != "" {
		diagnostics.LatestObservedAt = latestObserved
		if observedMs, ok := parseJSTimeMillis(latestObserved); ok {
			age := roundSeconds(nowMs - observedMs)
			diagnostics.LatestObservedAgeSec = &age
		}
	}
	fresh := snapshot.ValidPositionCount > 0
	if diagnostics.SnapshotAgeSec != nil && *diagnostics.SnapshotAgeSec > staleThresholdSec {
		fresh = false
	}
	if diagnostics.LatestObservedAgeSec != nil && *diagnostics.LatestObservedAgeSec > staleThresholdSec {
		fresh = false
	}
	if fresh {
		diagnostics.Freshness = "fresh"
	} else {
		diagnostics.Freshness = "stale"
	}
	return diagnostics
}

// computeAdsbSnapshotHealthValue mirrors computeAdsbSnapshotHealthValue.
func computeAdsbSnapshotHealthValue(snapshot AdsbSnapshot, diagnostics AdsbRuntimeDiagnostics) float64 {
	if diagnostics.Freshness == "missing" || diagnostics.Freshness == "stale" {
		return 2
	}
	if snapshot.Diagnostics.RetainedPreviousSnapshot {
		return 1
	}
	return 0
}

// fetchAdsbSignal mirrors RealtimeAdsbService.fetchAdsbSignal. The military fetch
// itself is shared per round (B1), but the snapshot, transport write and metric
// contexts stay per organization.
func (s *Service) fetchAdsbSignal(ctx context.Context, orgID string, runtime *dataruntimesettings.RealtimeCronRuntime, round *roundContext) ([]FetchResult, error) {
	endpoint := openSkyBaseURL(runtime) + "/states/all?regions=" + militaryRegionKeys()
	nowMs := s.clockMillis()
	budget, err := s.openSky.getBudgetSummary(ctx, runtime, nowMs)
	if err != nil {
		return nil, err
	}
	effectiveIntervalSec := budget.EffectiveMilitaryIntervalSec
	budgetContext := buildBudgetContext(budget)
	if !hasOpenSkyCredentials(runtime) {
		if err := s.store.clearLatestAdsbSnapshot(ctx, orgID); err != nil {
			return nil, err
		}
		return []FetchResult{
			{
				MetricSlug: metricOpensky,
				Value:      0,
				Context: &openSkyNotConfiguredMetricContext{
					Source: "opensky", Scope: "military", Configured: false,
					AuthRequired: true, AuthMode: "oauth2_client_credentials", SourceEndpoint: endpoint,
					TotalAircraft: 0, MilitaryCount: 0, ValidPositionCount: 0, SnapshotValidPositionCount: 0,
					CountryCodes: []string{}, openSkyBudgetContext: budgetContext,
				},
			},
			{
				MetricSlug: metricOpenskySnapshotHealth,
				Value:      0,
				Context: &openSkyNotConfiguredHealthContext{
					Source: "opensky", Scope: "military", Configured: false,
					AuthRequired: true, AuthMode: "oauth2_client_credentials", SourceEndpoint: endpoint,
					HealthState: "missing", SnapshotFreshness: "missing", Stale: false,
					RawAircraftCount: 0, CurrentValidPositionCount: 0, SnapshotValidPositionCount: 0,
					CountryCodes: []string{}, openSkyBudgetContext: budgetContext,
				},
			},
		}, nil
	}

	previousSnapshot, err := s.store.getLatestAdsbSnapshot(ctx, orgID)
	if err != nil {
		return nil, err
	}
	militaryStates, militaryErr := round.militaryStates(ctx, s, runtime, &budget)
	if militaryErr != nil {
		var exhausted *budgetExhaustedError
		var reserve *budgetReserveError
		if !errors.As(militaryErr, &exhausted) && !errors.As(militaryErr, &reserve) {
			return nil, militaryErr
		}
		return s.pausedAdsbResults(orgID, endpoint, previousSnapshot, militaryErr, budgetContext, effectiveIntervalSec, nowMs), nil
	}

	militaryCount := len(militaryStates)
	countrySet := make([]string, 0, militaryCount)
	for _, state := range militaryStates {
		if code := resolveOpenSkyCountryCode(state.CountryName); code != "" {
			countrySet = append(countrySet, code)
		}
	}
	countryCodes := sortedUnique(countrySet)
	rawEntries := make([]jsonRawMessage, 0, militaryCount)
	for _, state := range militaryStates {
		rawEntries = append(rawEntries, state.Raw)
	}
	nextSnapshot := buildAdsbLatestSnapshot(endpoint, rawEntries, militaryCount, nowMs,
		getAdsbStaleThresholdSeconds(effectiveIntervalSec))
	latestSnapshot := selectAdsbSnapshotToStore(previousSnapshot, nextSnapshot, nowMs, effectiveIntervalSec)
	if err := s.store.setLatestAdsbSnapshot(ctx, orgID, latestSnapshot, getAdsbSnapshotTtlSeconds(effectiveIntervalSec)); err != nil {
		return nil, err
	}
	if err := s.transport.persistAircraftTransportSnapshot(ctx, orgID, nextSnapshot.Aircraft, nextSnapshot.UpdatedAt, "military"); err != nil {
		return nil, err
	}
	adsbDiagnostics := buildAdsbRuntimeDiagnostics(&latestSnapshot, militaryCount, nextSnapshot.ValidPositionCount, nowMs, effectiveIntervalSec)

	return []FetchResult{
		{
			MetricSlug: metricOpensky,
			Value:      float64(militaryCount),
			Context: &openSkyMetricContext{
				Source: "opensky", SourceEndpoint: endpoint, Scope: "military", Configured: true,
				AuthRequired: true, AuthMode: "oauth2_client_credentials",
				TotalAircraft: float64(militaryCount), MilitaryCount: float64(militaryCount),
				ValidPositionCount:          float64(nextSnapshot.ValidPositionCount),
				SnapshotValidPositionCount:  float64(latestSnapshot.ValidPositionCount),
				LatestObservedAt:            firstNonEmpty(latestSnapshot.LatestObservedAt, latestSnapshot.Diagnostics.LatestObservedAt, latestSnapshot.UpdatedAt),
				SnapshotUpdatedAt:           latestSnapshot.UpdatedAt,
				SnapshotFreshness:           adsbDiagnostics.Freshness,
				SnapshotAgeSec:              floatPtr(adsbDiagnostics.SnapshotAgeSec),
				LatestObservedAgeSec:        floatPtr(adsbDiagnostics.LatestObservedAgeSec),
				SnapshotRetainedPrevious:    latestSnapshot.Diagnostics.RetainedPreviousSnapshot,
				StaleThresholdSec:           latestSnapshot.Diagnostics.StaleThresholdSec,
				DroppedInvalidPositionCount: float64(nextSnapshot.Diagnostics.DroppedInvalidPositionCount),
				DroppedMissingIdentityCount: float64(nextSnapshot.Diagnostics.DroppedMissingIdentityCount),
				DroppedStalePositionCount:   float64(nextSnapshot.Diagnostics.DroppedStalePositionCount),
				DeduplicatedCount:           float64(nextSnapshot.Diagnostics.DeduplicatedCount),
				CountryCodes:                countryCodes,
				openSkyBudgetContext:        budgetContext,
			},
		},
		{
			MetricSlug: metricOpenskySnapshotHealth,
			Value:      computeAdsbSnapshotHealthValue(latestSnapshot, adsbDiagnostics),
			Context: &openSkyHealthContext{
				Source: "opensky", SourceEndpoint: endpoint, Scope: "military", Configured: true,
				AuthRequired: true, AuthMode: "oauth2_client_credentials",
				HealthState:                 adsbDiagnostics.Freshness,
				Stale:                       adsbDiagnostics.Freshness != "fresh",
				SnapshotRetainedPrevious:    latestSnapshot.Diagnostics.RetainedPreviousSnapshot,
				SnapshotFreshness:           adsbDiagnostics.Freshness,
				SnapshotUpdatedAt:           latestSnapshot.UpdatedAt,
				LatestTimestamp:             firstNonEmpty(latestSnapshot.LatestObservedAt, latestSnapshot.Diagnostics.LatestObservedAt, latestSnapshot.UpdatedAt),
				MaxStaleMinutes:             math.Max(1, jsRound(float64(latestSnapshot.Diagnostics.StaleThresholdSec)/60)),
				RawAircraftCount:            float64(adsbDiagnostics.RawAircraftCount),
				CurrentValidPositionCount:   float64(adsbDiagnostics.CurrentValidPositionCount),
				SnapshotValidPositionCount:  float64(adsbDiagnostics.SnapshotValidPositionCount),
				DroppedInvalidPositionCount: float64(latestSnapshot.Diagnostics.DroppedInvalidPositionCount),
				DroppedMissingIdentityCount: float64(latestSnapshot.Diagnostics.DroppedMissingIdentityCount),
				DroppedStalePositionCount:   float64(latestSnapshot.Diagnostics.DroppedStalePositionCount),
				DeduplicatedCount:           float64(latestSnapshot.Diagnostics.DeduplicatedCount),
				CountryCodes:                countryCodes,
				openSkyBudgetContext:        budgetContext,
			},
		},
	}, nil
}

// pausedAdsbResults mirrors the OpenSkyBudgetExhaustedError/ReserveError branch:
// every organization keeps its own previous snapshot and budget context.
func (s *Service) pausedAdsbResults(orgID, endpoint string, previousSnapshot *AdsbSnapshot, militaryErr error, budgetContext openSkyBudgetContext, effectiveIntervalSec int, nowMs int64) []FetchResult {
	militaryCount := 0
	rawAircraftCount := 0
	validPositionCount := 0
	if previousSnapshot != nil {
		militaryCount = len(previousSnapshot.Aircraft)
		rawAircraftCount = previousSnapshot.TotalAircraft
		validPositionCount = previousSnapshot.ValidPositionCount
	}
	diagnostics := buildAdsbRuntimeDiagnostics(previousSnapshot, rawAircraftCount, validPositionCount, nowMs, effectiveIntervalSec)
	countrySet := make([]string, 0)
	if previousSnapshot != nil {
		for _, entry := range previousSnapshot.Aircraft {
			if entry.CountryCode != "" {
				countrySet = append(countrySet, entry.CountryCode)
			}
		}
	}
	countryCodes := sortedUnique(countrySet)
	var reserve *budgetReserveError
	reservationFailed := errors.As(militaryErr, &reserve)

	healthValue := 2.0
	if previousSnapshot != nil && diagnostics.Freshness == "fresh" {
		healthValue = computeAdsbSnapshotHealthValue(*previousSnapshot, diagnostics)
	}
	metricContext := &openSkyMetricContext{
		Source: "opensky", SourceEndpoint: endpoint, Scope: "military", Configured: true,
		AuthRequired: true, AuthMode: "oauth2_client_credentials",
		TotalAircraft:               float64(rawAircraftCount),
		MilitaryCount:               float64(militaryCount),
		ValidPositionCount:          float64(validPositionCount),
		SnapshotValidPositionCount:  float64(validPositionCount),
		LatestObservedAt:            snapshotLatest(previousSnapshot),
		SnapshotUpdatedAt:           snapshotUpdatedAt(previousSnapshot),
		SnapshotFreshness:           diagnostics.Freshness,
		SnapshotAgeSec:              floatPtr(diagnostics.SnapshotAgeSec),
		LatestObservedAgeSec:        floatPtr(diagnostics.LatestObservedAgeSec),
		SnapshotRetainedPrevious:    previousSnapshot != nil && previousSnapshot.Diagnostics.RetainedPreviousSnapshot,
		StaleThresholdSec:           diagnostics.StaleThresholdSec,
		DroppedInvalidPositionCount: float64(snapshotDiagnosticValue(previousSnapshot, func(d AdsbSnapshotDiagnostics) int { return d.DroppedInvalidPositionCount })),
		DroppedMissingIdentityCount: float64(snapshotDiagnosticValue(previousSnapshot, func(d AdsbSnapshotDiagnostics) int { return d.DroppedMissingIdentityCount })),
		DroppedStalePositionCount:   float64(snapshotDiagnosticValue(previousSnapshot, func(d AdsbSnapshotDiagnostics) int { return d.DroppedStalePositionCount })),
		DeduplicatedCount:           float64(snapshotDiagnosticValue(previousSnapshot, func(d AdsbSnapshotDiagnostics) int { return d.DeduplicatedCount })),
		CountryCodes:                countryCodes,
		openSkyBudgetContext:        budgetContext,
	}
	healthContext := &openSkyHealthContext{
		Source: "opensky", SourceEndpoint: endpoint, Scope: "military", Configured: true,
		AuthRequired: true, AuthMode: "oauth2_client_credentials",
		HealthState:                 diagnostics.Freshness,
		Stale:                       diagnostics.Freshness != "fresh",
		SnapshotRetainedPrevious:    previousSnapshot != nil && previousSnapshot.Diagnostics.RetainedPreviousSnapshot,
		SnapshotFreshness:           diagnostics.Freshness,
		SnapshotUpdatedAt:           snapshotUpdatedAt(previousSnapshot),
		LatestTimestamp:             snapshotLatest(previousSnapshot),
		MaxStaleMinutes:             math.Max(1, jsRound(float64(diagnostics.StaleThresholdSec)/60)),
		RawAircraftCount:            float64(rawAircraftCount),
		CurrentValidPositionCount:   float64(validPositionCount),
		SnapshotValidPositionCount:  float64(validPositionCount),
		DroppedInvalidPositionCount: float64(snapshotDiagnosticValue(previousSnapshot, func(d AdsbSnapshotDiagnostics) int { return d.DroppedInvalidPositionCount })),
		DroppedMissingIdentityCount: float64(snapshotDiagnosticValue(previousSnapshot, func(d AdsbSnapshotDiagnostics) int { return d.DroppedMissingIdentityCount })),
		DroppedStalePositionCount:   float64(snapshotDiagnosticValue(previousSnapshot, func(d AdsbSnapshotDiagnostics) int { return d.DroppedStalePositionCount })),
		DeduplicatedCount:           float64(snapshotDiagnosticValue(previousSnapshot, func(d AdsbSnapshotDiagnostics) int { return d.DeduplicatedCount })),
		CountryCodes:                countryCodes,
		openSkyBudgetContext:        budgetContext,
	}
	if reservationFailed {
		metricContext.BudgetReservationFailed = true
		metricContext.BudgetReservationFailureCode = "opensky_budget_insufficient_credits"
		healthContext.BudgetReservationFailed = true
		healthContext.BudgetReservationFailureCode = "opensky_budget_insufficient_credits"
	}
	return []FetchResult{
		{MetricSlug: metricOpensky, Value: float64(militaryCount), Context: metricContext},
		{MetricSlug: metricOpenskySnapshotHealth, Value: healthValue, Context: healthContext},
	}
}

func militaryRegionKeys() string {
	keys := make([]string, 0, len(openskyMilitaryRegions))
	for _, region := range openskyMilitaryRegions {
		keys = append(keys, region.Key)
	}
	return strings.Join(keys, ",")
}

func sortedUnique(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}
	out := dedupeStringsPreserve(values)
	sortStringsJS(out)
	return out
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func floatPtr(value *int) *float64 {
	if value == nil {
		return nil
	}
	converted := float64(*value)
	return &converted
}

func snapshotLatest(snapshot *AdsbSnapshot) string {
	if snapshot == nil {
		return ""
	}
	return firstNonEmpty(snapshot.LatestObservedAt, snapshot.Diagnostics.LatestObservedAt, snapshot.UpdatedAt)
}

func snapshotUpdatedAt(snapshot *AdsbSnapshot) string {
	if snapshot == nil {
		return ""
	}
	return snapshot.UpdatedAt
}

func snapshotDiagnosticValue(snapshot *AdsbSnapshot, pick func(AdsbSnapshotDiagnostics) int) int {
	if snapshot == nil {
		return 0
	}
	return pick(snapshot.Diagnostics)
}
