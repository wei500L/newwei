//go:build integration

package realtimeintegration

import (
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/realtimesocket"
)

// namespaceConnectCase is one namespace served by the multiplexed transport.
type namespaceConnectCase struct {
	namespace string
	// connectedEvent is the namespace-specific connection event (NestJS emits
	// <ns>:connected right after the socket joins its org/user/ip rooms).
	connectedEvent string
}

// TestRealtimeNamespaceConnectIntegration covers the minimal Socket.IO client
// against the real transport:
//   - one Engine.IO connection multiplexes CONNECT for all five namespaces and
//     every namespace receives its own CONNECT ack with an independent sid;
//   - each namespace follows up with <ns>:connected carrying {orgId,userId};
//   - a user missing queue.manage receives queue:error
//     {code:"UNAUTHORIZED", message:"Unauthorized"} followed by namespace
//     DISCONNECT and the underlying connection closing (disconnect(true)).
//
// The second half runs on a fresh connection because disconnect(true) tears down
// every namespace on the Engine.IO connection, exactly like socket.io 4.8.1.
func TestRealtimeNamespaceConnectIntegration(t *testing.T) {
	h := newHarness(t)
	h.seedMember(t, "org-connect", "user-connect",
		"items.read", "crawl.read", "settings.manage", "queue.manage")
	runtime := h.newRealtimeRuntime(t, h.realtimeOptions())
	server := serveRealtime(t, runtime)
	token := h.accessToken(t, "user-connect", "org-connect")

	client := dialSocketClient(t, server.URL, realtimesocket.Path)

	// The Engine.IO open packet must mirror the NestJS engine.io 6.6.4
	// defaults: 25s ping interval, 20s ping timeout and the 1e6 maxPayload.
	if client.open.PingInterval != 25000 {
		t.Fatalf("open.pingInterval = %d, want 25000", client.open.PingInterval)
	}
	if client.open.PingTimeout != 20000 {
		t.Fatalf("open.pingTimeout = %d, want 20000", client.open.PingTimeout)
	}
	if client.open.MaxPayload != 1_000_000 {
		t.Fatalf("open.maxPayload = %d, want 1000000", client.open.MaxPayload)
	}

	cases := []namespaceConnectCase{
		{realtimesocket.NamespaceNewsnow, "newsnow:connected"},
		{realtimesocket.NamespaceOps, "ops:connected"},
		{realtimesocket.NamespaceQuality, "quality:connected"},
		{realtimesocket.NamespaceQueue, "queue:connected"},
		{realtimesocket.NamespaceSituationMonitor, "situation:connected"},
	}

	// Socket.IO allows CONNECT frames for different namespaces interleaved on
	// one Engine.IO connection; the transport assigns an independent sid per
	// namespace socket.
	sids := map[string]string{}
	for _, testCase := range cases {
		sid := client.connectNamespace(t, testCase.namespace, map[string]any{"token": token})
		sids[testCase.namespace] = sid
	}
	seenSIDs := map[string]string{}
	for namespace, sid := range sids {
		if previous, duplicate := seenSIDs[sid]; duplicate {
			t.Fatalf("namespace %q and %q share sid %q; each namespace socket needs its own sid", previous, namespace, sid)
		}
		seenSIDs[sid] = namespace
	}

	type connectedPayload struct {
		OrgID  string `json:"orgId"`
		UserID string `json:"userId"`
	}
	for _, testCase := range cases {
		event := client.waitEvent(t, testCase.namespace, testCase.connectedEvent, defaultFrameTimeout)
		payload := decodePayload[connectedPayload](t, event)
		if payload.OrgID != "org-connect" || payload.UserID != "user-connect" {
			t.Fatalf("%s payload = %+v, want orgId=org-connect userId=user-connect", testCase.connectedEvent, payload)
		}
	}

	// Permission denial: the user is an active member with items.read and
	// settings.manage but lacks queue.manage. The CONNECT ack is already
	// written (NestJS order), so the error arrives as a queue:error event before
	// the namespace DISCONNECT frame and the transport close.
	h.seedMember(t, "org-denied", "user-denied", "items.read", "crawl.read", "settings.manage")
	deniedToken := h.accessToken(t, "user-denied", "org-denied")
	denied := dialSocketClient(t, server.URL, realtimesocket.Path)
	_ = denied.connectNamespace(t, realtimesocket.NamespaceQueue, map[string]any{"token": deniedToken})

	errorFrame := denied.waitEvent(t, realtimesocket.NamespaceQueue, "queue:error", defaultFrameTimeout)
	type errorPayload struct {
		Code         string `json:"code"`
		Message      string `json:"message"`
		RetryAfterMs *int64 `json:"retryAfterMs"`
	}
	decodedError := decodePayload[errorPayload](t, errorFrame)
	if decodedError.Code != "UNAUTHORIZED" || decodedError.Message != "Unauthorized" {
		t.Fatalf("queue:error payload = %+v, want {UNAUTHORIZED, Unauthorized}", decodedError)
	}
	if decodedError.RetryAfterMs != nil {
		t.Fatalf("queue:error retryAfterMs = %d, want omitted for an authentication rejection", *decodedError.RetryAfterMs)
	}

	// disconnect(true) semantics: DISCONNECT for the rejected namespace, then
	// the whole Engine.IO connection closes. No queue:connected may have been
	// emitted for the rejected socket.
	denied.waitDisconnect(t, realtimesocket.NamespaceQueue, defaultFrameTimeout)
	denied.waitClosed(t, defaultFrameTimeout)
	denied.assertNoEvent(t, realtimesocket.NamespaceQueue, "queue:connected")
}
