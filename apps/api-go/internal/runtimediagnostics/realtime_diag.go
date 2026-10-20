package runtimediagnostics

import (
	"context"
	"encoding/json"
	"math"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/dataruntimesettings"
)

// ---- OpenSky budget ----

func (s *RealtimeService) budgetSummary(ctx context.Context, runtime *dataruntimesettings.RealtimeRuntimeSettings, nowMs int64) (openskyBudgetSummary, error) {
	now := time.UnixMilli(nowMs)
	dateHKT := now.In(hktZone).Format("2006-01-02")
	recentDates := make([]string, 0, openskyBudgetRecentDays)
	for index := 0; index < openskyBudgetRecentDays; index++ {
		recentDates = append(recentDates, now.Add(-time.Duration(index)*24*time.Hour).In(hktZone).Format("2006-01-02"))
	}

	today, err := s.store.budgetDay(ctx, dateHKT)
	if err != nil {
		return openskyBudgetSummary{}, err
	}
	recent := make([]openskyDaySummary, 0, len(recentDates))
	for _, date := range recentDates {
		day, err := s.store.budgetDay(ctx, date)
		if err != nil {
			return openskyBudgetSummary{}, err
		}
		recent = append(recent, daySummary(day))
	}

	dailyBudget := runtime.OpenskyDailyCreditBudget
	if dailyBudget < 1 {
		dailyBudget = 1
	}
	usedCredits := today.UsedCredits
	remaining := math.Max(0, float64(dailyBudget)-usedCredits)
	usagePct := round2(usedCredits / float64(dailyBudget) * 100)
	remainingPct := round2(remaining / float64(dailyBudget) * 100)
	period := budgetPeriod(runtime, now)
	degradation := budgetDegradation(runtime, remaining, remainingPct)
	effective := effectiveMilitaryInterval(runtime, period, degradation)

	return openskyBudgetSummary{
		Timezone:                     "Asia/Hong_Kong",
		DateHKT:                      dateHKT,
		DailyBudget:                  dailyBudget,
		UsedCredits:                  usedCredits,
		RemainingCredits:             remaining,
		UsagePct:                     usagePct,
		RemainingPct:                 remainingPct,
		RequestCount:                 today.RequestCount,
		MilitaryCredits:              today.MilitaryCredits,
		AllCredits:                   today.AllCredits,
		MilitaryCalls:                today.MilitaryCalls,
		AllCalls:                     today.AllCalls,
		ErrorCalls:                   today.ErrorCalls,
		AuthErrorCalls:               today.AuthErrorCalls,
		RateLimitedErrorCalls:        today.RateLimitedErrorCalls,
		ServerErrorCalls:             today.ServerErrorCalls,
		TimeoutErrorCalls:            today.TimeoutErrorCalls,
		NetworkErrorCalls:            today.NetworkErrorCalls,
		UnknownErrorCalls:            today.UnknownErrorCalls,
		BlockedAllModeCount:          today.BlockedAllModeCount,
		SkippedMilitaryCount:         today.SkippedMilitaryCount,
		CurrentPeriod:                period,
		DayIntervalSec:               runtime.OpenskyDayIntervalSec,
		NightIntervalSec:             runtime.OpenskyNightIntervalSec,
		EffectiveMilitaryIntervalSec: effective,
		DegradationLevel:             degradation,
		AllModeBlocked:               degradation != "normal",
		MilitaryPaused:               degradation == "exhausted",
		WarningRemainingPct:          runtime.OpenskyWarningRemainingPct,
		CriticalRemainingPct:         runtime.OpenskyCriticalRemainingPct,
		RecentDays:                   recent,
	}, nil
}

