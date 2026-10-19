package graphqlsubscriptions

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/alerts"
)

type legacyRecorder struct {
	mu          sync.Mutex
	accepts     int
	initPayload json.RawMessage
	operations  []json.RawMessage
	completes   int
}

func (r *legacyRecorder) recordOperation(payload json.RawMessage) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.operations = append(r.operations, append(json.RawMessage{}, payload...))
}

func (r *legacyRecorder) counts() (int, int, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.accepts, len(r.operations), r.completes
}

func (r *legacyRecorder) init() json.RawMessage {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append(json.RawMessage{}, r.initPayload...)
}

func newLegacyRecorderServer(t *testing.T, recorder *legacyRecorder, closeBeforeAck bool) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		conn, err := websocket.Accept(w, request, &websocket.AcceptOptions{
			Subprotocols:       []string{protocolName},
			InsecureSkipVerify: true,
		})
		if err != nil {
			return
		}
		defer conn.CloseNow()
		recorder.mu.Lock()
		recorder.accepts++
		recorder.mu.Unlock()
		ctx, cancel := context.WithTimeout(request.Context(), 10*time.Second)
		defer cancel()
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var initMessage struct {
			Type    string          `json:"type"`
			Payload json.RawMessage `json:"payload"`
		}
		if json.Unmarshal(data, &initMessage) != nil || initMessage.Type != "connection_init" {
			return
		}
		recorder.mu.Lock()
		recorder.initPayload = append(json.RawMessage{}, initMessage.Payload...)
		recorder.mu.Unlock()
		if closeBeforeAck {
			_ = conn.Close(websocket.StatusInternalError, "upstream failed")
			return
		}
		ack, _ := json.Marshal(map[string]any{"type": "connection_ack"})
		if err := conn.Write(ctx, websocket.MessageText, ack); err != nil {
			return
		}
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			var message struct {
				Type    string          `json:"type"`
				ID      string          `json:"id"`
				Payload json.RawMessage `json:"payload"`
			}
			if json.Unmarshal(data, &message) != nil {
				continue
			}
			switch message.Type {
			case "subscribe":
				recorder.recordOperation(message.Payload)
				next, _ := json.Marshal(map[string]any{
					"type":    "next",
					"id":      message.ID,
					"payload": map[string]any{"data": map[string]any{"me": map[string]any{"id": "legacy-user"}}},
				})
				_ = conn.Write(ctx, websocket.MessageText, next)
			case "complete":
				recorder.mu.Lock()
				recorder.completes++
				recorder.mu.Unlock()
			}
		}
	}))
	t.Cleanup(server.Close)
	return server
}

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

