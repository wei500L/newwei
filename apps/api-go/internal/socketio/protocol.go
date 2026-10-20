// Package socketio implements the shared Engine.IO v4 + Socket.IO v5
// protocol subset used by the Go realtime transports of the Web console.
//
// Scope: a WebSocket-only Engine.IO v4 transport carrying multiple Socket.IO
// v5 namespaces over one TCP connection (multiplexing). This is deliberately
// not a general Socket.IO server: polling, binary attachments, acknowledgements
// and the Redis adapter are out of scope. The browser always connects with
// socket.io-client and transports: ["websocket"], so only the frames that
// client can produce are implemented.
//
// Engine.IO v4 frames (first byte):
//
//	0 open, 1 close, 2 ping, 3 pong, 4 message, 5 upgrade, 6 noop
//
// Socket.IO v5 packet types (second byte, after the Engine.IO message frame):
//
//	0 CONNECT, 1 DISCONNECT, 2 EVENT, 3 ACK, 4 CONNECT_ERROR,
//	5 BINARY_EVENT, 6 BINARY_ACK
//
// The Go transports implement CONNECT, DISCONNECT, EVENT and CONNECT_ERROR.
// ACK/BINARY_EVENT/BINARY_ACK are parsed for protocol completeness but their
// delivery paths are rejected or ignored (see clientPacket handling in
// connection.go).
//
// Wire format facts verified against socket.io-parser 4.2.4 and
// socket.io 4.8.1 in node_modules:
//   - a packet is "<type>[<attachments>-][<namespace>,][<ack id>]<json>", the
//     namespace and the trailing comma are omitted for "/";
//   - CONNECT data is the auth object itself (the browser sends
//     `40/newsnow,{"token":"..."}`), so it is passed to Handler unchanged;
//   - a CONNECT ack is `40/newsnow,{"sid":"..."}`; the optional pid field only
//     exists when connection state recovery is enabled, which Nest does not
//     use;
//   - an EVENT is `42/newsnow,["event",payload]` and the payload must stay the
//     caller-marshalled JSON bytes so business field order is never altered.
package socketio

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

const (
	engineOpen    = '0'
	engineClose   = '1'
	enginePing    = '2'
	enginePong    = '3'
	engineMessage = '4'

	socketConnect      = '0'
	socketDisconnect   = '1'
	socketEvent        = '2'
	socketAck          = '3'
	socketConnectError = '4'
	socketBinaryEvent  = '5'
	socketBinaryAck    = '6'

	// namespaceRoot is the default Socket.IO namespace. A packet for it has no
	// namespace prefix on the wire.
	namespaceRoot = "/"

	// invalidNamespaceMessage is the exact CONNECT_ERROR message socket.io
	// 4.8.1 sends when a namespace is not registered (socket.io/dist/client.js
	// Client#connect, "Invalid namespace").
	invalidNamespaceMessage = "Invalid namespace"
)

// reservedEventNames mirrors RESERVED_EVENTS in socket.io-parser 4.2.4. The
// parser rejects a client EVENT whose first array element is one of these, so
// the decoder path rejects them as a protocol violation.
var reservedEventNames = map[string]struct{}{
	"connect":        {},
	"connect_error":  {},
	"disconnect":     {},
	"disconnecting":  {},
	"newListener":    {},
	"removeListener": {},
}

// clientPacket is one decoded frame from the browser. EnginePing, EnginePong
// and EngineClose carry no Socket.IO type; the caller handles them before
// looking at SocketType.
type clientPacket struct {
	EngineType byte
	SocketType byte
	Namespace  string
	Payload    []byte
	// AckID is the optional decimal acknowledgement id carried by EVENT, ACK,
	// BINARY_EVENT and BINARY_ACK packets. The Go transport does not reply to
	// acknowledgements; the value is parsed only so the JSON payload is not
	// mistaken for part of the id.
	AckID    uint64
	HasAckID bool
	// Attachments is the binary attachment count announced by BINARY_EVENT and
	// BINARY_ACK packets. No attachment can arrive on this transport because the
	// delivery path for binary packets is rejected.
	Attachments int
}