func daySummary(day openskyBudgetDay) openskyDaySummary {
	return openskyDaySummary{
		DateHKT:               day.DateHKT,
		UsedCredits:           day.UsedCredits,
		RequestCount:          day.RequestCount,
		MilitaryCredits:       day.MilitaryCredits,
		AllCredits:            day.AllCredits,
		MilitaryCalls:         day.MilitaryCalls,
		AllCalls:              day.AllCalls,
		ErrorCalls:            day.ErrorCalls,
		AuthErrorCalls:        day.AuthErrorCalls,
		RateLimitedErrorCalls: day.RateLimitedErrorCalls,
		ServerErrorCalls:      day.ServerErrorCalls,
		TimeoutErrorCalls:     day.TimeoutErrorCalls,
		NetworkErrorCalls:     day.NetworkErrorCalls,
		UnknownErrorCalls:     day.UnknownErrorCalls,
		BlockedAllModeCount:   day.BlockedAllModeCount,
		SkippedMilitaryCount:  day.SkippedMilitaryCount,
	}
}

func budgetPeriod(runtime *dataruntimesettings.RealtimeRuntimeSettings, now time.Time) string {
	hour := now.In(hktZone).Hour()
	if hour >= runtime.OpenskyDayStartHourHKT && hour < runtime.OpenskyNightStartHourHKT {
		return "day"
	}
	return "night"
}

func budgetDegradation(runtime *dataruntimesettings.RealtimeRuntimeSettings, remaining, remainingPct float64) string {
	if remaining <= 0 {
		return "exhausted"
	}
	if remainingPct <= float64(runtime.OpenskyCriticalRemainingPct) {
		return "critical"
	}
	if remainingPct <= float64(runtime.OpenskyWarningRemainingPct) {
		return "warning"
	}
	return "normal"
}

func effectiveMilitaryInterval(runtime *dataruntimesettings.RealtimeRuntimeSettings, period, degradation string) int {
	configured := runtime.OpenskyDayIntervalSec
	if period == "night" {
		configured = runtime.OpenskyNightIntervalSec
	}
	if degradation == "critical" || degradation == "exhausted" {
		if configured < runtime.OpenskyNightIntervalSec {
			return runtime.OpenskyNightIntervalSec
		}
	}
	return configured
}

func round2(value float64) float64 {
	return math.Round(value*100) / 100
}

// ---- ADS-B ----

func getAdsbStaleThresholdSeconds(intervalSec int) int {
	safe := intervalSec
	if safe < 60 {
		safe = 60
	}
	value := safe * 6
	if value < minAdsbStaleThreshold {
		value = minAdsbStaleThreshold
	}
	if value > maxAdsbStaleThreshold {
		value = maxAdsbStaleThreshold
	}
	return value
}

func buildAdsbRuntimeDiagnostics(snapshot *adsbSnapshot, rawAircraft, validPositions int, nowMs int64, intervalSec int) adsbRuntimeDiagnostics {
	staleThreshold := getAdsbStaleThresholdSeconds(intervalSec)
	if snapshot != nil {
		staleThreshold = snapshot.Diagnostics.StaleThresholdSec
	}
	if snapshot == nil {
		return adsbRuntimeDiagnostics{
			Freshness:                   "missing",
			RawAircraftCount:            rawAircraft,
			CurrentValidPositionCount:   validPositions,
			SnapshotValidPositionCount:  0,
			StaleThresholdSec:           staleThreshold,
			RetainedPreviousSnapshot:    false,
			DroppedInvalidPositionCount: 0,
			DroppedMissingIdentityCount: 0,
			DroppedStalePositionCount:   0,
			DeduplicatedCount:           0,
		}
	}
	result := adsbRuntimeDiagnostics{
		RawAircraftCount:            rawAircraft,
		CurrentValidPositionCount:   validPositions,
		SnapshotValidPositionCount:  snapshot.ValidPositionCount,
		StaleThresholdSec:           staleThreshold,
		RetainedPreviousSnapshot:    snapshot.Diagnostics.RetainedPreviousSnapshot,
		DroppedInvalidPositionCount: snapshot.Diagnostics.DroppedInvalidPosition,
		DroppedMissingIdentityCount: snapshot.Diagnostics.DroppedMissingIdentity,
		DroppedStalePositionCount:   snapshot.Diagnostics.DroppedStalePosition,
		DeduplicatedCount:           snapshot.Diagnostics.DeduplicatedCount,
	}
	if snapshot.UpdatedAt != "" {
		updated := snapshot.UpdatedAt
		result.SnapshotUpdatedAt = &updated
	}
	if updatedMs, ok := parseTimestampMs(snapshot.UpdatedAt); ok {
		age := roundSeconds(nowMs - updatedMs)
		result.SnapshotAgeSec = &age
	}
	latestObserved := snapshot.LatestObservedAt
	if latestObserved == nil || *latestObserved == "" {
		latestObserved = snapshot.Diagnostics.LatestObservedAt
	}
	if latestObserved != nil && *latestObserved != "" {
		result.LatestObservedAt = latestObserved
		if observedMs, ok := parseTimestampMs(*latestObserved); ok {
			age := roundSeconds(nowMs - observedMs)
			result.LatestObservedAgeSec = &age
		}
	}
	fresh := true
	if snapshot.ValidPositionCount <= 0 {
		fresh = false
	}
	if result.SnapshotAgeSec != nil && *result.SnapshotAgeSec > staleThreshold {
		fresh = false
	}
	if result.LatestObservedAgeSec != nil && *result.LatestObservedAgeSec > staleThreshold {
		fresh = false
	}
	if fresh {
		result.Freshness = "fresh"
	} else {
		result.Freshness = "stale"
	}
	return result
}