func TestMixedLocalAndLegacyOperations(t *testing.T) {
	recorder := &legacyRecorder{}
	upstream := newLegacyRecorderServer(t, recorder, false)
	source := newFakeSource()
	auth := &fakeAuth{identities: map[string]*authhttp.Identity{"token": alertIdentity("alerts.read")}}
	runtime := newTestRuntime(t, source, auth, &fakeLimiter{allowed: true}, upstream.URL, 2*time.Second)
	server := httptest.NewServer(runtime)
	t.Cleanup(server.Close)

	conn := dialTestConnection(t, server.URL)
	initConnection(t, conn, "token")
	sendClientMessage(t, conn, map[string]any{
		"type": "subscribe", "id": "local",
		"payload": map[string]any{"query": `subscription { alertEvents { id } }`},
	})
	sendClientMessage(t, conn, map[string]any{
		"type": "subscribe", "id": "legacy",
		"payload": map[string]any{"query": `query Me { me { id } }`, "operationName": "Me"},
	})
	source.waitForSubscribers(t, "alertEvents", "org-a", 1)
	waitFor(t, "legacy subscribe", func() bool {
		_, operations, _ := recorder.counts()
		return operations == 1
	})

	source.push("alertEvents", "org-a", FeedEvent{Value: alerts.AlertEventModel{
		ID: "event-1", TriggeredAt: time.Now(), Severity: "high", Status: "pending",
	}})
	received := map[string]serverMessage{}
	for len(received) < 2 {
		message := readServerMessage(t, conn)
		if _, exists := received[message.ID]; !exists {
			received[message.ID] = message
		}
	}
	if _, ok := received["local"]; !ok {
		t.Fatalf("missing local next: %+v", received)
	}
	if _, ok := received["legacy"]; !ok {
		t.Fatalf("missing legacy next: %+v", received)
	}
	localPayload := decodeNextPayload(t, received["local"])
	if localPayload["data"].(map[string]any)["alertEvents"].(map[string]any)["id"] != "event-1" {
		t.Fatalf("local payload = %v", localPayload)
	}
	legacyPayload := decodeNextPayload(t, received["legacy"])
	if legacyPayload["data"].(map[string]any)["me"].(map[string]any)["id"] != "legacy-user" {
		t.Fatalf("legacy payload = %v", legacyPayload)
	}

	accepts, operations, _ := recorder.counts()
	if accepts != 1 {
		t.Fatalf("legacy upstream connections = %d, want exactly one lazy connection", accepts)
	}
	if operations != 1 {
		t.Fatalf("legacy operations = %d, want one (local operations must not be forwarded)", operations)
	}
	var forwarded struct {
		Query string `json:"query"`
	}
	if err := json.Unmarshal(recorder.operations[0], &forwarded); err != nil {
		t.Fatalf("forwarded payload: %v", err)
	}
	if forwarded.Query != `query Me { me { id } }` {
		t.Fatalf("forwarded query = %q", forwarded.Query)
	}
	var initPayload map[string]any
	if err := json.Unmarshal(recorder.init(), &initPayload); err != nil {
		t.Fatalf("forwarded init payload: %v", err)
	}
	if initPayload["authorization"] != "Bearer token" {
		t.Fatalf("forwarded authorization = %v", initPayload["authorization"])
	}

	sendClientMessage(t, conn, map[string]any{"type": "complete", "id": "legacy"})
	waitFor(t, "upstream complete", func() bool {
		_, _, completes := recorder.counts()
		return completes == 1
	})

	// The local subscription is unaffected by the forwarded operation ending.
	source.push("alertEvents", "org-a", FeedEvent{Value: alerts.AlertEventModel{
		ID: "event-2", TriggeredAt: time.Now(), Severity: "high", Status: "pending",
	}})
	second := decodeNextPayload(t, readServerMessage(t, conn))
	if second["data"].(map[string]any)["alertEvents"].(map[string]any)["id"] != "event-2" {
		t.Fatalf("local subscription after legacy complete = %v", second)
	}
}

func TestLegacyUpstreamFailureEndsOnlyItsOperation(t *testing.T) {
	recorder := &legacyRecorder{}
	upstream := newLegacyRecorderServer(t, recorder, true)
	source := newFakeSource()
	auth := &fakeAuth{identities: map[string]*authhttp.Identity{"token": alertIdentity("alerts.read")}}
	runtime := newTestRuntime(t, source, auth, &fakeLimiter{allowed: true}, upstream.URL, 2*time.Second)
	server := httptest.NewServer(runtime)
	t.Cleanup(server.Close)

	conn := dialTestConnection(t, server.URL)
	initConnection(t, conn, "token")
	sendClientMessage(t, conn, map[string]any{
		"type": "subscribe", "id": "legacy",
		"payload": map[string]any{"query": `query Me { me { id } }`},
	})
	failure := readServerMessage(t, conn)
	if failure.Type != "error" || failure.ID != "legacy" {
		t.Fatalf("failure message = %+v, want error for legacy", failure)
	}
	if !strings.Contains(string(failure.Payload), "INTERNAL_SERVER_ERROR") {
		t.Fatalf("failure payload = %s", failure.Payload)
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
		t.Fatalf("local subscription after upstream failure = %v", next)
	}
	accepts, _, _ := recorder.counts()
	if accepts != 1 {
		t.Fatalf("legacy upstream connections = %d, want 1", accepts)
	}
}

func TestLocalOnlyConnectionNeverDialsLegacy(t *testing.T) {
	recorder := &legacyRecorder{}
	upstream := newLegacyRecorderServer(t, recorder, false)
	source := newFakeSource()
	auth := &fakeAuth{identities: map[string]*authhttp.Identity{"token": alertIdentity("alerts.read")}}
	runtime := newTestRuntime(t, source, auth, &fakeLimiter{allowed: true}, upstream.URL, 2*time.Second)
	server := httptest.NewServer(runtime)
	t.Cleanup(server.Close)

	conn := dialTestConnection(t, server.URL)
	initConnection(t, conn, "token")
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
		t.Fatalf("local payload = %v", next)
	}
	time.Sleep(100 * time.Millisecond)
	if accepts, _, _ := recorder.counts(); accepts != 0 {
		t.Fatalf("legacy upstream connections = %d, want 0 without a fallback operation", accepts)
	}
}
