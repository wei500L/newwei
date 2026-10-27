package aisrelay

import (
	"strings"
	"testing"
	"time"
)

// Health state machine contract, from evaluateRelayHealthState in
// apps/ais-relay/src/index.ts. The rules are evaluated in order and the first match wins,
// so these tests also pin the ordering.

func relayTestHealthEngine(t *testing.T) (*engine, *relayTestClock) {
	t.Helper()
	clock := &relayTestClock{millis: relayTestBaseMillis}
	return relayTestEngine(t, clock), clock
}

func TestHealthReasonCodesMatchSharedContract(t *testing.T) {
	// AIS_RELAY_REASON_CODES in packages/utils/src/realtime-signals-contract.ts.
	want := []string{
		"ais_upstream_disconnected",
		"ais_upstream_no_messages_after_connect",
		"ais_upstream_stalled",
		"ais_position_reports_not_retained",
		"ais_position_reports_mostly_ignored",
		"ais_payload_parse_errors",
	}
	if len(ReasonCodes) != len(want) {
		t.Fatalf("ReasonCodes has %d entries, want %d", len(ReasonCodes), len(want))
	}
	for index, code := range want {
		if string(ReasonCodes[index]) != code {
			t.Fatalf("ReasonCodes[%d] = %q, want %q", index, ReasonCodes[index], code)
		}
	}
}

func TestHealthDisconnectedReason(t *testing.T) {
	target, _ := relayTestHealthEngine(t)
	// A fresh engine is idle: no socket and no recorded error yet.
	diagnostics := target.buildRelayDiagnosticsLocked()

	if diagnostics.HealthState != HealthStateDegraded {
		t.Fatalf("healthState = %q, want degraded", diagnostics.HealthState)
	}
	if diagnostics.StatusReasonCode == nil || *diagnostics.StatusReasonCode != ReasonUpstreamDisconnected {
		t.Fatalf("statusReasonCode = %v, want ais_upstream_disconnected", diagnostics.StatusReasonCode)
	}
	if diagnostics.StatusReason == nil {
		t.Fatal("statusReason is absent")
	}
	const wantReason = "AIS relay is reachable, but the upstream AIS stream is disconnected."
	if *diagnostics.StatusReason != wantReason {
		t.Fatalf("statusReason = %q, want %q", *diagnostics.StatusReason, wantReason)
	}

	// A recorded upstream error is appended (JS-trimmed) to the reason text.
	target.lastUpstreamErrorMessage = ref("  close 1006  ")
	diagnostics = target.buildRelayDiagnosticsLocked()
	const wantWithError = "AIS relay is reachable, but the upstream AIS stream is disconnected. " +
		"Last upstream error: close 1006"
	if diagnostics.StatusReason == nil || *diagnostics.StatusReason != wantWithError {
		t.Fatalf("statusReason = %q, want %q", *diagnostics.StatusReason, wantWithError)
	}
}

func TestHealthConnectingColdStartIsOK(t *testing.T) {
	target, _ := relayTestHealthEngine(t)
	// The very first handshake reports ok while nothing has failed yet.
	target.state = connConnecting

	diagnostics := target.buildRelayDiagnosticsLocked()
	if diagnostics.HealthState != HealthStateOK {
		t.Fatalf("healthState = %q, want ok", diagnostics.HealthState)
	}
	if diagnostics.StatusReasonCode != nil {
		t.Fatalf("statusReasonCode = %v, want absent", *diagnostics.StatusReasonCode)
	}

	// Once a message has been seen, a reconnect in progress is reported as degraded.
	target.messageCount = 1
	diagnostics = target.buildRelayDiagnosticsLocked()
	if diagnostics.HealthState != HealthStateDegraded {
		t.Fatalf("healthState = %q, want degraded", diagnostics.HealthState)
	}

	// A recorded error also ends the cold-start exemption.
	target.messageCount = 0
	target.lastUpstreamErrorAt = relayTestBaseMillis
	if got := target.buildRelayDiagnosticsLocked(); got.HealthState != HealthStateDegraded {
		t.Fatalf("healthState = %q, want degraded", got.HealthState)
	}
}

