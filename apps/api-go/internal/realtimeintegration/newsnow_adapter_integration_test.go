//go:build integration

package realtimeintegration

import (
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/realtimeevents"
	"github.com/wei500L/newwei/apps/api-go/internal/realtimesocket"
)

// newsnowWirePayload mirrors the newsnow:update payload produced by the NestJS
// dispatcher/gateway. The msgpack tags keep the declared (NestJS insertion)
// order in the adapter message; the json tags are the expected client wire
// names.
type newsnowWirePayload struct {
	OrgID         string   `msgpack:"orgId" json:"orgId"`
	SourceID      string   `msgpack:"sourceId" json:"sourceId"`
	NewItemsCount int      `msgpack:"newItemsCount" json:"newItemsCount"`
	TopTitles     []string `msgpack:"topTitles" json:"topTitles"`
	UpdatedTime   string   `msgpack:"updatedTime" json:"updatedTime"`
	IntervalMs    int      `msgpack:"intervalMs" json:"intervalMs"`
	Timestamp     string   `msgpack:"timestamp" json:"timestamp"`
}

// newsnowUpdate is the decoded client-side event payload.
type newsnowUpdate struct {
	OrgID         string   `json:"orgId"`
	SourceID      string   `json:"sourceId"`
	NewItemsCount int      `json:"newItemsCount"`
	TopTitles     []string `json:"topTitles"`
	UpdatedTime   string   `json:"updatedTime"`
	IntervalMs    int      `json:"intervalMs"`
	Timestamp     string   `json:"timestamp"`
}

