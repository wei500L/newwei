//go:build integration

package realtimeintegration

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/realtimeevents"
	"github.com/wei500L/newwei/apps/api-go/internal/realtimesocket"
)

// situationAugmentCall records one RealtimeAugmenter invocation.
type situationAugmentCall struct {
	EventType string
	OrgID     string
	UserIDs   []string
}

// fakeSituationAugmenter is the injectable replacement for the
// situationsignals.RealtimeAugmenter. The real augmenter needs the situation
// monitor tables, Mongo and the embedding service; the bridge contract is only
// "call the augmenter once per org with that org's online user ids and deliver
// the per-user payloads", which this fake verifies deterministically.
type fakeSituationAugmenter struct {
	mu    sync.Mutex
	calls []situationAugmentCall
}

func (f *fakeSituationAugmenter) AugmentRealtime(_ context.Context, eventType, orgID string, userIDs []string, payloadJSON json.RawMessage) (map[string]json.RawMessage, error) {
	f.mu.Lock()
	recordedUserIDs := append([]string(nil), userIDs...)
	f.calls = append(f.calls, situationAugmentCall{EventType: eventType, OrgID: orgID, UserIDs: recordedUserIDs})
	f.mu.Unlock()

	augmented := make(map[string]json.RawMessage, len(userIDs))
	for _, userID := range userIDs {
		// Append monitorMatches to the raw payload, keeping the base fields as
		// the bridge delivered them (NestJS augments by spreading the payload
		// and adding the matches at the end).
		trimmed := strings.TrimSpace(string(payloadJSON))
		trimmed = strings.TrimSuffix(trimmed, "}")
		trimmed += `,"monitorMatches":[{"org":` + strconv.Quote(orgID) + `}]}`
		augmented[userID] = json.RawMessage(trimmed)
	}
	return augmented, nil
}

func (f *fakeSituationAugmenter) recordedCalls() []situationAugmentCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]situationAugmentCall, len(f.calls))
	copy(out, f.calls)
	return out
}