func roundSeconds(deltaMs int64) int {
	value := int(math.Round(float64(deltaMs) / 1000))
	if value < 0 {
		value = 0
	}
	return value
}

// ---- AIS ----

var aisRelayReasonCodes = map[string]bool{
	"ais_upstream_disconnected":              true,
	"ais_upstream_no_messages_after_connect": true,
	"ais_upstream_stalled":                   true,
	"ais_position_reports_not_retained":      true,
	"ais_position_reports_mostly_ignored":    true,
	"ais_payload_parse_errors":               true,
}

const aisSnapshotMissingVesselsReason = "AIS relay reports tracked vessels, but the snapshot payload omits vessels[] and only exposes aggregated signals."

func buildAisRuntimeSemantics(snapshot *aisSnapshot, state *sourceState) aisRuntimeSemantics {
	configured := true
	if state != nil {
		if value, ok := state.Context.boolean("configured"); ok && !value {
			configured = false
		}
	}
	if snapshot == nil {
		result := aisRuntimeSemantics{diagnostics: aisRuntimeDiagnostics{
			Configured:  configured,
			Connected:   false,
			HealthState: "ok",
		}}
		if state != nil && state.Status == "error" && state.LastError != nil && strings.TrimSpace(*state.LastError) != "" {
			if state.LastErrorCode != nil {
				result.statusReasonCode = strings.TrimSpace(*state.LastErrorCode)
			}
			result.statusReason = strings.TrimSpace(*state.LastError)
		}
		return result
	}

	diagnostics := snapshot.Diagnostics
	if diagnostics.HealthState == "" {
		diagnostics = aisRelayDiagnostics{HealthState: "ok"}
	}
	relayCode, relayReason := readRelayReason(diagnostics)
	var reasonCode, reason string
	if relayCode != "" || relayReason != "" {
		reasonCode, reason = relayCode, relayReason
	} else if snapshot.Status.Vessels <= 0 && !snapshot.HasVesselSnapshot {
		reasonCode = "ais_snapshot_missing_vessels_contract"
		reason = aisSnapshotMissingVesselsReason
	}

	fallbackCode, fallbackReason := "", ""
	if state != nil && state.Status == "error" && state.LastError != nil && strings.TrimSpace(*state.LastError) != "" {
		if state.LastErrorCode != nil {
			fallbackCode = strings.TrimSpace(*state.LastErrorCode)
		}
		fallbackReason = strings.TrimSpace(*state.LastError)
	}

	entry := aisRuntimeDiagnostics{
		Configured:               configured,
		Connected:                snapshot.Status.Connected,
		HealthState:              diagnostics.HealthState,
		AllVesselsAvailable:      snapshot.HasVesselSnapshot,
		CandidateCount:           len(snapshot.CandidateReports),
		VesselCount:              snapshot.Status.Vessels,
		DisruptionsCount:         len(snapshot.Disruptions),
		DensityRegions:           len(snapshot.Density),
		MessageCount:             snapshot.Status.Messages,
		DroppedMessages:          snapshot.Status.DroppedMessages,
		PositionReportsSeen:      diagnostics.PositionReportsSeen,
		PositionReportsProcessed: diagnostics.PositionReportsProcessed,
		IgnoredPositionReports:   diagnostics.IgnoredPositionReports,
		ParseErrors:              diagnostics.ParseErrors,
		StatusReasonCode:         reasonCode,
		StatusReason:             reason,
		LastHealthyAt:            diagnostics.LastHealthyAt,
		LastIssueAt:              diagnostics.LastIssueAt,
		LastConnectedAt:          diagnostics.LastConnectedAt,
		LastMessageAt:            diagnostics.LastMessageAt,
		LastUpstreamErrorAt:      diagnostics.LastUpstreamErrorAt,
		LastUpstreamError:        diagnostics.LastUpstreamError,
		LastParseErrorAt:         diagnostics.LastParseErrorAt,
		LastParseError:           diagnostics.LastParseError,
	}
	if snapshot.UpdatedAt != "" {
		updated := snapshot.UpdatedAt
		entry.SnapshotUpdatedAt = &updated
	}
	if reasonCode == "" && fallbackCode != "" {
		entry.StatusReasonCode = fallbackCode
	}
	if reason == "" && fallbackReason != "" {
		entry.StatusReason = fallbackReason
	}
	return aisRuntimeSemantics{
		diagnostics:      entry,
		statusReasonCode: entry.StatusReasonCode,
		statusReason:     entry.StatusReason,
	}
}

