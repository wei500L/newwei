package aisrelay

import (
	"log"
	"strconv"
)

// Relay health state machine.
//
// The rules and their evaluation order are copied from evaluateRelayHealthState in
// apps/ais-relay/src/index.ts: the first rule that trips decides the reason code, so
// reordering them would change which code a degraded relay reports. Every code is a
// member of AIS_RELAY_REASON_CODES, which the API and the Web console share.

// exceedsRatio reproduces the Node helper: a ratio test that is false whenever the
// denominator is non-positive, and compares the percentage with `>=`.
func exceedsRatio(numerator int, denominator int, percent int) bool {
	if denominator <= 0 {
		return false
	}
	return (float64(numerator)/float64(denominator))*100 >= float64(percent)
}

// evaluateRelayHealthStateLocked applies the health rules in order and records the
// verdict.
func (e *engine) evaluateRelayHealthStateLocked() {
	now := e.nowMillis()

	if e.state != connOpen {
		// While the very first handshake is still in flight and nothing has failed
		// yet, the relay reports ok: a cold start must not page anyone.
		if e.state == connConnecting && e.messageCount == 0 && e.lastUpstreamErrorAt == 0 {
			e.setRelayHealthStateLocked(HealthStateOK, nil, nil)
			return
		}

		reason := "AIS relay is reachable, but the upstream AIS stream is disconnected."
		if upstreamReason := trimmedOptional(e.lastUpstreamErrorMessage); upstreamReason != "" {
			reason = "AIS relay is reachable, but the upstream AIS stream is disconnected. Last upstream error: " + upstreamReason
		}
		e.setRelayHealthStateLocked(HealthStateDegraded, ref(ReasonUpstreamDisconnected), ref(reason))
		return
	}

	noMessagesBudget := int64(e.cfg.HealthNoMessagesAfterConnect / 1000000)
	if e.lastUpstreamConnectedAt > 0 &&
		(e.lastUpstreamMessageAt == 0 || e.lastUpstreamMessageAt < e.lastUpstreamConnectedAt) &&
		now-e.lastUpstreamConnectedAt >= noMessagesBudget {
		reason := "AIS relay is connected to the upstream stream, but no AIS messages have arrived within " +
			strconv.Itoa(jsRoundToInt(float64(noMessagesBudget)/1000)) + "s of connection establishment."
		e.setRelayHealthStateLocked(HealthStateDegraded, ref(ReasonUpstreamNoMessagesAfterConnect), ref(reason))
		return
	}

	staleBudget := int64(e.cfg.HealthStaleMessages / 1000000)
	if e.lastUpstreamMessageAt > 0 && now-e.lastUpstreamMessageAt >= staleBudget {
		reason := "AIS relay has not received an upstream message for " +
			strconv.Itoa(jsRoundToInt(float64(staleBudget)/1000)) + "s while the upstream connection remains open."
		e.setRelayHealthStateLocked(HealthStateDegraded, ref(ReasonUpstreamStalled), ref(reason))
		return
	}

	if e.positionReportsSeen >= e.cfg.HealthMinPositionReports &&
		e.positionReportsProcessed == 0 &&
		e.vessels.Len() == 0 {
		e.setRelayHealthStateLocked(HealthStateDegraded, ref(ReasonPositionReportsNotRetained), ref(
			"AIS relay is receiving position reports, but none are being retained as vessel snapshots. "+
				"Check MMSI and coordinate normalization.",
		))
		return
	}

	if e.positionReportsSeen >= e.cfg.HealthMinPositionReports &&
		e.ignoredPositionReports > 0 &&
		exceedsRatio(e.ignoredPositionReports, e.positionReportsSeen, e.cfg.HealthMaxIgnoredRatioPercent) {
		e.setRelayHealthStateLocked(HealthStateDegraded, ref(ReasonPositionReportsMostlyIgnored), ref(
			"AIS relay is receiving position reports, but most are being ignored during normalization ("+
				strconv.Itoa(e.ignoredPositionReports)+"/"+strconv.Itoa(e.positionReportsSeen)+").",
		))
		return
	}

	if e.messageCount >= e.cfg.HealthMinPositionReports &&
		e.parseErrors > 0 &&
		exceedsRatio(e.parseErrors, e.messageCount, e.cfg.HealthMaxParseErrorRatioPercent) {
		e.setRelayHealthStateLocked(HealthStateDegraded, ref(ReasonPayloadParseErrors), ref(
			"AIS relay is encountering frequent upstream payload parse errors ("+
				strconv.Itoa(e.parseErrors)+"/"+strconv.Itoa(e.messageCount)+").",
		))
		return
	}

	e.setRelayHealthStateLocked(HealthStateOK, nil, nil)
}

