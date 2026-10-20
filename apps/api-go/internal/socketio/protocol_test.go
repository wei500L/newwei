package socketio

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseConnectPacket(t *testing.T) {
	packet, err := parseClientPacket(`40/newsnow,{"token":"abc"}`)
	if err != nil {
		t.Fatalf("parseClientPacket() error = %v", err)
	}
	if packet.EngineType != engineMessage || packet.SocketType != socketConnect {
		t.Fatalf("unexpected packet types: %#v", packet)
	}
	if packet.Namespace != "/newsnow" {
		t.Fatalf("namespace = %q, want /newsnow", packet.Namespace)
	}
	if string(packet.Payload) != `{"token":"abc"}` {
		t.Fatalf("payload = %q", packet.Payload)
	}
}

func TestParseConnectPacketWithoutAuth(t *testing.T) {
	packet, err := parseClientPacket("40/queue,")
	if err != nil {
		t.Fatalf("parseClientPacket() error = %v", err)
	}
	if packet.Namespace != "/queue" {
		t.Fatalf("namespace = %q, want /queue", packet.Namespace)
	}
	if len(packet.Payload) != 0 {
		t.Fatalf("payload = %q, want empty", packet.Payload)
	}
}

func TestParseRootNamespacePackets(t *testing.T) {
	packet, err := parseClientPacket(`40{"token":"abc"}`)
	if err != nil {
		t.Fatalf("parseClientPacket() error = %v", err)
	}
	if packet.Namespace != namespaceRoot {
		t.Fatalf("namespace = %q, want /", packet.Namespace)
	}
	if string(packet.Payload) != `{"token":"abc"}` {
		t.Fatalf("payload = %q", packet.Payload)
	}

	disconnect, err := parseClientPacket("41")
	if err != nil {
		t.Fatalf("parseClientPacket() error = %v", err)
	}
	if disconnect.SocketType != socketDisconnect || disconnect.Namespace != namespaceRoot {
		t.Fatalf("unexpected disconnect packet: %#v", disconnect)
	}

	if _, err := parseClientPacket(`42["hello",1]`); err != nil {
		t.Fatalf("parseClientPacket() error = %v", err)
	}
}

func TestParseDisconnectPacket(t *testing.T) {
	packet, err := parseClientPacket("41/ops,")
	if err != nil {
		t.Fatalf("parseClientPacket() error = %v", err)
	}
	if packet.SocketType != socketDisconnect {
		t.Fatalf("socket type = %q, want disconnect", packet.SocketType)
	}
	if packet.Namespace != "/ops" {
		t.Fatalf("namespace = %q, want /ops", packet.Namespace)
	}
	if len(packet.Payload) != 0 {
		t.Fatalf("payload = %q, want empty", packet.Payload)
	}
}

func TestParseEventPacket(t *testing.T) {
	packet, err := parseClientPacket(`42/quality,["q:update",{"z":1,"a":2}]`)
	if err != nil {
		t.Fatalf("parseClientPacket() error = %v", err)
	}
	if packet.SocketType != socketEvent {
		t.Fatalf("socket type = %q, want event", packet.SocketType)
	}
	if packet.Namespace != "/quality" {
		t.Fatalf("namespace = %q, want /quality", packet.Namespace)
	}
	if string(packet.Payload) != `["q:update",{"z":1,"a":2}]` {
		t.Fatalf("payload = %q", packet.Payload)
	}
	if packet.HasAckID {
		t.Fatalf("unexpected ack id: %#v", packet)
	}
}

func TestParseEventPacketWithAckID(t *testing.T) {
	packet, err := parseClientPacket(`42/queue,7["q:enqueue",1]`)
	if err != nil {
		t.Fatalf("parseClientPacket() error = %v", err)
	}
	if !packet.HasAckID || packet.AckID != 7 {
		t.Fatalf("ack id = %d (present %v), want 7", packet.AckID, packet.HasAckID)
	}
	if string(packet.Payload) != `["q:enqueue",1]` {
		t.Fatalf("payload = %q", packet.Payload)
	}
}