func readRelayReason(diagnostics aisRelayDiagnostics) (string, string) {
	code := ""
	if diagnostics.StatusReasonCode != nil {
		candidate := strings.TrimSpace(*diagnostics.StatusReasonCode)
		if aisRelayReasonCodes[candidate] {
			code = candidate
		}
	}
	reason := ""
	if diagnostics.StatusReason != nil {
		reason = strings.TrimSpace(*diagnostics.StatusReason)
	}
	return code, reason
}

// ---- source status ----

func resolveRuntimeSourceStatus(source string, enabled bool, intervalSec int, state *sourceState, lastRunMs *float64, context diagnosticContext, ais *aisRuntimeSemantics, nowMs int64) (string, string, string) {
	if !enabled {
		return "idle", "source_disabled", "Source is disabled."
	}
	if code, reason, found := missingConfigReason(source, context); found {
		return "not_configured", code, reason
	}

	var lastSuccessMs *int64
	if state != nil {
		lastSuccessMs = parseTimestampPtr(state.LastSuccessAt)
	}
	if lastSuccessMs == nil && lastRunMs != nil {
		value := int64(*lastRunMs)
		lastSuccessMs = &value
	}
	var lastErrorMs *int64
	if state != nil {
		lastErrorMs = parseTimestampPtr(state.LastErrorAt)
	}
	if state != nil && state.Status == "error" && state.LastError != nil && *state.LastError != "" &&
		(lastSuccessMs == nil || (lastErrorMs != nil && *lastErrorMs >= *lastSuccessMs)) {
		code := ""
		if source == "opensky" {
			if state.LastErrorKind != nil {
				code = *state.LastErrorKind
			}
		} else if state.LastErrorCode != nil {
			code = *state.LastErrorCode
		}
		return "error", code, *state.LastError
	}
	if lastSuccessMs == nil {
		return "idle", "no_successful_run", "No successful run yet."
	}

	staleAfter := int64(intervalSec) * 2 * 1000
	if staleAfter < 5*60*1000 {
		staleAfter = 5 * 60 * 1000
	}
	if nowMs-*lastSuccessMs > staleAfter {
		return "stale", "last_success_stale", "Last successful run is stale."
	}
	if source == "opensky" && context != nil {
		if freshness, ok := context.str("snapshotFreshness"); ok && freshness == "stale" {
			return "stale", "opensky_snapshot_stale", "Latest OpenSky snapshot is stale."
		}
	}
	if source == "ais" {
		if ais != nil && (ais.statusReasonCode != "" || ais.statusReason != "") {
			return "error", ais.statusReasonCode, ais.statusReason
		}
		return "ok", "", ""
	}
	code, reason, status := runtimeContextReason(source, context)
	if status != "" && status != "ok" {
		return status, code, reason
	}
	return "ok", code, reason
}

