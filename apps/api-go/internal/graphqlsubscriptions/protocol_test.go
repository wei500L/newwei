package graphqlsubscriptions

import (
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/alerts"
)

func alertIdentity(permissions ...string) *authhttp.Identity {
	return authhttp.NewIdentity("user-a", "org-a", permissions)
}

func TestHandshakeProjectionAndCancel(t *testing.T) {
	source := newFakeSource()
	order := []string{}
	auth := &fakeAuth{
		identities: map[string]*authhttp.Identity{"token": alertIdentity("alerts.read")},
		order:      &order,
	}
	limiter := &fakeLimiter{allowed: true, order: &order}
	runtime := newTestRuntime(t, source, auth, limiter, "", 2*time.Second)
	server := httptest.NewServer(runtime)
	t.Cleanup(server.Close)

	conn := dialTestConnection(t, server.URL)
	initConnection(t, conn, "token")
	sendClientMessage(t, conn, map[string]any{
		"type": "subscribe",
		"id":   "1",
		"payload": map[string]any{
			"query": `subscription Alert($show: Boolean!) {
				a: alertEvents { ...EventFields severity @include(if: $show) deliveries { id } }
			} fragment EventFields on AlertEventModel { id triggeredAt }`,
			"variables": map[string]any{"show": true},
		},
	})
	source.waitForSubscribers(t, "alertEvents", "org-a", 1)
	if !reflect.DeepEqual(order, []string{"limit", "identify"}) {
		t.Fatalf("prepare order = %v, want limit then identify", order)
	}

	triggeredAt := time.Date(2026, 10, 19, 20, 1, 2, 345_000_000, time.FixedZone("MSK", 3*60*60))
	source.push("alertEvents", "org-a", FeedEvent{Value: alerts.AlertEventModel{
		ID:          "event-1",
		TriggeredAt: triggeredAt,
		MetricValue: 12.5,
		Severity:    "high",
		Status:      "pending",
		Deliveries:  []alerts.AlertDeliveryModel{},
	}})
	message := readServerMessage(t, conn)
	if message.ID != "1" {
		t.Fatalf("next id = %q, want 1", message.ID)
	}
	payload := decodeNextPayload(t, message)
	if _, hasErrors := payload["errors"]; hasErrors {
		t.Fatalf("unexpected errors: %v", payload["errors"])
	}
	data, _ := payload["data"].(map[string]any)
	event, _ := data["a"].(map[string]any)
	if event["id"] != "event-1" || event["severity"] != "high" {
		t.Fatalf("projected event = %v", event)
	}
	if event["triggeredAt"] != "2026-10-19T17:01:02.345Z" {
		t.Fatalf("triggeredAt = %v, want UTC milliseconds", event["triggeredAt"])
	}
	deliveries, ok := event["deliveries"].([]any)
	if !ok || len(deliveries) != 0 {
		t.Fatalf("deliveries = %v, want []", event["deliveries"])
	}

	sendClientMessage(t, conn, map[string]any{"type": "complete", "id": "1"})
	source.waitForSubscribers(t, "alertEvents", "org-a", 0)
}