func TestParseAckAndBinaryPackets(t *testing.T) {
	ack, err := parseClientPacket(`43/newsnow,12[]`)
	if err != nil {
		t.Fatalf("parseClientPacket() error = %v", err)
	}
	if ack.SocketType != socketAck || !ack.HasAckID || ack.AckID != 12 {
		t.Fatalf("unexpected ack packet: %#v", ack)
	}
	if ack.Namespace != "/newsnow" || string(ack.Payload) != "[]" {
		t.Fatalf("unexpected ack packet: %#v", ack)
	}

	binaryEvent, err := parseClientPacket(`451-/newsnow,["ev",{"_placeholder":true,"num":0}]`)
	if err != nil {
		t.Fatalf("parseClientPacket() error = %v", err)
	}
	if binaryEvent.SocketType != socketBinaryEvent || binaryEvent.Attachments != 1 {
		t.Fatalf("unexpected binary event packet: %#v", binaryEvent)
	}
	if binaryEvent.Namespace != "/newsnow" {
		t.Fatalf("namespace = %q, want /newsnow", binaryEvent.Namespace)
	}

	binaryAck, err := parseClientPacket(`461-/queue,3[]`)
	if err != nil {
		t.Fatalf("parseClientPacket() error = %v", err)
	}
	if binaryAck.SocketType != socketBinaryAck || binaryAck.Attachments != 1 {
		t.Fatalf("unexpected binary ack packet: %#v", binaryAck)
	}
	if binaryAck.Namespace != "/queue" || !binaryAck.HasAckID || binaryAck.AckID != 3 {
		t.Fatalf("unexpected binary ack packet: %#v", binaryAck)
	}
}

func TestParseEngineFrames(t *testing.T) {
	for _, raw := range []string{"2", "3", "1", "5", "6"} {
		packet, err := parseClientPacket(raw)
		if err != nil {
			t.Fatalf("parseClientPacket(%q) error = %v", raw, err)
		}
		if packet.EngineType != raw[0] {
			t.Fatalf("engine type = %q, want %q", packet.EngineType, raw[0])
		}
	}
	for _, raw := range []string{"", "7", "x"} {
		if _, err := parseClientPacket(raw); err == nil {
			t.Fatalf("parseClientPacket(%q) must fail", raw)
		}
	}
}

func TestParseRejectsUnsupportedSocketType(t *testing.T) {
	for _, raw := range []string{"49/newsnow,", "4/", "4"} {
		if _, err := parseClientPacket(raw); err == nil {
			t.Fatalf("parseClientPacket(%q) must fail", raw)
		}
	}
}

func TestParseRejectsMalformedConnectPayload(t *testing.T) {
	for _, raw := range []string{`40/newsnow,[]`, `40/newsnow,{oops}`, `41/newsnow,{}`} {
		if _, err := parseClientPacket(raw); err == nil {
			t.Fatalf("parseClientPacket(%q) must fail", raw)
		}
	}
}

func TestEncodeOpenPacket(t *testing.T) {
	got := encodeOpen("sid-1", 25000, 20000, 1_000_000)
	want := `0{"sid":"sid-1","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}`
	if got != want {
		t.Fatalf("encodeOpen() = %s, want %s", got, want)
	}
	var handshake struct {
		SID          string   `json:"sid"`
		Upgrades     []string `json:"upgrades"`
		PingInterval int      `json:"pingInterval"`
		PingTimeout  int      `json:"pingTimeout"`
		MaxPayload   int64    `json:"maxPayload"`
	}
	if err := json.Unmarshal([]byte(got[1:]), &handshake); err != nil {
		t.Fatalf("open packet is not JSON: %v", err)
	}
	if handshake.SID != "sid-1" || len(handshake.Upgrades) != 0 {
		t.Fatalf("unexpected handshake: %#v", handshake)
	}
}

