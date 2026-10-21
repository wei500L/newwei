package realtimesocket

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestLocalPublishRoomSelection(t *testing.T) {
	harness := newTestRuntime(t, nil)
	tokenU1 := signToken(t, "u1", "o1", "", time.Now().Add(time.Hour))
	tokenU2 := signToken(t, "u2", "o1", "", time.Now().Add(time.Hour))
	tokenU3 := signToken(t, "u3", "o2", "", time.Now().Add(time.Hour))

	connA := harness.dial(t)
	readOpen(t, connA)
	connectBrowser(t, connA, NamespaceNewsnow, tokenU1, "o1", "u1")

	connB := harness.dial(t)
	readOpen(t, connB)
	connectBrowser(t, connB, NamespaceNewsnow, tokenU2, "o1", "u2")

	connC := harness.dial(t)
	readOpen(t, connC)
	connectBrowser(t, connC, NamespaceNewsnow, tokenU3, "o2", "u3")

	opsConn := harness.dial(t)
	readOpen(t, opsConn)
	connectBrowser(t, opsConn, NamespaceOps, tokenU1, "o1", "u1")

	// Step 1: org room. The payload keeps its original byte order and is
	// spliced verbatim into the EVENT frame.
	orgPayload := json.RawMessage(`{"z":1,"a":2,"m":null}`)
	harness.runtime.PublishOrg(NamespaceNewsnow, "o1", "newsnow:update", orgPayload)
	harness.runtime.PublishRooms(NamespaceNewsnow, nil, nil, "sentinel:1", json.RawMessage(`{"sentinel":1}`))
	if event := expectEvent(t, connA, NamespaceNewsnow, "newsnow:update"); string(event.payload) != string(orgPayload) {
		t.Fatalf("payload = %s, want %s", event.payload, orgPayload)
	}
	expectEvent(t, connA, NamespaceNewsnow, "sentinel:1")
	expectEvent(t, connB, NamespaceNewsnow, "newsnow:update")
	expectEvent(t, connB, NamespaceNewsnow, "sentinel:1")
	// connC is in another org and must see the sentinel first.
	expectEvent(t, connC, NamespaceNewsnow, "sentinel:1")

	// Step 2: user room, intersected with the org so a user id from another
	// tenant cannot receive the event.
	harness.runtime.PublishUser(NamespaceNewsnow, "o1", "u1", "newsnow:user", json.RawMessage(`{"n":2}`))
	harness.runtime.PublishUser(NamespaceNewsnow, "o2", "u1", "newsnow:cross-tenant", json.RawMessage(`{"n":3}`))
	harness.runtime.PublishRooms(NamespaceNewsnow, nil, nil, "sentinel:2", json.RawMessage(`{"sentinel":2}`))
	expectEvent(t, connA, NamespaceNewsnow, "newsnow:user")
	expectEvent(t, connA, NamespaceNewsnow, "sentinel:2")
	expectEvent(t, connB, NamespaceNewsnow, "sentinel:2")
	expectEvent(t, connC, NamespaceNewsnow, "sentinel:2")

	// Step 3: empty rooms targets the whole namespace, except rooms are removed.
	harness.runtime.PublishRooms(NamespaceNewsnow, nil, []string{userRoom("u1")}, "newsnow:except", json.RawMessage(`{"n":4}`))
	harness.runtime.PublishRooms(NamespaceNewsnow, nil, nil, "sentinel:3", json.RawMessage(`{"sentinel":3}`))
	expectEvent(t, connA, NamespaceNewsnow, "sentinel:3")
	expectEvent(t, connB, NamespaceNewsnow, "newsnow:except")
	expectEvent(t, connB, NamespaceNewsnow, "sentinel:3")
	expectEvent(t, connC, NamespaceNewsnow, "newsnow:except")
	expectEvent(t, connC, NamespaceNewsnow, "sentinel:3")

	// Step 4: several rooms are unioned and except removes one member.
	harness.runtime.PublishRooms(
		NamespaceNewsnow,
		[]string{orgRoom("o1"), orgRoom("o2")},
		[]string{userRoom("u2")},
		"newsnow:union",
		json.RawMessage(`{"n":5}`),
	)
	harness.runtime.PublishRooms(NamespaceNewsnow, nil, nil, "sentinel:4", json.RawMessage(`{"sentinel":4}`))
	expectEvent(t, connA, NamespaceNewsnow, "newsnow:union")
	expectEvent(t, connA, NamespaceNewsnow, "sentinel:4")
	expectEvent(t, connB, NamespaceNewsnow, "sentinel:4")
	expectEvent(t, connC, NamespaceNewsnow, "newsnow:union")
	expectEvent(t, connC, NamespaceNewsnow, "sentinel:4")

	// Step 5: another namespace never sees the newsnow pushes. The first frame
	// on the ops socket is the ops event itself.
	harness.runtime.PublishOrg(NamespaceOps, "o1", "ops:event", json.RawMessage(`{"n":6}`))
	expectEvent(t, opsConn, NamespaceOps, "ops:event")

	// Step 6: local indexes are deduplicated and org-scoped.
	if got := harness.runtime.LocalOrgIDs(NamespaceNewsnow); !reflect.DeepEqual(got, []string{"o1", "o2"}) {
		t.Fatalf("LocalOrgIDs(newsnow) = %v, want [o1 o2]", got)
	}
	if got := harness.runtime.LocalUsers(NamespaceNewsnow, "o1"); !reflect.DeepEqual(got, []string{"u1", "u2"}) {
		t.Fatalf("LocalUsers(newsnow, o1) = %v, want [u1 u2]", got)
	}
	if got := harness.runtime.LocalUsers(NamespaceNewsnow, "o2"); !reflect.DeepEqual(got, []string{"u3"}) {
		t.Fatalf("LocalUsers(newsnow, o2) = %v, want [u3]", got)
	}
	if got := harness.runtime.LocalUsers(NamespaceOps, "o1"); !reflect.DeepEqual(got, []string{"u1"}) {
		t.Fatalf("LocalUsers(ops, o1) = %v, want [u1]", got)
	}

	// Step 7: closing one socket cleans the local index.
	if err := connA.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatalf("close connA: %v", err)
	}
	waitFor(t, "connA to be removed from the local index", func() bool {
		return reflect.DeepEqual(harness.runtime.LocalUsers(NamespaceNewsnow, "o1"), []string{"u2"})
	})
	if got := harness.runtime.LocalOrgIDs(NamespaceNewsnow); !reflect.DeepEqual(got, []string{"o1", "o2"}) {
		t.Fatalf("LocalOrgIDs(newsnow) after close = %v, want [o1 o2]", got)
	}
}