func TestFourSubscriptionPermissions(t *testing.T) {
	cases := []struct {
		root       string
		query      string
		permission string
		denied     string
	}{
		{"alertEvents", `subscription { alertEvents { id } }`, "alerts.read", "analysis.read"},
		{"analysisEvents", `subscription { analysisEvents { id } }`, "analysis.read", "assistant.read"},
		{"assistantEvents", `subscription { assistantEvents { id } }`, "assistant.read", "analysis.read"},
		{"queueEvents", `subscription { queueEvents { event jobId data timestamp } }`, "queue.manage", "alerts.read"},
	}
	for _, test := range cases {
		test := test
		t.Run(test.root+" allowed", func(t *testing.T) {
			source := newFakeSource()
			auth := &fakeAuth{identities: map[string]*authhttp.Identity{"token": alertIdentity(test.permission)}}
			runtime := newTestRuntime(t, source, auth, &fakeLimiter{allowed: true}, "", 2*time.Second)
			server := httptest.NewServer(runtime)
			t.Cleanup(server.Close)
			conn := dialTestConnection(t, server.URL)
			initConnection(t, conn, "token")
			sendClientMessage(t, conn, map[string]any{
				"type": "subscribe", "id": "1",
				"payload": map[string]any{"query": test.query},
			})
			source.waitForSubscribers(t, test.root, "org-a", 1)
			sendClientMessage(t, conn, map[string]any{"type": "complete", "id": "1"})
			source.waitForSubscribers(t, test.root, "org-a", 0)
		})
		t.Run(test.root+" denied", func(t *testing.T) {
			source := newFakeSource()
			auth := &fakeAuth{identities: map[string]*authhttp.Identity{"token": alertIdentity(test.denied)}}
			runtime := newTestRuntime(t, source, auth, &fakeLimiter{allowed: true}, "", 2*time.Second)
			server := httptest.NewServer(runtime)
			t.Cleanup(server.Close)
			conn := dialTestConnection(t, server.URL)
			initConnection(t, conn, "token")
			sendClientMessage(t, conn, map[string]any{
				"type": "subscribe", "id": "1",
				"payload": map[string]any{"query": test.query},
			})
			message := readServerMessage(t, conn)
			payload := decodeNextPayload(t, message)
			rawErrors, _ := payload["errors"].([]any)
			if len(rawErrors) != 1 {
				t.Fatalf("errors = %v, want one permission error", payload["errors"])
			}
			first, _ := rawErrors[0].(map[string]any)
			if first["message"] != "Insufficient permissions" {
				t.Fatalf("message = %v", first["message"])
			}
			extensions, _ := first["extensions"].(map[string]any)
			if extensions["code"] != "FORBIDDEN" || extensions["appCode"] != "INSUFFICIENT_PERMISSIONS" {
				t.Fatalf("extensions = %v", extensions)
			}
			if extensions["permissionsMode"] != "any" {
				t.Fatalf("permissionsMode = %v", extensions["permissionsMode"])
			}
			required, _ := extensions["requiredPermissions"].([]any)
			if len(required) != 1 || required[0] != test.permission {
				t.Fatalf("requiredPermissions = %v, want [%s]", extensions["requiredPermissions"], test.permission)
			}
			complete := readServerMessage(t, conn)
			if complete.Type != "complete" {
				t.Fatalf("after guard error message = %q, want complete", complete.Type)
			}
			if source.subscriberCount(test.root, "org-a") != 0 {
				t.Fatal("denied operation must not open a source subscription")
			}
		})
	}
}

func TestOrganizationIsolation(t *testing.T) {
	source := newFakeSource()
	auth := &fakeAuth{identities: map[string]*authhttp.Identity{
		"a": authhttp.NewIdentity("user-a", "org-a", []string{"alerts.read"}),
		"b": authhttp.NewIdentity("user-b", "org-b", []string{"alerts.read"}),
	}}
	runtime := newTestRuntime(t, source, auth, &fakeLimiter{allowed: true}, "", 2*time.Second)
	server := httptest.NewServer(runtime)
	t.Cleanup(server.Close)

	connA := dialTestConnection(t, server.URL)
	initConnection(t, connA, "a")
	sendClientMessage(t, connA, map[string]any{
		"type": "subscribe", "id": "1",
		"payload": map[string]any{"query": `subscription { alertEvents { id } }`},
	})
	connB := dialTestConnection(t, server.URL)
	initConnection(t, connB, "b")
	sendClientMessage(t, connB, map[string]any{
		"type": "subscribe", "id": "1",
		"payload": map[string]any{"query": `subscription { alertEvents { id } }`},
	})
	source.waitForSubscribers(t, "alertEvents", "org-a", 1)
	source.waitForSubscribers(t, "alertEvents", "org-b", 1)

	event := func(id string) FeedEvent {
		return FeedEvent{Value: alerts.AlertEventModel{
			ID:          id,
			TriggeredAt: time.Now(),
			Severity:    "high",
			Status:      "pending",
		}}
	}
	source.push("alertEvents", "org-a", event("org-a-event"))
	source.push("alertEvents", "org-b", event("org-b-event"))

	payloadA := decodeNextPayload(t, readServerMessage(t, connA))
	payloadB := decodeNextPayload(t, readServerMessage(t, connB))
	if id := payloadA["data"].(map[string]any)["alertEvents"].(map[string]any)["id"]; id != "org-a-event" {
		t.Fatalf("connection A received %v", id)
	}
	if id := payloadB["data"].(map[string]any)["alertEvents"].(map[string]any)["id"]; id != "org-b-event" {
		t.Fatalf("connection B received %v", id)
	}
}