func TestHealthNoMessagesAfterConnect(t *testing.T) {
	target, clock := relayTestHealthEngine(t)
	target.state = connOpen
	target.lastUpstreamConnectedAt = clock.millis

	// One millisecond short of the 60s budget the relay is still healthy.
	clock.advance(59*time.Second + 999*time.Millisecond)
	if got := target.buildRelayDiagnosticsLocked(); got.HealthState != HealthStateOK {
		t.Fatalf("healthState at 59.999s = %q, want ok", got.HealthState)
	}

	clock.advance(time.Millisecond)
	diagnostics := target.buildRelayDiagnosticsLocked()
	if diagnostics.HealthState != HealthStateDegraded {
		t.Fatalf("healthState at 60s = %q, want degraded", diagnostics.HealthState)
	}
	if diagnostics.StatusReasonCode == nil || *diagnostics.StatusReasonCode != ReasonUpstreamNoMessagesAfterConnect {
		t.Fatalf("statusReasonCode = %v, want ais_upstream_no_messages_after_connect", diagnostics.StatusReasonCode)
	}
	// The message reports the budget in seconds: Math.round(60000 / 1000) = 60.
	if diagnostics.StatusReason == nil || !strings.Contains(*diagnostics.StatusReason, "within 60s") {
		t.Fatalf("statusReason = %v, want it to mention 60s", diagnostics.StatusReason)
	}
}

func TestHealthUpstreamStalled(t *testing.T) {
	target, clock := relayTestHealthEngine(t)
	target.state = connOpen
	// The handshake happened well before the last message, so the no-messages rule is out.
	target.lastUpstreamConnectedAt = clock.millis - 10*60*1000
	target.lastUpstreamMessageAt = clock.millis - 89_999

	if got := target.buildRelayDiagnosticsLocked(); got.HealthState != HealthStateOK {
		t.Fatalf("healthState at 89.999s of silence = %q, want ok", got.HealthState)
	}

	clock.advance(time.Millisecond)
	diagnostics := target.buildRelayDiagnosticsLocked()
	if diagnostics.HealthState != HealthStateDegraded {
		t.Fatalf("healthState at 90s of silence = %q, want degraded", diagnostics.HealthState)
	}
	if diagnostics.StatusReasonCode == nil || *diagnostics.StatusReasonCode != ReasonUpstreamStalled {
		t.Fatalf("statusReasonCode = %v, want ais_upstream_stalled", diagnostics.StatusReasonCode)
	}
	// Math.round(90000 / 1000) = 90.
	if diagnostics.StatusReason == nil || !strings.Contains(*diagnostics.StatusReason, "for 90s") {
		t.Fatalf("statusReason = %v, want it to mention 90s", diagnostics.StatusReason)
	}
}

// relayTestHealthConnected puts the engine in the healthy stream state so the ratio rules
// are the only ones that can trip.
func relayTestHealthConnected(target *engine, clock *relayTestClock) {
	target.state = connOpen
	target.lastUpstreamConnectedAt = clock.millis
	target.lastUpstreamMessageAt = clock.millis
}

func TestHealthPositionReportsNotRetained(t *testing.T) {
	target, clock := relayTestHealthEngine(t)
	relayTestHealthConnected(target, clock)

	// Below the 25 report sample floor nothing is reported.
	target.positionReportsSeen = 24
	target.ignoredPositionReports = 24
	if got := target.buildRelayDiagnosticsLocked(); got.HealthState != HealthStateOK {
		t.Fatalf("healthState with 24 reports = %q, want ok", got.HealthState)
	}

	// At the floor with nothing retained and nothing processed the specific rule fires, and
	// it outranks the "mostly ignored" rule because it is evaluated first.
	target.positionReportsSeen = 25
	target.ignoredPositionReports = 25
	diagnostics := target.buildRelayDiagnosticsLocked()
	if diagnostics.HealthState != HealthStateDegraded {
		t.Fatalf("healthState = %q, want degraded", diagnostics.HealthState)
	}
	if diagnostics.StatusReasonCode == nil || *diagnostics.StatusReasonCode != ReasonPositionReportsNotRetained {
		t.Fatalf("statusReasonCode = %v, want ais_position_reports_not_retained", diagnostics.StatusReasonCode)
	}
}