// parseClientPacket decodes one Engine.IO v4 frame received from the browser.
// It is intentionally strict: a malformed frame makes the caller close the
// connection, which is what socket.io does after a parser error
// (socket.io/dist/client.js Client#onerror).
func parseClientPacket(raw string) (clientPacket, error) {
	if raw == "" {
		return clientPacket{}, fmt.Errorf("empty engine.io packet")
	}
	packet := clientPacket{EngineType: raw[0]}
	if packet.EngineType < engineOpen || packet.EngineType > '6' {
		return clientPacket{}, fmt.Errorf("unsupported engine.io packet type %q", packet.EngineType)
	}
	if packet.EngineType != engineMessage {
		return packet, nil
	}
	if len(raw) < 2 {
		return clientPacket{}, fmt.Errorf("empty socket.io packet")
	}
	packet.SocketType = raw[1]
	switch packet.SocketType {
	case socketConnect, socketDisconnect, socketEvent, socketAck,
		socketConnectError, socketBinaryEvent, socketBinaryAck:
	default:
		return clientPacket{}, fmt.Errorf("unsupported socket.io packet type %q", packet.SocketType)
	}

	rest := raw[2:]
	if packet.SocketType == socketBinaryEvent || packet.SocketType == socketBinaryAck {
		// Binary packets announce the attachment count before the namespace:
		// "<type><attachments>-<namespace>,<ack id><json>".
		index := strings.IndexByte(rest, '-')
		if index <= 0 {
			return clientPacket{}, fmt.Errorf("socket.io binary packet is missing its attachment count")
		}
		attachments, err := strconv.Atoi(rest[:index])
		if err != nil || attachments < 0 {
			return clientPacket{}, fmt.Errorf("invalid socket.io attachment count %q", rest[:index])
		}
		packet.Attachments = attachments
		rest = rest[index+1:]
	}

	packet.Namespace = namespaceRoot
	if strings.HasPrefix(rest, "/") {
		if index := strings.IndexByte(rest, ','); index >= 0 {
			packet.Namespace = rest[:index]
			rest = rest[index+1:]
		} else {
			// A namespace may be the last segment of the frame, but a valid
			// socket.io encoder always appends a comma when a namespace is
			// present. Accept the truncated form anyway; the payload stays empty.
			packet.Namespace = rest
			rest = ""
		}
	}

	switch packet.SocketType {
	case socketConnect:
		// CONNECT data is the handshake auth object. socket.io-parser requires
		// it to be a JSON object when present (Decoder.isPayloadValid).
		if trimmed := strings.TrimSpace(rest); trimmed != "" {
			if trimmed[0] != '{' || !json.Valid([]byte(trimmed)) {
				return clientPacket{}, fmt.Errorf("socket.io CONNECT payload must be a JSON object")
			}
		}
		packet.Payload = []byte(rest)
	case socketDisconnect:
		if strings.TrimSpace(rest) != "" {
			return clientPacket{}, fmt.Errorf("unexpected socket.io DISCONNECT payload")
		}
	case socketConnectError:
		// A browser client never sends CONNECT_ERROR; keep the payload so the
		// dispatcher can report the protocol violation.
		packet.Payload = []byte(rest)
	default:
		// EVENT, ACK, BINARY_EVENT and BINARY_ACK may carry a decimal ack id
		// immediately before the JSON payload.
		index := 0
		for index < len(rest) && rest[index] >= '0' && rest[index] <= '9' {
			index++
		}
		if index > 0 {
			ackID, err := strconv.ParseUint(rest[:index], 10, 64)
			if err != nil {
				return clientPacket{}, fmt.Errorf("invalid socket.io ack id %q", rest[:index])
			}
			packet.AckID = ackID
			packet.HasAckID = true
		}
		packet.Payload = []byte(rest[index:])
	}
	return packet, nil
}