func TestCancelAndIdReuseIgnoreLateEvents(t *testing.T) {
	source := newFakeSource()
	auth := &fakeAuth{identities: map[string]*authhttp.Identity{"token": alertIdentity("alerts.read")}}
	runtime := newTestRuntime(t, source, auth, &fakeLimiter{allowed: true}, "", 2*time.Second)
	server := httptest.NewServer(runtime)
	t.Cleanup(server.Close)

	conn := dialTestConnection(t, server.URL)
	initConnection(t, conn, "token")
	subscribe := func(query string) {
		sendClientMessage(t, conn, map[string]any{
			"type": "subscribe", "id": "1",
			"payload": map[string]any{"query": query},
		})
	}
	event := func(id string) FeedEvent {
		return FeedEvent{Value: alerts.AlertEventModel{ID: id, TriggeredAt: time.Now(), Severity: "low", Status: "pending"}}
	}
	subscribe(`subscription { old: alertEvents { id } }`)
	source.waitForSubscribers(t, "alertEvents", "org-a", 1)
	source.push("alertEvents", "org-a", event("old-event"))
	first := decodeNextPayload(t, readServerMessage(t, conn))
	if first["data"].(map[string]any)["old"].(map[string]any)["id"] != "old-event" {
		t.Fatalf("first event = %v", first)
	}

	sendClientMessage(t, conn, map[string]any{"type": "complete", "id": "1"})
	source.waitForSubscribers(t, "alertEvents", "org-a", 0)
	subscribe(`subscription { fresh: alertEvents { id } }`)
	source.waitForSubscribers(t, "alertEvents", "org-a", 1)
	source.push("alertEvents", "org-a", event("fresh-event"))
	second := decodeNextPayload(t, readServerMessage(t, conn))
	data, _ := second["data"].(map[string]any)
	if data["fresh"].(map[string]any)["id"] != "fresh-event" {
		t.Fatalf("reused id received a late payload: %v", second)
	}
	if _, leaked := data["old"]; leaked {
		t.Fatalf("late event from the cancelled operation leaked: %v", second)
	}
}

func TestProtocolCloseCodes(t *testing.T) {
	newServer := func(t *testing.T, timeout time.Duration) (*fakeSource, *httptest.Server) {
		source := newFakeSource()
		auth := &fakeAuth{identities: map[string]*authhttp.Identity{"token": alertIdentity("alerts.read")}}
		runtime := newTestRuntime(t, source, auth, &fakeLimiter{allowed: true}, "", timeout)
		server := httptest.NewServer(runtime)
		t.Cleanup(server.Close)
		return source, server
	}

	t.Run("subscribe before init", func(t *testing.T) {
		_, server := newServer(t, 3*time.Second)
		conn := dialTestConnection(t, server.URL)
		sendClientMessage(t, conn, map[string]any{
			"type": "subscribe", "id": "1",
			"payload": map[string]any{"query": `subscription { alertEvents { id } }`},
		})
		if status := readCloseStatus(t, conn); status != closeUnauthorized {
			t.Fatalf("close status = %v, want %v", status, closeUnauthorized)
		}
	})

	t.Run("duplicate init", func(t *testing.T) {
		_, server := newServer(t, 3*time.Second)
		conn := dialTestConnection(t, server.URL)
		initConnection(t, conn, "token")
		sendClientMessage(t, conn, map[string]any{"type": "connection_init", "payload": map[string]any{}})
		if status := readCloseStatus(t, conn); status != closeTooManyInit {
			t.Fatalf("close status = %v, want %v", status, closeTooManyInit)
		}
	})

	t.Run("duplicate active id", func(t *testing.T) {
		_, server := newServer(t, 3*time.Second)
		conn := dialTestConnection(t, server.URL)
		initConnection(t, conn, "token")
		message := map[string]any{
			"type": "subscribe", "id": "1",
			"payload": map[string]any{"query": `subscription { alertEvents { id } }`},
		}
		sendClientMessage(t, conn, message)
		sendClientMessage(t, conn, message)
		if status := readCloseStatus(t, conn); status != closeDuplicateID {
			t.Fatalf("close status = %v, want %v", status, closeDuplicateID)
		}
	})

	t.Run("invalid message", func(t *testing.T) {
		_, server := newServer(t, 3*time.Second)
		conn := dialTestConnection(t, server.URL)
		initConnection(t, conn, "token")
		sendClientMessage(t, conn, map[string]any{"type": "not-a-protocol-message"})
		if status := readCloseStatus(t, conn); status != closeBadRequest {
			t.Fatalf("close status = %v, want %v", status, closeBadRequest)
		}
	})

	t.Run("init timeout", func(t *testing.T) {
		_, server := newServer(t, 100*time.Millisecond)
		conn := dialTestConnection(t, server.URL)
		if status := readCloseStatus(t, conn); status != closeInitTimeout {
			t.Fatalf("close status = %v, want %v", status, closeInitTimeout)
		}
	})
}