func TestHealthPositionReportsMostlyIgnored(t *testing.T) {
	target, clock := relayTestHealthEngine(t)
	relayTestHealthConnected(target, clock)

	// 20 of 30 ignored is 66.7%, below the 85% threshold.
	target.positionReportsSeen = 30
	target.positionReportsProcessed = 10
	target.ignoredPositionReports = 20
	target.vessels.Set("111", &vesselState{mmsi: "111", timestamp: clock.millis})
	if got := target.buildRelayDiagnosticsLocked(); got.HealthState != HealthStateOK {
		t.Fatalf("healthState at 66.7%% ignored = %q, want ok", got.HealthState)
	}

	// 29 of 30 ignored is 96.7%, above the threshold. One report was processed, so the
	// "not retained" rule does not apply.
	target.positionReportsProcessed = 1
	target.ignoredPositionReports = 29
	diagnostics := target.buildRelayDiagnosticsLocked()
	if diagnostics.HealthState != HealthStateDegraded {
		t.Fatalf("healthState = %q, want degraded", diagnostics.HealthState)
	}
	if diagnostics.StatusReasonCode == nil || *diagnostics.StatusReasonCode != ReasonPositionReportsMostlyIgnored {
		t.Fatalf("statusReasonCode = %v, want ais_position_reports_mostly_ignored", diagnostics.StatusReasonCode)
	}
	// The reason text carries the raw counters: "(29/30)".
	if diagnostics.StatusReason == nil || !strings.Contains(*diagnostics.StatusReason, "(29/30)") {
		t.Fatalf("statusReason = %v, want it to contain (29/30)", diagnostics.StatusReason)
	}
}

func TestHealthPayloadParseErrors(t *testing.T) {
	target, clock := relayTestHealthEngine(t)
	relayTestHealthConnected(target, clock)

	// 4 of 25 is 16%, below the 20% threshold.
	target.messageCount = 25
	target.parseErrors = 4
	if got := target.buildRelayDiagnosticsLocked(); got.HealthState != HealthStateOK {
		t.Fatalf("healthState at 16%% parse errors = %q, want ok", got.HealthState)
	}

	// 5 of 25 is exactly 20%, and exceedsRatio uses `>=`.
	target.parseErrors = 5
	diagnostics := target.buildRelayDiagnosticsLocked()
	if diagnostics.HealthState != HealthStateDegraded {
		t.Fatalf("healthState = %q, want degraded", diagnostics.HealthState)
	}
	if diagnostics.StatusReasonCode == nil || *diagnostics.StatusReasonCode != ReasonPayloadParseErrors {
		t.Fatalf("statusReasonCode = %v, want ais_payload_parse_errors", diagnostics.StatusReasonCode)
	}
	if diagnostics.StatusReason == nil || !strings.Contains(*diagnostics.StatusReason, "(5/25)") {
		t.Fatalf("statusReason = %v, want it to contain (5/25)", diagnostics.StatusReason)
	}

	// Below the sample floor the ratio rule stays silent even at 100% failures.
	target.messageCount = 24
	target.parseErrors = 24
	if got := target.buildRelayDiagnosticsLocked(); got.HealthState != HealthStateOK {
		t.Fatalf("healthState with 24 messages = %q, want ok", got.HealthState)
	}
}