func missingConfigReason(source string, context diagnosticContext) (string, string, bool) {
	if context == nil {
		return "", "", false
	}
	configured, ok := context.boolean("configured")
	if !ok || configured {
		return "", "", false
	}
	switch source {
	case "opensky":
		return "opensky_not_configured", "OpenSky OAuth client credentials are not configured.", true
	case "ais":
		return "ais_not_configured", "AIS base URL is not configured.", true
	case "outages":
		return "outages_not_configured", "Cloudflare API token is not configured.", true
	default:
		return "", "", false
	}
}

func runtimeContextReason(source string, context diagnosticContext) (string, string, string) {
	if context == nil {
		return "", "", ""
	}
	if source == "opensky" {
		if code, ok := context.str("budgetReservationFailureCode"); ok {
			degradation := "warning"
			if value, found := context.str("budgetDegradation"); found {
				switch value {
				case "normal", "warning", "critical", "exhausted":
					degradation = value
				}
			}
			code, reason := openskyBudgetLimitedMessage(degradation, code)
			return code, reason, "ok"
		}
		if paused, ok := context.boolean("militaryPaused"); ok && paused {
			return "opensky_budget_exhausted", "OpenSky military polling is paused because the daily credit budget is exhausted.", "ok"
		}
		if degradation, ok := context.str("budgetDegradation"); ok && degradation == "critical" {
			return "opensky_budget_critical", "OpenSky all-flight mode is limited and military polling is running at the night interval to preserve daily credits.", "ok"
		}
		if blocked, ok := context.boolean("allModeBlocked"); ok && blocked {
			return "opensky_budget_warning", "OpenSky all-flight mode is temporarily limited to preserve daily credits.", "ok"
		}
		if retained, ok := context.boolean("snapshotRetainedPrevious"); ok && retained {
			return "opensky_snapshot_retained_previous", "Using retained OpenSky snapshot after empty or unusable fetch.", "ok"
		}
		valid, hasValid := context.number("validPositionCount")
		total, hasTotal := context.number("totalAircraft")
		if hasTotal && total > 0 && hasValid && valid == 0 {
			return "opensky_no_valid_positions", "OpenSky returned aircraft but no current positions passed validation.", "ok"
		}
		return "", "", "ok"
	}
	if source == "unrest" {
		acledEnabled := true
		if value, ok := context.boolean("acledApiEnabled"); ok {
			acledEnabled = value
		}
		feedErrors, ok := context.object("feedErrors")
		if !ok {
			return "", "", "ok"
		}
		messages := make([]string, 0, 2)
		if acledEnabled {
			if value, ok := rawString(feedErrors, "acled"); ok {
				messages = append(messages, value)
			}
		}
		if value, ok := rawString(feedErrors, "gdelt"); ok {
			messages = append(messages, value)
		}
		if len(messages) > 0 {
			return "", strings.Join(messages, " | "), "ok"
		}
	}
	return "", "", "ok"
}

func openskyBudgetLimitedMessage(degradation, code string) (string, string) {
	if code == "opensky_budget_insufficient_credits" {
		return code, "OpenSky does not have enough remaining daily credits for this request."
	}
	switch degradation {
	case "critical":
		return code, "OpenSky all-flight mode is limited and military polling is running at the night interval to preserve the daily credit budget."
	case "exhausted":
		return code, "OpenSky daily credit budget is exhausted; all-flight mode is paused until the next Hong Kong day begins."
	default:
		return code, "OpenSky all-flight mode is temporarily limited to preserve the daily credit budget."
	}
}

func rawString(values map[string]json.RawMessage, key string) (string, bool) {
	raw, ok := values[key]
	if !ok {
		return "", false
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", false
	}
	return trimmed, true
}

func parseTimestampPtr(value *string) *int64 {
	if value == nil {
		return nil
	}
	parsed, ok := parseTimestampMs(*value)
	if !ok {
		return nil
	}
	return &parsed
}

// formatISO is used by tests and error paths that need Nest's timestamp shape.
func formatISO(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