func TestPingPongAndUnauthorizedOperation(t *testing.T) {
	source := newFakeSource()
	order := []string{}
	auth := &fakeAuth{
		identities: map[string]*authhttp.Identity{"good": alertIdentity("alerts.read")},
		order:      &order,
	}
	limiter := &fakeLimiter{allowed: true, order: &order}
	runtime := newTestRuntime(t, source, auth, limiter, "", 2*time.Second)
	server := httptest.NewServer(runtime)
	t.Cleanup(server.Close)

	conn := dialTestConnection(t, server.URL)
	initConnection(t, conn, "bad")
	sendClientMessage(t, conn, map[string]any{"type": "ping", "payload": map[string]any{"n": 1}})
	pong := readServerMessage(t, conn)
	if pong.Type != "pong" {
		t.Fatalf("ping response = %q, want pong", pong.Type)
	}
	var pingPayload map[string]any
	if err := json.Unmarshal(pong.Payload, &pingPayload); err != nil || pingPayload["n"] != float64(1) {
		t.Fatalf("pong payload = %s", pong.Payload)
	}

	sendClientMessage(t, conn, map[string]any{
		"type": "subscribe", "id": "1",
		"payload": map[string]any{"query": `subscription { alertEvents { id } }`},
	})
	payload := decodeNextPayload(t, readServerMessage(t, conn))
	rawErrors, _ := payload["errors"].([]any)
	if len(rawErrors) != 1 {
		t.Fatalf("errors = %v", payload["errors"])
	}
	first, _ := rawErrors[0].(map[string]any)
	extensions, _ := first["extensions"].(map[string]any)
	if first["message"] != "Unauthorized" || extensions["code"] != "UNAUTHORIZED" {
		t.Fatalf("unauthorized error = %v", first)
	}
	if complete := readServerMessage(t, conn); complete.Type != "complete" {
		t.Fatalf("after unauthorized message = %q, want complete", complete.Type)
	}
	if !reflect.DeepEqual(order, []string{"limit", "identify"}) {
		t.Fatalf("order = %v, want limit then identify", order)
	}
}

func TestInvalidDocumentIsProtocolErrorAndConnectionSurvives(t *testing.T) {
	source := newFakeSource()
	auth := &fakeAuth{identities: map[string]*authhttp.Identity{"token": alertIdentity("alerts.read")}}
	runtime := newTestRuntime(t, source, auth, &fakeLimiter{allowed: true}, "", 2*time.Second)
	server := httptest.NewServer(runtime)
	t.Cleanup(server.Close)

	conn := dialTestConnection(t, server.URL)
	initConnection(t, conn, "token")
	sendClientMessage(t, conn, map[string]any{
		"type": "subscribe", "id": "bad",
		"payload": map[string]any{"query": `subscription {`},
	})
	message := readServerMessage(t, conn)
	if message.Type != "error" || message.ID != "bad" {
		t.Fatalf("invalid document message = %+v, want operation-level error", message)
	}
	var errors []map[string]any
	if err := json.Unmarshal(message.Payload, &errors); err != nil || len(errors) == 0 {
		t.Fatalf("protocol error payload = %s", message.Payload)
	}

	// The operation error must not close the connection or send complete.
	sendClientMessage(t, conn, map[string]any{"type": "ping"})
	if pong := readServerMessage(t, conn); pong.Type != "pong" {
		t.Fatalf("connection after invalid document = %q, want pong", pong.Type)
	}
	sendClientMessage(t, conn, map[string]any{
		"type": "subscribe", "id": "good",
		"payload": map[string]any{"query": `subscription { alertEvents { id } }`},
	})
	source.waitForSubscribers(t, "alertEvents", "org-a", 1)
	source.push("alertEvents", "org-a", FeedEvent{Value: alerts.AlertEventModel{
		ID: "event-1", TriggeredAt: time.Now(), Severity: "high", Status: "pending",
	}})
	next := decodeNextPayload(t, readServerMessage(t, conn))
	if next["data"].(map[string]any)["alertEvents"].(map[string]any)["id"] != "event-1" {
		t.Fatalf("valid subscription after invalid document = %v", next)
	}
}