// TestRealtimeNewsnowAdapterIntegration publishes hand-encoded
// @socket.io/redis-adapter msgpack messages (the exact bytes the NestJS
// NewsnowGateway would publish) into Redis and verifies the Go sources decode
// them and deliver newsnow:update only to the online sockets of the target org.
//
// Both adapter channel shapes are covered:
//   - base channel "<key>#/newsnow#" with a rooms array (multi-room broadcast);
//   - single-room channel "<key>#/newsnow#org:<id>#" (one-room broadcast).
func TestRealtimeNewsnowAdapterIntegration(t *testing.T) {
	h := newHarness(t)
	h.seedMember(t, "org-newsnow-a", "user-newsnow-a", "items.read")
	h.seedMember(t, "org-newsnow-b", "user-newsnow-b", "items.read")

	runtime := h.newRealtimeRuntime(t, h.realtimeOptions())
	server := serveRealtime(t, runtime)
	h.newRealtimeSources(t, realtimeevents.Options{}, runtime)

	clientA := dialSocketClient(t, server.URL, realtimesocket.Path)
	_ = clientA.connectNamespace(t, realtimesocket.NamespaceNewsnow,
		map[string]any{"token": h.accessToken(t, "user-newsnow-a", "org-newsnow-a")})
	clientA.waitEvent(t, realtimesocket.NamespaceNewsnow, "newsnow:connected", defaultFrameTimeout)

	clientB := dialSocketClient(t, server.URL, realtimesocket.Path)
	_ = clientB.connectNamespace(t, realtimesocket.NamespaceNewsnow,
		map[string]any{"token": h.accessToken(t, "user-newsnow-b", "org-newsnow-b")})
	clientB.waitEvent(t, realtimesocket.NamespaceNewsnow, "newsnow:connected", defaultFrameTimeout)

	payload := newsnowWirePayload{
		OrgID:         "org-newsnow-a",
		SourceID:      "source-1",
		NewItemsCount: 2,
		TopTitles:     []string{"first title", "second title"},
		UpdatedTime:   "2026-10-20T20:00:00.000Z",
		IntervalMs:    60_000,
		Timestamp:     "2026-10-20T20:00:01.000Z",
	}
	// uid is an arbitrary 6-character URL-safe id that is different from the
	// Sources' own uid, so the adapter own-message filter must accept it.
	message := encodeAdapterBroadcast(t, "AbCd12", realtimesocket.NamespaceNewsnow,
		"newsnow:update", payload, []string{"org:org-newsnow-a"})

	// 1) Single-room channel: exactly what server.to("org:<id>").emit() publishes.
	if err := h.redis.Publish(h.ctx, adapterChannel(defaultAdapterKey, realtimesocket.NamespaceNewsnow, "org:org-newsnow-a"), message).Err(); err != nil {
		t.Fatalf("publish single-room adapter message: %v", err)
	}
	firstEvent := clientA.waitEvent(t, realtimesocket.NamespaceNewsnow, "newsnow:update", defaultFrameTimeout)
	decoded := decodePayload[newsnowUpdate](t, firstEvent)
	if decoded.OrgID != payload.OrgID || decoded.SourceID != payload.SourceID ||
		decoded.NewItemsCount != payload.NewItemsCount || decoded.UpdatedTime != payload.UpdatedTime ||
		decoded.IntervalMs != payload.IntervalMs || decoded.Timestamp != payload.Timestamp {
		t.Fatalf("newsnow:update payload = %+v, want the msgpack payload %+v", decoded, payload)
	}
	if len(decoded.TopTitles) != len(payload.TopTitles) ||
		decoded.TopTitles[0] != payload.TopTitles[0] || decoded.TopTitles[1] != payload.TopTitles[1] {
		t.Fatalf("newsnow:update topTitles = %v, want %v", decoded.TopTitles, payload.TopTitles)
	}
	// Field order is part of the NestJS wire contract: the adapter decodes
	// msgpack and the transport splices the raw JSON payload, so the original
	// insertion order must survive.
	assertKeyOrder(t, firstEvent.Raw, "newsnow:update",
		"orgId", "sourceId", "newItemsCount", "topTitles", "updatedTime", "intervalMs", "timestamp")

	// 2) Base channel with the room in opts.rooms: the adapter uses this shape
	// when more than one room (or the whole namespace) is targeted.
	secondPayload := payload
	secondPayload.NewItemsCount = 3
	secondPayload.SourceID = "source-2"
	baseMessage := encodeAdapterBroadcast(t, "ZzYyXx", realtimesocket.NamespaceNewsnow,
		"newsnow:update", secondPayload, []string{"org:org-newsnow-a"})
	if err := h.redis.Publish(h.ctx, adapterChannel(defaultAdapterKey, realtimesocket.NamespaceNewsnow), baseMessage).Err(); err != nil {
		t.Fatalf("publish base-channel adapter message: %v", err)
	}
	secondEvent := clientA.waitEvent(t, realtimesocket.NamespaceNewsnow, "newsnow:update", defaultFrameTimeout)
	secondDecoded := decodePayload[newsnowUpdate](t, secondEvent)
	if secondDecoded.SourceID != "source-2" || secondDecoded.NewItemsCount != 3 {
		t.Fatalf("base-channel newsnow:update payload = %+v, want source-2/3", secondDecoded)
	}

	// The org B socket is in a different room and must never observe either
	// event.
	clientB.assertNoEventFor(t, realtimesocket.NamespaceNewsnow, "newsnow:update", 700*time.Millisecond)

	// A message addressed to a room with no local socket must be dropped
	// without delivering to unrelated sockets.
	foreign := encodeAdapterBroadcast(t, "QqWwEe", realtimesocket.NamespaceNewsnow,
		"newsnow:update", payload, []string{"org:org-newsnow-unknown"})
	if err := h.redis.Publish(h.ctx, adapterChannel(defaultAdapterKey, realtimesocket.NamespaceNewsnow, "org:org-newsnow-unknown"), foreign).Err(); err != nil {
		t.Fatalf("publish foreign-room adapter message: %v", err)
	}
	clientA.assertNoEventFor(t, realtimesocket.NamespaceNewsnow, "newsnow:update", 500*time.Millisecond)

	// Exactly two events were observed by org A (the two targeted publishes).
	if count := clientA.eventCount(realtimesocket.NamespaceNewsnow, "newsnow:update"); count != 2 {
		t.Fatalf("org A observed %d newsnow:update events, want exactly 2", count)
	}
}
