package situationsignals

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func realtimeTestService(monitorsByUser map[string][]monitorRecord) *Service {
	return &Service{
		loadMonitors: func(_ context.Context, _, userID string) ([]monitorRecord, error) {
			return monitorsByUser[userID], nil
		},
	}
}

func keywordMonitor() monitorRecord {
	return monitorRecord{
		ID:          "m1",
		Kind:        "keyword",
		Name:        "Rocket",
		RawKeywords: []string{"rocket"},
	}
}

func TestAugmentTelegramRealtimeAppendsMatchesAndPreservesKeyOrder(t *testing.T) {
	service := realtimeTestService(map[string][]monitorRecord{"u1": {keywordMonitor()}})
	augmenter := &RealtimeAugmenter{service: service}
	payload := json.RawMessage(`{"count":1,"updatedAt":"2026-10-20T12:00:00.000Z","items":[{"id":"t1","channelTitle":"chan","url":"https://x","ts":"2026-10-20T00:00:00.000Z","text":"rocket launch","topic":"news","tags":[]}]}`)

	result, err := augmenter.AugmentRealtime(context.Background(), RealtimeTelegramUpdate, "org1", []string{"u1", "u2", "u1"}, payload)
	if err != nil {
		t.Fatalf("AugmentRealtime() error = %v", err)
	}
	if len(result) != 2 {
		t.Fatalf("result users = %d", len(result))
	}
	augmentedUser1 := string(result["u1"])
	originalPrefix := string(payload[:len(payload)-1])
	if !strings.HasPrefix(augmentedUser1, originalPrefix) {
		t.Fatalf("payload prefix was re-encoded: %s", augmentedUser1)
	}
	matchesIndex := strings.Index(augmentedUser1, `"monitorMatches"`)
	updatedIndex := strings.Index(augmentedUser1, `"updatedAt"`)
	if matchesIndex < 0 || updatedIndex < 0 || matchesIndex < updatedIndex {
		t.Fatalf("monitorMatches must be the last key: %s", augmentedUser1)
	}
	var decoded struct {
		MonitorMatches []struct {
			MonitorID string `json:"monitorId"`
			ItemType  string `json:"itemType"`
		} `json:"monitorMatches"`
	}
	if err := json.Unmarshal(result["u1"], &decoded); err != nil {
		t.Fatalf("decode augmented payload: %v", err)
	}
	if len(decoded.MonitorMatches) != 1 || decoded.MonitorMatches[0].MonitorID != "m1" {
		t.Fatalf("monitorMatches = %#v", decoded.MonitorMatches)
	}
	if got := string(result["u2"]); !strings.HasSuffix(got, `"monitorMatches":[]}`) {
		t.Fatalf("user without monitors = %s", got)
	}
}

func TestAugmentTelegramRealtimeEmptyUsers(t *testing.T) {
	augmenter := &RealtimeAugmenter{service: realtimeTestService(nil)}
	result, err := augmenter.AugmentRealtime(context.Background(), RealtimeTelegramUpdate, "org1", nil, json.RawMessage(`{"items":[]}`))
	if err != nil {
		t.Fatalf("AugmentRealtime() error = %v", err)
	}
	if len(result) != 0 {
		t.Fatalf("result = %#v", result)
	}
}

func TestAugmentOrefRealtimeHistoryKeys(t *testing.T) {
	service := realtimeTestService(map[string][]monitorRecord{"u1": {keywordMonitor()}})
	augmenter := &RealtimeAugmenter{service: service}
	alert := `{"id":"a1","title":"Red alert","desc":"rocket impact","cat":"","alertDate":"2026-10-20 10:00:00","data":["Area"]}`

	nullHistory := json.RawMessage(`{"alerts":[` + alert + `],"historyCount24h":0,"totalHistoryCount":0,"updatedAt":"2026-10-20T12:00:00.000Z","historyEntry":null}`)
	result, err := augmenter.AugmentRealtime(context.Background(), RealtimeOrefUpdate, "org1", []string{"u1"}, nullHistory)
	if err != nil {
		t.Fatalf("AugmentRealtime() error = %v", err)
	}
	augmented := string(result["u1"])
	if !strings.Contains(augmented, `"alertMonitorMatches":[`) {
		t.Fatalf("alertMonitorMatches missing: %s", augmented)
	}
	if strings.Contains(augmented, "historyMonitorMatches") {
		t.Fatalf("historyMonitorMatches must be absent for a null historyEntry: %s", augmented)
	}
	if !strings.HasPrefix(augmented, string(nullHistory)[:len(nullHistory)-1]) {
		t.Fatalf("original payload bytes were not preserved: %s", augmented)
	}

	withHistory := json.RawMessage(`{"alerts":[` + alert + `],"historyCount24h":1,"totalHistoryCount":1,"updatedAt":"2026-10-20T12:00:00.000Z","historyEntry":{"alerts":[` + alert + `],"timestamp":"2026-10-20 11:00:00"}}`)
	result, err = augmenter.AugmentRealtime(context.Background(), RealtimeOrefUpdate, "org1", []string{"u1"}, withHistory)
	if err != nil {
		t.Fatalf("AugmentRealtime(history) error = %v", err)
	}
	augmented = string(result["u1"])
	alertIndex := strings.Index(augmented, `"alertMonitorMatches"`)
	historyIndex := strings.Index(augmented, `"historyMonitorMatches"`)
	if alertIndex < 0 || historyIndex < 0 || historyIndex < alertIndex {
		t.Fatalf("historyMonitorMatches must follow alertMonitorMatches: %s", augmented)
	}
}