func TestEncodeConnectAck(t *testing.T) {
	if got := encodeConnectAck("/newsnow", "s1"); got != `40/newsnow,{"sid":"s1"}` {
		t.Fatalf("encodeConnectAck() = %s", got)
	}
	if got := encodeConnectAck("/", "s1"); got != `40{"sid":"s1"}` {
		t.Fatalf("root encodeConnectAck() = %s", got)
	}
}

func TestEncodeEventPreservesPayloadBytes(t *testing.T) {
	got, err := encodeEvent("/newsnow", "newsnow:update", []byte(`{"z":1,"a":2,"nested":{"b":1,"a":2}}`))
	if err != nil {
		t.Fatalf("encodeEvent() error = %v", err)
	}
	want := `42/newsnow,["newsnow:update",{"z":1,"a":2,"nested":{"b":1,"a":2}}]`
	if got != want {
		t.Fatalf("encodeEvent() = %s, want %s", got, want)
	}

	withoutPayload, err := encodeEvent("/queue", "queue:ping", nil)
	if err != nil {
		t.Fatalf("encodeEvent(nil payload) error = %v", err)
	}
	if withoutPayload != `42/queue,["queue:ping"]` {
		t.Fatalf("encodeEvent(nil payload) = %s", withoutPayload)
	}

	if _, err := encodeEvent("/queue", "queue:ping", []byte(`{"broken"`)); err == nil {
		t.Fatal("encodeEvent() must reject invalid payload JSON")
	}
}

func TestEncodeDisconnectPacket(t *testing.T) {
	if got := encodeDisconnect("/newsnow"); got != "41/newsnow," {
		t.Fatalf("encodeDisconnect() = %s", got)
	}
	if got := encodeDisconnect("/"); got != "41" {
		t.Fatalf("root encodeDisconnect() = %s", got)
	}
}

func TestEncodeConnectErrorPacket(t *testing.T) {
	got := encodeConnectError("/nope", invalidNamespaceMessage)
	want := `44/nope,{"message":"Invalid namespace"}`
	if got != want {
		t.Fatalf("encodeConnectError() = %s, want %s", got, want)
	}
}

func TestParseEventPayload(t *testing.T) {
	event, args, err := parseEventPayload([]byte(`["q:update",{"z":1,"a":2}]`))
	if err != nil {
		t.Fatalf("parseEventPayload() error = %v", err)
	}
	if event != "q:update" {
		t.Fatalf("event = %q", event)
	}
	if string(args) != `[{"z":1,"a":2}]` {
		t.Fatalf("args = %s", args)
	}

	event, args, err = parseEventPayload([]byte(`["no-args"]`))
	if err != nil {
		t.Fatalf("parseEventPayload() error = %v", err)
	}
	if event != "no-args" || string(args) != "[]" {
		t.Fatalf("event = %q, args = %s", event, args)
	}

	for _, raw := range []string{`["connect",1]`, `[]`, `{"event":"x"}`, `[1,2]`, `["ev",]`} {
		if _, _, err := parseEventPayload([]byte(raw)); err == nil {
			t.Fatalf("parseEventPayload(%q) must fail", raw)
		}
	}
}

func TestReservedEventNamesMatchParser(t *testing.T) {
	// socket.io-parser 4.2.4 RESERVED_EVENTS.
	for _, name := range []string{"connect", "connect_error", "disconnect", "disconnecting", "newListener", "removeListener"} {
		if _, reserved := reservedEventNames[name]; !reserved {
			t.Fatalf("reserved event %q is missing", name)
		}
	}
	if len(reservedEventNames) != 6 {
		t.Fatalf("reserved event count = %d, want 6", len(reservedEventNames))
	}
}

func TestNewSocketIDIsHex(t *testing.T) {
	first := newSocketID()
	second := newSocketID()
	if len(first) != 32 || !isHex(first) {
		t.Fatalf("newSocketID() = %q, want 32 hex characters", first)
	}
	if first == second {
		t.Fatal("newSocketID() must return distinct ids")
	}
}

func isHex(value string) bool {
	for _, char := range value {
		if !strings.ContainsRune("0123456789abcdef", char) {
			return false
		}
	}
	return true
}
