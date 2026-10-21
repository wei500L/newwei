package realtimesocket

import (
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestNewsnowClientEventForwardingAndDisconnectCleanup(t *testing.T) {
	harness := newTestRuntime(t, nil)
	conn := harness.dial(t)
	readOpen(t, conn)
	token := signToken(t, "u1", "o1", "", time.Now().Add(time.Hour))
	sid := connectBrowser(t, conn, NamespaceNewsnow, token, "o1", "u1")

	// An event without a gateway handler must be ignored.
	mustWriteFrame(t, conn, `42/newsnow,["newsnow:unknown",{"x":1}]`)
	// The only registered client handler forwards its raw argument array.
	mustWriteFrame(t, conn, `42/newsnow,["newsnow:set-active-sources",{"sourceIds":["a","b"]}]`)

	waitFor(t, "the newsnow client event", func() bool {
		return harness.clientEvents.eventCount() == 1
	})
	events := harness.clientEvents.eventSnapshot()
	if events[0].namespace != NamespaceNewsnow {
		t.Fatalf("event namespace = %q, want %q", events[0].namespace, NamespaceNewsnow)
	}
	if events[0].event != eventNewsnowSetActiveSources {
		t.Fatalf("event = %q, want %q", events[0].event, eventNewsnowSetActiveSources)
	}
	wantIdentity := ClientIdentity{SocketID: sid, OrgID: "o1", UserID: "u1"}
	if events[0].identity != wantIdentity {
		t.Fatalf("identity = %+v, want %+v", events[0].identity, wantIdentity)
	}
	if got := string(events[0].args); got != `[{"sourceIds":["a","b"]}]` {
		t.Fatalf("args = %s, want [{\"sourceIds\":[\"a\",\"b\"]}]", got)
	}

	if err := conn.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatalf("close connection: %v", err)
	}
	waitFor(t, "the newsnow disconnect callback", func() bool {
		return harness.clientEvents.disconnectCount() == 1
	})
	disconnects := harness.clientEvents.disconnectSnapshot()
	if disconnects[0].namespace != NamespaceNewsnow {
		t.Fatalf("disconnect namespace = %q, want %q", disconnects[0].namespace, NamespaceNewsnow)
	}
	if disconnects[0].identity != wantIdentity {
		t.Fatalf("disconnect identity = %+v, want %+v", disconnects[0].identity, wantIdentity)
	}
	waitFor(t, "the local index to be cleaned", func() bool {
		return len(harness.runtime.LocalUsers(NamespaceNewsnow, "o1")) == 0
	})
}

func TestNonNewsnowClientEventsAreIgnored(t *testing.T) {
	harness := newTestRuntime(t, nil)
	conn := harness.dial(t)
	readOpen(t, conn)
	token := signToken(t, "u1", "o1", "", time.Now().Add(time.Hour))
	connectBrowser(t, conn, NamespaceOps, token, "o1", "u1")

	mustWriteFrame(t, conn, `42/ops,["ops:event",{"n":1}]`)
	time.Sleep(50 * time.Millisecond)
	if count := harness.clientEvents.eventCount(); count != 0 {
		t.Fatalf("client events forwarded for an unsupported namespace: %d", count)
	}
}

func TestNilClientEventsIgnoresBrowserEvents(t *testing.T) {
	harness := newTestRuntime(t, func(options *Options) {
		options.ClientEvents = nil
	})
	conn := harness.dial(t)
	readOpen(t, conn)
	token := signToken(t, "u1", "o1", "", time.Now().Add(time.Hour))
	connectBrowser(t, conn, NamespaceNewsnow, token, "o1", "u1")

	mustWriteFrame(t, conn, `42/newsnow,["newsnow:set-active-sources",{"sourceIds":["a"]}]`)
	time.Sleep(50 * time.Millisecond)
	harness.runtime.PublishRooms(NamespaceNewsnow, nil, nil, "newsnow:update", []byte(`{"n":1}`))
	expectEvent(t, conn, NamespaceNewsnow, "newsnow:update")
}
