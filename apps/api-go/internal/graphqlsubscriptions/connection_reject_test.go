package graphqlsubscriptions

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/alerts"
)

func waitFor(t *testing.T, description string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", description)
}

// newAlertRuntime builds a local runtime with one authenticated alerts.read
// identity and no upstream transport of any kind.
func newAlertRuntime(t *testing.T) (*Runtime, *fakeSource) {
	t.Helper()
	source := newFakeSource()
	auth := &fakeAuth{identities: map[string]*authhttp.Identity{"token": alertIdentity("alerts.read")}}
	runtime := newTestRuntime(t, source, auth, &fakeLimiter{allowed: true}, 2*time.Second)
	return runtime, source
}

// TestLocalAndRejectedOperations proves a local subscription and a rejected
// non-subscription operation coexist on one connection: the local subscription
// streams events and the other operation gets an operation-level error instead
// of being forwarded to a NestJS graphql-ws upstream.
func TestLocalAndRejectedOperations(t *testing.T) {
	runtime, source := newAlertRuntime(t)
	server := httptest.NewServer(runtime)
	t.Cleanup(server.Close)

	conn := dialTestConnection(t, server.URL)
	initConnection(t, conn, "token")
	sendClientMessage(t, conn, map[string]any{
		"type": "subscribe", "id": "local",
		"payload": map[string]any{"query": `subscription { alertEvents { id } }`},
	})
	sendClientMessage(t, conn, map[string]any{
		"type": "subscribe", "id": "remote",
		"payload": map[string]any{"query": `query Me { me { id } }`, "operationName": "Me"},
	})
	source.waitForSubscribers(t, "alertEvents", "org-a", 1)

	failure := readServerMessage(t, conn)
	if failure.Type != "error" || failure.ID != "remote" {
		t.Fatalf("failure message = %+v, want an operation error for remote", failure)
	}
	if !strings.Contains(string(failure.Payload), "OPERATION_NOT_SUPPORTED") {
		t.Fatalf("failure payload = %s, want OPERATION_NOT_SUPPORTED", failure.Payload)
	}

	source.push("alertEvents", "org-a", FeedEvent{Value: alerts.AlertEventModel{
		ID: "event-1", TriggeredAt: time.Now(), Severity: "high", Status: "pending",
	}})
	next := decodeNextPayload(t, readServerMessage(t, conn))
	if next["data"].(map[string]any)["alertEvents"].(map[string]any)["id"] != "event-1" {
		t.Fatalf("local subscription after rejection = %v", next)
	}
}

// TestRejectedOperationDoesNotEndLocalSubscription proves a rejected operation
// is isolated: it does not close the connection or affect a later subscription.
func TestRejectedOperationDoesNotEndLocalSubscription(t *testing.T) {
	runtime, source := newAlertRuntime(t)
	server := httptest.NewServer(runtime)
	t.Cleanup(server.Close)

	conn := dialTestConnection(t, server.URL)
	initConnection(t, conn, "token")
	sendClientMessage(t, conn, map[string]any{
		"type": "subscribe", "id": "remote",
		"payload": map[string]any{"query": `query Me { me { id } }`},
	})
	failure := readServerMessage(t, conn)
	if failure.Type != "error" || failure.ID != "remote" {
		t.Fatalf("failure message = %+v, want an operation error for remote", failure)
	}
	if !strings.Contains(string(failure.Payload), "OPERATION_NOT_SUPPORTED") {
		t.Fatalf("failure payload = %s, want OPERATION_NOT_SUPPORTED", failure.Payload)
	}

	sendClientMessage(t, conn, map[string]any{
		"type": "subscribe", "id": "local",
		"payload": map[string]any{"query": `subscription { alertEvents { id } }`},
	})
	source.waitForSubscribers(t, "alertEvents", "org-a", 1)
	source.push("alertEvents", "org-a", FeedEvent{Value: alerts.AlertEventModel{
		ID: "event-1", TriggeredAt: time.Now(), Severity: "low", Status: "pending",
	}})
	next := decodeNextPayload(t, readServerMessage(t, conn))
	if next["data"].(map[string]any)["alertEvents"].(map[string]any)["id"] != "event-1" {
		t.Fatalf("local subscription after rejection = %v", next)
	}
}

// TestInvalidVariablesAreRejectedLocally proves a non-object variables value is
// answered with a local next(errors)+complete result and never forwarded: the
// runtime has no upstream transport to dial.
func TestInvalidVariablesAreRejectedLocally(t *testing.T) {
	runtime, source := newAlertRuntime(t)
	server := httptest.NewServer(runtime)
	t.Cleanup(server.Close)

	conn := dialTestConnection(t, server.URL)
	initConnection(t, conn, "token")
	sendClientMessage(t, conn, map[string]any{
		"type": "subscribe", "id": "bad",
		"payload": map[string]any{
			"query":     `subscription { alertEvents { id } }`,
			"variables": []any{"not-an-object"},
		},
	})

	result := readServerMessage(t, conn)
	if result.Type != "next" || result.ID != "bad" {
		t.Fatalf("result message = %+v, want next for bad", result)
	}
	payload := string(result.Payload)
	if !strings.Contains(payload, `"errors"`) || !strings.Contains(payload, "BAD_USER_INPUT") {
		t.Fatalf("variables rejection payload = %s, want a BAD_USER_INPUT error", payload)
	}
	complete := readServerMessage(t, conn)
	if complete.Type != "complete" || complete.ID != "bad" {
		t.Fatalf("completion message = %+v, want complete for bad", complete)
	}

	// The connection stays usable after the local rejection.
	sendClientMessage(t, conn, map[string]any{
		"type": "subscribe", "id": "local",
		"payload": map[string]any{"query": `subscription { alertEvents { id } }`},
	})
	source.waitForSubscribers(t, "alertEvents", "org-a", 1)
	source.push("alertEvents", "org-a", FeedEvent{Value: alerts.AlertEventModel{
		ID: "event-1", TriggeredAt: time.Now(), Severity: "high", Status: "pending",
	}})
	next := decodeNextPayload(t, readServerMessage(t, conn))
	if next["data"].(map[string]any)["alertEvents"].(map[string]any)["id"] != "event-1" {
		t.Fatalf("local subscription after variables rejection = %v", next)
	}
}