// setRelayHealthStateLocked records a verdict and timestamps the transition.
//
// lastIssueAt only moves when the state or the reason code changes, so a relay that
// stays degraded for hours keeps reporting when the incident started; lastHealthyAt
// only moves on the degraded -> ok transition.
func (e *engine) setRelayHealthStateLocked(next HealthState, code *ReasonCode, reason *string) {
	previousState := e.relayHealthState
	previousCode := e.relayStatusReasonCode

	e.relayHealthState = next
	if next == HealthStateDegraded {
		e.relayStatusReasonCode = code
		e.relayStatusReason = reason
		if previousState != next || !sameReasonCode(previousCode, code) {
			e.lastRelayIssueAt = e.nowMillis()
			log.Printf("[ais-relay] degraded (%s): %s", reasonCodeText(code), reasonText(reason))
		}
		return
	}

	e.relayStatusReasonCode = nil
	e.relayStatusReason = nil
	if previousState == HealthStateDegraded {
		e.lastRelayHealthyAt = e.nowMillis()
		log.Print("[ais-relay] relay health recovered")
	}
}

// buildRelayDiagnosticsLocked evaluates the health rules and returns the diagnostics
// block. Like the Node helper it re-evaluates first, so /health and /ais/snapshot
// always report a verdict computed from the current counters.
func (e *engine) buildRelayDiagnosticsLocked() HealthDiagnostics {
	e.evaluateRelayHealthStateLocked()
	return HealthDiagnostics{
		HealthState:              e.relayHealthState,
		StatusReasonCode:         e.relayStatusReasonCode,
		StatusReason:             e.relayStatusReason,
		PositionReportsSeen:      e.positionReportsSeen,
		PositionReportsProcessed: e.positionReportsProcessed,
		IgnoredPositionReports:   e.ignoredPositionReports,
		ParseErrors:              e.parseErrors,
		LastHealthyAt:            optionalISO(e.lastRelayHealthyAt),
		LastIssueAt:              optionalISO(e.lastRelayIssueAt),
		LastConnectedAt:          optionalISO(e.lastUpstreamConnectedAt),
		LastMessageAt:            optionalISO(e.lastUpstreamMessageAt),
		LastUpstreamErrorAt:      optionalISO(e.lastUpstreamErrorAt),
		LastUpstreamError:        e.lastUpstreamErrorMessage,
		LastParseErrorAt:         optionalISO(e.lastParseErrorAt),
		LastParseError:           e.lastParseErrorMessage,
	}
}

// healthPayload returns the GET / and GET /health body.
func (e *engine) healthPayload() healthPayload {
	e.mu.Lock()
	defer e.mu.Unlock()

	diagnostics := e.buildRelayDiagnosticsLocked()
	densityZones := 0
	e.densityGrid.Range(func(_ string, cell *densityCell) bool {
		if cell.vesselIDs.Len() >= 2 {
			densityZones++
		}
		return true
	})

	return healthPayload{
		Status:              diagnostics.HealthState,
		Connected:           e.state == connOpen,
		Vessels:             e.vessels.Len(),
		Messages:            e.messageCount,
		DroppedMessages:     e.droppedMessages,
		DensityZones:        densityZones,
		SharedSecretEnabled: e.cfg.SharedSecret != "",
		Diagnostics:         diagnostics,
	}
}

// livenessPayload returns the GET /healthz/live body. It stays a constant 200: the
// container probe must only fail when the process itself is wedged.
func (e *engine) livenessPayload() livenessPayload {
	return livenessPayload{
		Status:  "ok",
		Service: "ais-relay",
		Now:     isoMillis(e.nowMillis()),
	}
}

// optionalISO renders an epoch-millisecond timestamp the way toIsoTimestamp does:
// only a positive value becomes a timestamp string.
func optionalISO(milliseconds int64) *string {
	if milliseconds <= 0 {
		return nil
	}
	return ref(isoMillis(milliseconds))
}

// trimmedOptional reimplements normalizeString for an optional string: JS-trim and
// treat an empty result as absent.
func trimmedOptional(value *string) string {
	if value == nil {
		return ""
	}
	return jsTrim(*value)
}

// sameReasonCode compares two optional reason codes by value.
func sameReasonCode(left *ReasonCode, right *ReasonCode) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

// reasonCodeText renders a reason code for logging.
func reasonCodeText(code *ReasonCode) string {
	if code == nil {
		return "unknown"
	}
	return string(*code)
}

// reasonText renders a reason for logging.
func reasonText(reason *string) string {
	if reason == nil {
		return "No reason provided"
	}
	return *reason
}