// situationBridgeMessage is the JSON envelope published by the NestJS
// signals dispatcher on situation-monitor:signals:events:v1.
type situationBridgeMessage struct {
	Version   int             `json:"version"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	Timestamp string          `json:"timestamp"`
}

// situationTelegramPayload is the raw (not yet per-user augmented) telegram
// payload the dispatcher publishes.
type situationTelegramPayload struct {
	Count     int               `json:"count"`
	UpdatedAt string            `json:"updatedAt"`
	Items     []json.RawMessage `json:"items"`
}

// situationTelegramUpdate is the augmented client payload inspected by the
// test; only the fields the bridge/augmenter contract touches are decoded.
type situationTelegramUpdate struct {
	Count          int               `json:"count"`
	UpdatedAt      string            `json:"updatedAt"`
	Items          []json.RawMessage `json:"items"`
	MonitorMatches []struct {
		Org string `json:"org"`
	} `json:"monitorMatches"`
}

// TestRealtimeSituationBridgeIntegration publishes the contract message on the
// situation-monitor bridge channel and verifies the per-user delivery:
//   - the bridge discovers the online users from the transport's local room
//     index and calls the augmenter once per org;
//   - each user receives the augmented payload (monitorMatches) for its own
//     org, so two orgs never observe each other's matches;
//   - without an augmenter the bridge falls back to the raw payload (no
//     monitorMatches key) instead of dropping the event.
func TestRealtimeSituationBridgeIntegration(t *testing.T) {
	t.Run("augmented_per_org", func(t *testing.T) {
		h := newHarness(t)
		h.seedMember(t, "org-situation-a", "user-situation-a", "items.read")
		h.seedMember(t, "org-situation-b", "user-situation-b", "items.read")
		runtime := h.newRealtimeRuntime(t, h.realtimeOptions())
		server := serveRealtime(t, runtime)
		augmenter := &fakeSituationAugmenter{}
		h.newRealtimeSources(t, realtimeevents.Options{Situation: augmenter}, runtime)

		clientA := dialSocketClient(t, server.URL, realtimesocket.Path)
		_ = clientA.connectNamespace(t, realtimesocket.NamespaceSituationMonitor,
			map[string]any{"token": h.accessToken(t, "user-situation-a", "org-situation-a")})
		clientA.waitEvent(t, realtimesocket.NamespaceSituationMonitor, "situation:connected", defaultFrameTimeout)

		clientB := dialSocketClient(t, server.URL, realtimesocket.Path)
		_ = clientB.connectNamespace(t, realtimesocket.NamespaceSituationMonitor,
			map[string]any{"token": h.accessToken(t, "user-situation-b", "org-situation-b")})
		clientB.waitEvent(t, realtimesocket.NamespaceSituationMonitor, "situation:connected", defaultFrameTimeout)

		payload := situationTelegramPayload{
			Count:     1,
			UpdatedAt: "2026-10-20T20:10:00.000Z",
			Items: []json.RawMessage{json.RawMessage(
				`{"id":"tg-1","text":"first signal","channelTitle":"channel","url":"https://t.me/channel/1","ts":"2026-10-20T20:09:00.000Z"}`)},
		}
		message, err := json.Marshal(situationBridgeMessage{
			Version:   1,
			Type:      "situation:telegram.update",
			Payload:   marshalJSON(t, payload),
			Timestamp: "2026-10-20T20:10:01.000Z",
		})
		if err != nil {
			t.Fatalf("marshal bridge message: %v", err)
		}
		if err := h.redis.Publish(h.ctx, "situation-monitor:signals:events:v1", string(message)).Err(); err != nil {
			t.Fatalf("publish situation bridge message: %v", err)
		}

		eventA := clientA.waitEvent(t, realtimesocket.NamespaceSituationMonitor, "situation:telegram.update", defaultFrameTimeout)
		updateA := decodePayload[situationTelegramUpdate](t, eventA)
		if updateA.Count != payload.Count || updateA.UpdatedAt != payload.UpdatedAt || len(updateA.Items) != 1 {
			t.Fatalf("org A situation:telegram.update = %+v, want the raw payload base fields", updateA)
		}
		if len(updateA.MonitorMatches) != 1 || updateA.MonitorMatches[0].Org != "org-situation-a" {
			t.Fatalf("org A monitorMatches = %+v, want exactly the org-situation-a match", updateA.MonitorMatches)
		}

		eventB := clientB.waitEvent(t, realtimesocket.NamespaceSituationMonitor, "situation:telegram.update", defaultFrameTimeout)
		updateB := decodePayload[situationTelegramUpdate](t, eventB)
		if len(updateB.MonitorMatches) != 1 || updateB.MonitorMatches[0].Org != "org-situation-b" {
			t.Fatalf("org B monitorMatches = %+v, want exactly the org-situation-b match (no cross-org bleed)", updateB.MonitorMatches)
		}

		calls := augmenter.recordedCalls()
		if len(calls) != 2 {
			t.Fatalf("augmenter called %d times, want once per online org", len(calls))
		}
		byOrg := map[string]situationAugmentCall{}
		for _, call := range calls {
			if call.EventType != "situation:telegram.update" {
				t.Fatalf("augmenter event type = %q, want situation:telegram.update", call.EventType)
			}
			byOrg[call.OrgID] = call
		}
		if got := byOrg["org-situation-a"].UserIDs; len(got) != 1 || got[0] != "user-situation-a" {
			t.Fatalf("augmenter user ids for org A = %v, want [user-situation-a]", got)
		}
		if got := byOrg["org-situation-b"].UserIDs; len(got) != 1 || got[0] != "user-situation-b" {
			t.Fatalf("augmenter user ids for org B = %v, want [user-situation-b]", got)
		}
	})

	t.Run("fallback_without_augmenter", func(t *testing.T) {
		h := newHarness(t)
		h.seedMember(t, "org-situation-fallback", "user-situation-fallback", "items.read")
		runtime := h.newRealtimeRuntime(t, h.realtimeOptions())
		server := serveRealtime(t, runtime)
		// Situation is nil: the bridge must fall back to the raw payload.
		h.newRealtimeSources(t, realtimeevents.Options{}, runtime)

		client := dialSocketClient(t, server.URL, realtimesocket.Path)
		_ = client.connectNamespace(t, realtimesocket.NamespaceSituationMonitor,
			map[string]any{"token": h.accessToken(t, "user-situation-fallback", "org-situation-fallback")})
		client.waitEvent(t, realtimesocket.NamespaceSituationMonitor, "situation:connected", defaultFrameTimeout)

		message, err := json.Marshal(situationBridgeMessage{
			Version:   1,
			Type:      "situation:telegram.update",
			Payload:   json.RawMessage(`{"count":1,"updatedAt":"2026-10-20T20:20:00.000Z","items":[]}`),
			Timestamp: "2026-10-20T20:20:01.000Z",
		})
		if err != nil {
			t.Fatalf("marshal bridge message: %v", err)
		}
		if err := h.redis.Publish(h.ctx, "situation-monitor:signals:events:v1", string(message)).Err(); err != nil {
			t.Fatalf("publish situation bridge message: %v", err)
		}

		event := client.waitEvent(t, realtimesocket.NamespaceSituationMonitor, "situation:telegram.update", defaultFrameTimeout)
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(event.payload(t), &payload); err != nil {
			t.Fatalf("decode fallback payload: %v", err)
		}
		if _, present := payload["monitorMatches"]; present {
			t.Fatalf("fallback payload unexpectedly contains monitorMatches: %s", event.payload(t))
		}
		if _, present := payload["count"]; !present {
			t.Fatalf("fallback payload lost the base fields: %s", event.payload(t))
		}
	})
}
