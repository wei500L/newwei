// Package notificationssocket owns the Go implementation of the Socket.IO
// "notifications" namespace for the Web console.
//
// Protocol subset: this is not a general Socket.IO server. It accepts the
// WebSocket-only Engine.IO v4 transport used by the existing browser client
// (socket.io-client 4.x forces transports: ["websocket"]) and the Socket.IO v5
// packet types CONNECT, DISCONNECT, EVENT, PING and PONG for one namespace.
// Polling, binary attachments, acknowledgements, other namespaces and the
// Redis adapter are deliberately left to the NestJS implementation.
//
// Event sources: in go mode the NestJS business services only publish an
// identifiers-only Redis envelope after the Notification row is committed.
// This package re-reads that row and emits it locally. It never fans a
// notification out through the Socket.IO Redis adapter, so one business event
// is delivered once per connected browser even when several API instances are
// running (B1 local push). The row is re-read and its type/presentation is
// re-checked before emitting (B2 re-check); the relay itself never carries the
// mutable display payload.
package notificationssocket

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
)

const (
	// Namespace is the only Socket.IO namespace this transport serves.
	Namespace = "/notifications"

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
)

// clientPacket is one decoded Socket.IO packet from the browser. EnginePing
// and EnginePong are represented without a socket type; the caller handles
// them before looking at SocketType.
type clientPacket struct {
	EngineType byte
	SocketType byte
	Namespace  string
	Payload    []byte
}

func parseClientPacket(raw string) (clientPacket, error) {
	if raw == "" {
		return clientPacket{}, fmt.Errorf("empty engine.io packet")
	}
	packet := clientPacket{EngineType: raw[0]}
	if packet.EngineType != engineMessage {
		if packet.EngineType < engineOpen || packet.EngineType > '6' {
			return clientPacket{}, fmt.Errorf("unsupported engine.io packet type %q", packet.EngineType)
		}
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
	packet.Namespace = "/"
	if strings.HasPrefix(rest, "/") {
		index := strings.IndexByte(rest, ',')
		if index < 0 {
			packet.Namespace = rest
			return packet, nil
		}
		packet.Namespace = rest[:index]
		rest = rest[index+1:]
	}
	packet.Payload = []byte(rest)
	return packet, nil
}

func encodeOpen(sid string, pingIntervalMs, pingTimeoutMs int) string {
	body, _ := json.Marshal(struct {
		SID          string   `json:"sid"`
		Upgrades     []string `json:"upgrades"`
		PingInterval int      `json:"pingInterval"`
		PingTimeout  int      `json:"pingTimeout"`
		MaxPayload   int      `json:"maxPayload"`
	}{
		SID:          sid,
		Upgrades:     []string{},
		PingInterval: pingIntervalMs,
		PingTimeout:  pingTimeoutMs,
		MaxPayload:   maxMessageBytes,
	})
	return string(engineOpen) + string(body)
}

func encodeConnectAck(namespace, sid string) string {
	body, _ := json.Marshal(struct {
		SID string `json:"sid"`
	}{SID: sid})
	return string(engineMessage) + string(socketConnect) + namespace + "," + string(body)
}

func encodeEvent(namespace, event string, payload any) (string, error) {
	body, err := json.Marshal([]any{event, payload})
	if err != nil {
		return "", err
	}
	return string(engineMessage) + string(socketEvent) + namespace + "," + string(body), nil
}

func encodeDisconnect(namespace string) string {
	return string(engineMessage) + string(socketDisconnect) + namespace + ","
}

func encodeConnectError(namespace, message string) string {
	body, _ := json.Marshal(struct {
		Message string `json:"message"`
	}{Message: message})
	return string(engineMessage) + string(socketConnectError) + namespace + "," + string(body)
}

func newSocketID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		// The id is only a Socket.IO correlation token. A short fallback keeps
		// the connection usable if the OS entropy source is unavailable.
		return "go-notifications"
	}
	return hex.EncodeToString(buf)
}
