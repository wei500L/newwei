package realtimeevents

import (
	"context"
	"encoding/json"
	"testing"
)

type fakeAugmenter struct {
	result    map[string]json.RawMessage
	err       error
	calls     int
	lastType  string
	lastOrgID string
	lastUsers []string
}

func (a *fakeAugmenter) AugmentRealtime(_ context.Context, eventType, orgID string, userIDs []string, _ json.RawMessage) (map[string]json.RawMessage, error) {
	a.calls++
	a.lastType = eventType
	a.lastOrgID = orgID
	a.lastUsers = append([]string{}, userIDs...)
	if a.err != nil {
		return nil, a.err
	}
	return a.result, nil
}

func TestHandleSituationBridgeAugmentsPerLocalUser(t *testing.T) {
	sources := testSources()
	sink := newFakeSink()
	sink.localOrgs[NamespaceSituationMonitor] = []string{"org-1"}
	sink.localUser[NamespaceSituationMonitor] = map[string][]string{
		"org-1": {"u2", "u1", "u2"},
	}
	sources.sink = sink
	augmenter := &fakeAugmenter{result: map[string]json.RawMessage{
		"u2": json.RawMessage(`{"items":[],"monitorMatches":[{"monitorId":"m2"}]}`),
		"u1": json.RawMessage(`{"items":[],"monitorMatches":[]}`),
	}}
	sources.options.Situation = augmenter

	raw := json.RawMessage(`{"version":1,"type":"situation:telegram.update","payload":{"items":[]},"timestamp":"2026-10-20T12:00:00.000Z"}`)
	sources.handleSituationBridge(t.Context(), raw)

	if augmenter.calls != 1 || augmenter.lastOrgID != "org-1" || augmenter.lastType != situationTelegramUpdate {
		t.Fatalf("augmenter call = %#v", augmenter)
	}
	if len(augmenter.lastUsers) != 2 || augmenter.lastUsers[0] != "u2" || augmenter.lastUsers[1] != "u1" {
		t.Fatalf("augmenter users = %#v", augmenter.lastUsers)
	}
	calls := sink.userCalls()
	if len(calls) != 2 {
		t.Fatalf("PublishUser calls = %d", len(calls))
	}
	if calls[0].event != situationTelegramUpdate || calls[0].payload != `{"items":[],"monitorMatches":[{"monitorId":"m2"}]}` {
		t.Fatalf("first call = %#v", calls[0])
	}
	if calls[1].payload != `{"items":[],"monitorMatches":[]}` {
		t.Fatalf("second call = %#v", calls[1])
	}
	if calls[0].rooms[0] != "org:org-1" || calls[0].rooms[1] != "user:u2" {
		t.Fatalf("rooms = %#v", calls[0].rooms)
	}
}

func TestHandleSituationBridgeFallsBackToRawPayload(t *testing.T) {
	raw := json.RawMessage(`{"version":1,"type":"situation:oref.update","payload":{"alerts":[],"historyEntry":null},"timestamp":"2026-10-20T12:00:00.000Z"}`)

	for name, augmenter := range map[string]SituationAugmenter{
		"nil":   nil,
		"error": &fakeAugmenter{err: context.DeadlineExceeded},
	} {
		t.Run(name, func(t *testing.T) {
			sources := testSources()
			sink := newFakeSink()
			sink.localOrgs[NamespaceSituationMonitor] = []string{"org-1"}
			sink.localUser[NamespaceSituationMonitor] = map[string][]string{"org-1": {"u1"}}
			sources.sink = sink
			sources.options.Situation = augmenter
			sources.handleSituationBridge(t.Context(), raw)
			calls := sink.userCalls()
			if len(calls) != 1 {
				t.Fatalf("PublishUser calls = %d", len(calls))
			}
			if calls[0].payload != string(raw) {
				t.Fatalf("payload = %s, want the raw payload", calls[0].payload)
			}
			if calls[0].event != situationOrefUpdate {
				t.Fatalf("event = %q", calls[0].event)
			}
		})
	}
}

func TestHandleSituationBridgeRejectsMalformedMessages(t *testing.T) {
	invalid := []string{
		`{}`,
		`{"version":2,"type":"situation:telegram.update","payload":{},"timestamp":"t"}`,
		`{"version":1,"type":"situation:unknown","payload":{},"timestamp":"t"}`,
		`{"version":1,"type":"situation:telegram.update","payload":[],"timestamp":"t"}`,
		`{"version":1,"type":"situation:telegram.update","payload":{},"timestamp":" "}`,
	}
	for _, raw := range invalid {
		if _, ok := parseSituationBridge([]byte(raw)); ok {
			t.Fatalf("invalid bridge message accepted: %s", raw)
		}
	}
	valid := `{"version":1,"type":"situation:oref.update","payload":{"alerts":[],"historyEntry":null},"timestamp":"2026-10-20T12:00:00.000Z"}`
	if _, ok := parseSituationBridge([]byte(valid)); !ok {
		t.Fatal("valid bridge message rejected")
	}
}

func TestNormalizeUserIDs(t *testing.T) {
	got := normalizeUserIDs([]string{" u2 ", "", "u1", "u2", "  "})
	if len(got) != 2 || got[0] != "u2" || got[1] != "u1" {
		t.Fatalf("normalizeUserIDs = %#v", got)
	}
}
