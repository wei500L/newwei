package notificationssocket

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestParseConnectPacket(t *testing.T) {
	packet, err := parseClientPacket(`40/notifications,{"token":"abc"}`)
	if err != nil {
		t.Fatalf("parseClientPacket() error = %v", err)
	}
	if packet.EngineType != engineMessage || packet.SocketType != socketConnect {
		t.Fatalf("unexpected packet types: %#v", packet)
	}
	if packet.Namespace != Namespace {
		t.Fatalf("namespace = %q, want %q", packet.Namespace, Namespace)
	}
	if string(packet.Payload) != `{"token":"abc"}` {
		t.Fatalf("payload = %q", packet.Payload)
	}
}

func TestParseEnginePing(t *testing.T) {
	packet, err := parseClientPacket("2")
	if err != nil {
		t.Fatalf("parseClientPacket() error = %v", err)
	}
	if packet.EngineType != enginePing {
		t.Fatalf("engine type = %q, want ping", packet.EngineType)
	}
}

func TestEncodeEventPreservesRawData(t *testing.T) {
	event := NotificationEvent{
		ID:        "n1",
		OrgID:     "org1",
		UserID:    stringPointer("u1"),
		Type:      "system",
		Title:     "hello",
		Data:      json.RawMessage(`{"z":1,"a":2}`),
		CreatedAt: "2026-10-20T00:00:00.000Z",
	}
	packet, err := encodeEvent(Namespace, "notification", event)
	if err != nil {
		t.Fatalf("encodeEvent() error = %v", err)
	}
	if !strings.HasPrefix(packet, `42/notifications,["notification",`) {
		t.Fatalf("packet prefix = %q", packet)
	}
	if !strings.Contains(packet, `"data":{"z":1,"a":2}`) {
		t.Fatalf("packet must preserve raw JSON leaf order: %s", packet)
	}
}

func TestValidateRelayedRow(t *testing.T) {
	alert := NotificationEvent{
		Type: "alert_triggered",
		Data: json.RawMessage(`{"presentation":{"kind":"alert_triggered"}}`),
	}
	if !validateRelayedRow(relayAlert, alert) {
		t.Fatal("alert presentation should validate")
	}
	analysis := NotificationEvent{
		Type: "analysis_completed",
		Data: json.RawMessage(`{"analysisId":"a1","presentation":{"kind":"analysis_completed"}}`),
	}
	if !validateRelayedRow(relayAnalysis, analysis) {
		t.Fatal("analysis presentation should validate")
	}
	digest := NotificationEvent{
		Type: "system",
		Data: json.RawMessage(`{"presentation":{"kind":"user_digest_ready"}}`),
	}
	if !validateRelayedRow(relayDigest, digest) {
		t.Fatal("digest presentation should validate")
	}
	if validateRelayedRow(relayAlert, notificationEventWithData(`{"presentation":{"kind":"other"}}`)) {
		t.Fatal("wrong presentation kind must not validate")
	}
}

func TestValidateRelayedRowNewsSource(t *testing.T) {
	// The three org-wide news-source alerts written by the Go scheduler/ops
	// takeover must validate only with a NULL userId and a system type.
	for _, kind := range []string{
		"news_source_scheduler_backpressure",
		"news_source_rss_body_missing_spike",
		"news_source_pipeline_retry_spike",
	} {
		event := NotificationEvent{
			Type: "system",
			Data: json.RawMessage(fmt.Sprintf(`{"presentation":{"kind":%q}}`, kind)),
		}
		if !validateRelayedRow(relayNewsSource, event) {
			t.Fatalf("news-source row with kind %q should validate", kind)
		}
	}

	orgWide := NotificationEvent{
		Type: "system",
		Data: json.RawMessage(`{"presentation":{"kind":"news_source_scheduler_backpressure"}}`),
	}
	if validateRelayedRow(relayNewsSource, NotificationEvent{
		Type:   "system",
		UserID: stringPointer("u1"),
		Data:   orgWide.Data,
	}) {
		t.Fatal("user-scoped row must not validate for the org-wide news-source relay")
	}
	if validateRelayedRow(relayNewsSource, NotificationEvent{
		Type: "alert_triggered",
		Data: orgWide.Data,
	}) {
		t.Fatal("non-system row must not validate for the news-source relay")
	}
	if validateRelayedRow(relayNewsSource, notificationEventWithData(`{"presentation":{"kind":"other"}}`)) {
		t.Fatal("unknown presentation kind must not validate for the news-source relay")
	}
}

func TestRelayChannelsIncludeNewsSource(t *testing.T) {
	kind, ok := relayChannels["news-source:notifications:v1"]
	if !ok {
		t.Fatal("news-source notification relay channel must be subscribed")
	}
	if kind != relayNewsSource {
		t.Fatalf("channel kind = %v, want relayNewsSource", kind)
	}
	if len(relayChannels) != 5 {
		t.Fatalf("relay channel count = %d, want 5", len(relayChannels))
	}
}

func TestParseRelayMessageRejectsMissingIDs(t *testing.T) {
	if _, err := parseRelayMessage(`{"version":1,"orgId":"org1"}`); err == nil {
		t.Fatal("missing notificationId must fail")
	}
	message, err := parseRelayMessage(`{"version":1,"notificationId":"n1","orgId":"org1","userId":"u1"}`)
	if err != nil {
		t.Fatalf("parseRelayMessage() error = %v", err)
	}
	if message.UserID != "u1" {
		t.Fatalf("userId = %q", message.UserID)
	}
}

func TestParseClientPacketRejectsUnknownType(t *testing.T) {
	if _, err := parseClientPacket("49/notifications,"); err == nil {
		t.Fatal("unknown socket.io type must fail")
	}
}

func notificationEventWithData(raw string) NotificationEvent {
	return NotificationEvent{Type: "alert_triggered", Data: json.RawMessage(raw)}
}

func stringPointer(value string) *string { return &value }