// parseEventPayload splits a Socket.IO EVENT payload ("[\"event\",args...]")
// into the event name and a JSON array with the remaining arguments. Individual
// argument bytes are kept verbatim so field order inside an argument is not
// rewritten.
func parseEventPayload(payload []byte) (string, []byte, error) {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return "", nil, fmt.Errorf("socket.io EVENT payload must be a JSON array")
	}
	var fields []json.RawMessage
	if err := json.Unmarshal(trimmed, &fields); err != nil {
		return "", nil, fmt.Errorf("decode socket.io EVENT payload: %w", err)
	}
	if len(fields) == 0 {
		return "", nil, fmt.Errorf("socket.io EVENT payload is empty")
	}
	var event string
	if err := json.Unmarshal(fields[0], &event); err != nil {
		// socket.io-parser also accepts a numeric first element, but no Go
		// transport registers numeric event names; treat it as a violation.
		return "", nil, fmt.Errorf("socket.io EVENT name must be a string")
	}
	if _, reserved := reservedEventNames[event]; reserved {
		return "", nil, fmt.Errorf("reserved socket.io event name %q", event)
	}
	var args bytes.Buffer
	args.WriteByte('[')
	for index, field := range fields[1:] {
		if index > 0 {
			args.WriteByte(',')
		}
		args.Write(field)
	}
	args.WriteByte(']')
	return event, args.Bytes(), nil
}

// namespacePrefix returns the wire prefix for a namespace, including the
// trailing comma. The root namespace is encoded without any prefix.
func namespacePrefix(namespace string) string {
	if namespace == "" || namespace == namespaceRoot {
		return ""
	}
	return namespace + ","
}

// encodeOpen builds the Engine.IO open packet. Field order matches
// engine.io 6.6.4 (socket.js handshake): sid, upgrades, pingInterval,
// pingTimeout, maxPayload.
func encodeOpen(sid string, pingIntervalMs, pingTimeoutMs int, maxPayload int64) string {
	body, _ := json.Marshal(struct {
		SID          string   `json:"sid"`
		Upgrades     []string `json:"upgrades"`
		PingInterval int      `json:"pingInterval"`
		PingTimeout  int      `json:"pingTimeout"`
		MaxPayload   int64    `json:"maxPayload"`
	}{
		SID:          sid,
		Upgrades:     []string{},
		PingInterval: pingIntervalMs,
		PingTimeout:  pingTimeoutMs,
		MaxPayload:   maxPayload,
	})
	return string(engineOpen) + string(body)
}

// encodeConnectAck builds the Socket.IO CONNECT acknowledgement that moves one
// namespace socket to the connected state. Keeping a stable sid per namespace is
// what makes the multiplexing visible to the browser.
func encodeConnectAck(namespace, sid string) string {
	body, _ := json.Marshal(struct {
		SID string `json:"sid"`
	}{SID: sid})
	return string(engineMessage) + string(socketConnect) + namespacePrefix(namespace) + string(body)
}

// encodeEvent builds a Socket.IO EVENT packet from already marshalled payload
// bytes. The payload is spliced into the "[event,payload]" array verbatim, so
// marshalling a business DTO twice cannot reorder its fields.
func encodeEvent(namespace, event string, payloadJSON []byte) (string, error) {
	name, err := json.Marshal(event)
	if err != nil {
		return "", fmt.Errorf("marshal socket.io event name %q: %w", event, err)
	}
	var body bytes.Buffer
	body.WriteByte('[')
	body.Write(name)
	if len(payloadJSON) > 0 {
		if !json.Valid(payloadJSON) {
			return "", fmt.Errorf("socket.io event %q payload is not valid JSON", event)
		}
		body.WriteByte(',')
		body.Write(payloadJSON)
	}
	body.WriteByte(']')
	return string(engineMessage) + string(socketEvent) + namespacePrefix(namespace) + body.String(), nil
}

// encodeDisconnect builds a Socket.IO DISCONNECT packet for one namespace. The
// root namespace encodes as "41"; every other namespace encodes as "41/ns,".
func encodeDisconnect(namespace string) string {
	return string(engineMessage) + string(socketDisconnect) + namespacePrefix(namespace)
}

// encodeConnectError builds the Socket.IO CONNECT_ERROR packet. The browser
// maps data.message to the connect_error error object.
func encodeConnectError(namespace, message string) string {
	body, _ := json.Marshal(struct {
		Message string `json:"message"`
	}{Message: message})
	return string(engineMessage) + string(socketConnectError) + namespacePrefix(namespace) + string(body)
}

// newSocketID returns a random Engine.IO connection / namespace socket id.
func newSocketID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		// The id is only a correlation token. A fixed fallback keeps the
		// connection usable if the OS entropy source is unavailable; two
		// sessions may then share an id but multiplexing still keys on the
		// namespace.
		return "go-socketio"
	}
	return hex.EncodeToString(buf)
}