func TestAugmentRealtimeRejectsUnknownEventType(t *testing.T) {
	augmenter := &RealtimeAugmenter{service: realtimeTestService(nil)}
	if _, err := augmenter.AugmentRealtime(context.Background(), "situation:unknown", "org1", []string{"u1"}, json.RawMessage(`{}`)); err == nil {
		t.Fatal("unknown event type must be rejected")
	}
}

func TestMatchCandidatesForRealtimeUsersErrorPropagates(t *testing.T) {
	service := &Service{
		loadMonitors: func(context.Context, string, string) ([]monitorRecord, error) {
			return nil, errors.New("mysql down")
		},
	}
	augmenter := &RealtimeAugmenter{service: service}
	_, err := augmenter.AugmentRealtime(context.Background(), RealtimeTelegramUpdate, "org1", []string{"u1"}, json.RawMessage(`{"items":[]}`))
	if err == nil {
		t.Fatal("monitor load error must propagate so the caller falls back")
	}
}

func TestAppendJSONObjectField(t *testing.T) {
	cases := []struct {
		name    string
		payload string
		key     string
		value   string
		want    string
	}{
		{name: "non-empty object", payload: `{"a":1,"b":"x"}`, key: "c", value: `[]`, want: `{"a":1,"b":"x","c":[]}`},
		{name: "empty object", payload: `{}`, key: "c", value: `[1]`, want: `{"c":[1]}`},
		{name: "whitespace", payload: " {\"a\":1} \n", key: "c", value: "null", want: `{"a":1,"c":null}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := appendJSONObjectField(json.RawMessage(testCase.payload), testCase.key, json.RawMessage(testCase.value))
			if err != nil {
				t.Fatalf("appendJSONObjectField() error = %v", err)
			}
			if string(got) != testCase.want {
				t.Fatalf("got %s, want %s", got, testCase.want)
			}
			if !bytes.HasPrefix(got, []byte("{")) || !bytes.HasSuffix(got, []byte("}")) {
				t.Fatalf("not an object: %s", got)
			}
		})
	}
	if _, err := appendJSONObjectField(json.RawMessage(`[1]`), "a", json.RawMessage(`1`)); err == nil {
		t.Fatal("non-object payload must be rejected")
	}
}

func TestMatchResultKeyOrderUsedByAugmentation(t *testing.T) {
	// The match result JSON field order is part of the browser contract; it must
	// stay the NestJS order even when the object is embedded in a payload.
	service := realtimeTestService(map[string][]monitorRecord{"u1": {keywordMonitor()}})
	augmenter := &RealtimeAugmenter{service: service}
	payload := json.RawMessage(`{"items":[{"id":"t1","channelTitle":"chan","url":"https://x","ts":"2026-10-20T00:00:00.000Z","text":"rocket launch","tags":[]}]}`)
	result, err := augmenter.AugmentRealtime(context.Background(), RealtimeTelegramUpdate, "org1", []string{"u1"}, payload)
	if err != nil {
		t.Fatalf("AugmentRealtime() error = %v", err)
	}
	augmented := string(result["u1"])
	fields := []string{`"itemKey"`, `"itemType"`, `"monitorId"`, `"monitorKind"`, `"monitorName"`, `"score"`, `"geoStatus"`, `"matchedTerms"`, `"reasons"`, `"link"`, `"title"`, `"source"`, `"timestamp"`}
	previous := -1
	for _, field := range fields {
		index := strings.Index(augmented, field)
		if index <= previous {
			t.Fatalf("field %s out of order in %s", field, augmented)
		}
		previous = index
	}
}