func TestHealthTransitionTimestamps(t *testing.T) {
	target, clock := relayTestHealthEngine(t)
	createdAt := isoMillis(clock.millis)

	// lastHealthyAt is stamped at construction. The first health read already reports
	// degraded, because an idle relay has no upstream socket, and that first evaluation is
	// also what stamps lastIssueAt - exactly as the Node helper behaves.
	diagnostics := target.healthPayload().Diagnostics
	if diagnostics.HealthState != HealthStateDegraded {
		t.Fatalf("healthState = %q, want degraded while idle", diagnostics.HealthState)
	}
	if diagnostics.LastHealthyAt == nil || *diagnostics.LastHealthyAt != createdAt {
		t.Fatalf("lastHealthyAt = %v, want %s", diagnostics.LastHealthyAt, createdAt)
	}
	issuedAt := isoMillis(clock.millis)
	if diagnostics.LastIssueAt == nil || *diagnostics.LastIssueAt != issuedAt {
		t.Fatalf("lastIssueAt = %v, want %s", diagnostics.LastIssueAt, issuedAt)
	}

	// Staying degraded with the same reason code does not move the issue timestamp, even
	// though the error text changed: only a state or code change is a new incident.
	clock.advance(time.Minute)
	target.lastUpstreamErrorMessage = ref("close 1006")
	diagnostics = target.healthPayload().Diagnostics
	if diagnostics.LastIssueAt == nil || *diagnostics.LastIssueAt != issuedAt {
		t.Fatalf("lastIssueAt moved to %v while the reason code was unchanged, want %s", diagnostics.LastIssueAt, issuedAt)
	}

	// Switching to a different reason code is a new incident. Drive the stalled rule: the
	// stream is open, the last message is 90s old, and the handshake is older still.
	clock.advance(time.Minute)
	target.state = connOpen
	target.lastUpstreamConnectedAt = clock.millis - 10*60*1000
	target.lastUpstreamMessageAt = clock.millis - 90_000
	diagnostics = target.healthPayload().Diagnostics
	if diagnostics.StatusReasonCode == nil || *diagnostics.StatusReasonCode != ReasonUpstreamStalled {
		t.Fatalf("statusReasonCode = %v, want ais_upstream_stalled", diagnostics.StatusReasonCode)
	}
	if diagnostics.LastIssueAt == nil || *diagnostics.LastIssueAt != isoMillis(clock.millis) {
		t.Fatalf("lastIssueAt = %v, want the stalled transition time %s", diagnostics.LastIssueAt, isoMillis(clock.millis))
	}

	// Recovering clears both reason fields and moves lastHealthyAt.
	clock.advance(time.Minute)
	recoveredAt := isoMillis(clock.millis)
	target.lastUpstreamConnectedAt = clock.millis
	target.lastUpstreamMessageAt = clock.millis
	health := target.healthPayload()
	if health.Diagnostics.HealthState != HealthStateOK {
		t.Fatalf("healthState = %q, want ok", health.Diagnostics.HealthState)
	}
	if health.Status != HealthStateOK {
		t.Fatalf("payload status = %q, want ok", health.Status)
	}
	if health.Diagnostics.StatusReasonCode != nil || health.Diagnostics.StatusReason != nil {
		t.Fatalf("reason fields survived recovery: %v / %v", health.Diagnostics.StatusReasonCode, health.Diagnostics.StatusReason)
	}
	if health.Diagnostics.LastHealthyAt == nil || *health.Diagnostics.LastHealthyAt != recoveredAt {
		t.Fatalf("lastHealthyAt = %v, want %s", health.Diagnostics.LastHealthyAt, recoveredAt)
	}
	// The incident timestamp is history: it stays at the last degraded transition.
	if health.Diagnostics.LastIssueAt == nil || *health.Diagnostics.LastIssueAt == recoveredAt {
		t.Fatalf("lastIssueAt = %v, want it preserved at the stalled transition", health.Diagnostics.LastIssueAt)
	}
}

func TestHealthPayloadShape(t *testing.T) {
	target, clock := relayTestHealthEngine(t)
	relayTestHealthConnected(target, clock)
	target.cfg.SharedSecret = "secret"
	target.messageCount = 3
	target.droppedMessages = 2

	health := target.healthPayload()
	if !health.Connected {
		t.Fatal("connected = false, want true while the stream is open")
	}
	if health.Messages != 3 || health.DroppedMessages != 2 {
		t.Fatalf("counters = %d/%d, want 3/2", health.Messages, health.DroppedMessages)
	}
	if !health.SharedSecretEnabled {
		t.Fatal("sharedSecretEnabled = false with a configured secret")
	}
	// densityZones counts only the cells with at least two vessels.
	target.densityGrid.Set("0,0", &densityCell{key: "0,0", vesselIDs: relayTestSet("1", "2")})
	target.densityGrid.Set("2,2", &densityCell{key: "2,2", vesselIDs: relayTestSet("3")})
	if got := target.healthPayload().DensityZones; got != 1 {
		t.Fatalf("densityZones = %d, want 1", got)
	}
}

func TestHealthLivenessPayload(t *testing.T) {
	target, clock := relayTestHealthEngine(t)
	target.state = connIdle

	// Liveness is a constant: it reports ok and the current time even when the relay is
	// degraded, so a container probe never restarts a reachable process.
	live := target.livenessPayload()
	if live.Status != "ok" || live.Service != "ais-relay" {
		t.Fatalf("liveness = %+v, want status ok / service ais-relay", live)
	}
	if live.Now != isoMillis(clock.millis) {
		t.Fatalf("now = %q, want %q", live.Now, isoMillis(clock.millis))
	}
}

func relayTestSet(values ...string) *orderedSet {
	set := newOrderedSet()
	for _, value := range values {
		set.Add(value)
	}
	return set
}