func TestSituationMonitorJoinsGlobalRoom(t *testing.T) {
	harness := newTestRuntime(t, nil)
	conn := harness.dial(t)
	readOpen(t, conn)
	token := signToken(t, "u1", "o1", "", time.Now().Add(time.Hour))
	connectBrowser(t, conn, NamespaceSituationMonitor, token, "o1", "u1")

	harness.runtime.PublishRooms(
		NamespaceSituationMonitor,
		[]string{situationMonitorGlobalRoom},
		nil,
		"situation:telegram.update",
		json.RawMessage(`{"count":3}`),
	)
	event := expectEvent(t, conn, NamespaceSituationMonitor, "situation:telegram.update")
	if string(event.payload) != `{"count":3}` {
		t.Fatalf("situation payload = %s, want {\"count\":3}", event.payload)
	}

	// A user-targeted push is the next frame, which also proves the previous
	// global-room event was the only event delivered for that push.
	harness.runtime.PublishRooms(
		NamespaceSituationMonitor,
		[]string{userRoom("u1")},
		nil,
		"situation:oref.update",
		json.RawMessage(`{"alerts":[]}`),
	)
	expectEvent(t, conn, NamespaceSituationMonitor, "situation:oref.update")
}

func TestLocalPublishSkipsInvalidPayloadAndUnknownNamespace(t *testing.T) {
	harness := newTestRuntime(t, nil)
	conn := harness.dial(t)
	readOpen(t, conn)
	token := signToken(t, "u1", "o1", "", time.Now().Add(time.Hour))
	connectBrowser(t, conn, NamespaceNewsnow, token, "o1", "u1")

	harness.runtime.PublishRooms(NamespaceNewsnow, nil, nil, "newsnow:broken", json.RawMessage(`{not-json`))
	harness.runtime.PublishRooms(NamespaceNewsnow, nil, nil, "sentinel:valid", json.RawMessage(`{"ok":true}`))
	expectEvent(t, conn, NamespaceNewsnow, "sentinel:valid")

	harness.runtime.PublishOrg("/unknown", "o1", "ignored:event", json.RawMessage(`{"n":1}`))
	harness.runtime.PublishUser("/unknown", "o1", "u1", "ignored:event", json.RawMessage(`{"n":1}`))
	if got := harness.runtime.LocalOrgIDs("/unknown"); got != nil {
		t.Fatalf("LocalOrgIDs(unknown) = %v, want nil", got)
	}
	if got := harness.runtime.LocalUsers("/unknown", "o1"); got != nil {
		t.Fatalf("LocalUsers(unknown) = %v, want nil", got)
	}
	// The socket is still healthy after the ignored pushes.
	harness.runtime.PublishRooms(NamespaceNewsnow, nil, nil, "sentinel:after-unknown", json.RawMessage(`{"ok":true}`))
	expectEvent(t, conn, NamespaceNewsnow, "sentinel:after-unknown")
}
