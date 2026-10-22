package situationsignals

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// envLookup adapts a map to the environment lookup the settings reader takes.
func envLookup(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}

func TestLoadStoredSettingsFromCacheEnvelope(t *testing.T) {
	store, ops := newMemoryCache()
	store.values[settingsCacheKey] = []byte(`{"exists":true,"value":{"telegramChannelSet":"lite","telegramEnabled":true}}`)
	reader := &settingsReader{cache: ops}

	settings, err := reader.loadStored(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if settings == nil {
		t.Fatal("settings must come from the cache envelope")
	}
	if value, ok := settings.TelegramChannelSet.Value(); !ok || value != "lite" {
		t.Fatalf("channelSet = %q/%v", value, ok)
	}

	// A cache entry that says the row does not exist returns null without
	// touching MySQL.
	store.values[settingsCacheKey] = []byte(`{"exists":false}`)
	settings, err = reader.loadStored(t.Context())
	if err != nil || settings != nil {
		t.Fatalf("settings = %v err = %v", settings, err)
	}

	// A truthy cache value whose `exists` is not truthy also returns null; this
	// matches `cached.exists ? cached.value : null` for an old envelope.
	store.values[settingsCacheKey] = []byte(`{}`)
	settings, err = reader.loadStored(t.Context())
	if err != nil || settings != nil {
		t.Fatalf("settings = %v err = %v", settings, err)
	}
}

func TestTelegramRuntimeConfigEnvFallback(t *testing.T) {
	_, ops := newMemoryCache()
	reader := &settingsReader{cache: ops, lookup: envLookup(map[string]string{
		"SITUATION_MONITOR_TELEGRAM_ENABLED":     "true",
		"SITUATION_MONITOR_TELEGRAM_API_ID":      "12345",
		"TELEGRAM_API_HASH":                      "hash",
		"SITUATION_MONITOR_TELEGRAM_CHANNEL_SET": "  ",
		"TELEGRAM_CHANNEL_SET":                   "lite",
	})}

	runtime, err := reader.telegramRuntimeConfig(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !runtime.Enabled || runtime.APIID != "12345" || runtime.APIHash != "hash" || runtime.ChannelSet != "lite" {
		t.Fatalf("runtime = %+v", runtime)
	}
	// The session has no environment fallback at all: NestJS resolves it from
	// the stored setting only.
	if runtime.Session != "" || runtime.configured() {
		t.Fatalf("runtime = %+v", runtime)
	}
}

func TestTelegramRuntimeConfigDefaultsChannelSet(t *testing.T) {
	_, ops := newMemoryCache()
	reader := &settingsReader{cache: ops, lookup: envLookup(map[string]string{})}
	runtime, err := reader.telegramRuntimeConfig(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if runtime.ChannelSet != defaultTelegramChannelSet {
		t.Fatalf("channelSet = %q", runtime.ChannelSet)
	}
	if runtime.Enabled {
		t.Fatal("telegram must default to disabled")
	}
}

// TestTelegramRuntimeConfigChannelSetEnvPrecedence pins the settings-service
// channelSet resolution: SITUATION_MONITOR_TELEGRAM_CHANNEL_SET has a "full"
// zod default, so an ABSENT canonical variable shadows the legacy
// TELEGRAM_CHANNEL_SET alias while an explicitly empty one falls through to it.
func TestTelegramRuntimeConfigChannelSetEnvPrecedence(t *testing.T) {
	cases := []struct {
		name   string
		env    map[string]string
		expect string
	}{
		{
			name:   "absent canonical shadows the alias",
			env:    map[string]string{"TELEGRAM_CHANNEL_SET": "lite"},
			expect: defaultTelegramChannelSet,
		},
		{
			name: "empty canonical falls through to the alias",
			env: map[string]string{
				"SITUATION_MONITOR_TELEGRAM_CHANNEL_SET": "  ",
				"TELEGRAM_CHANNEL_SET":                   "lite",
			},
			expect: "lite",
		},
		{
			name: "canonical wins",
			env: map[string]string{
				"SITUATION_MONITOR_TELEGRAM_CHANNEL_SET": "core",
				"TELEGRAM_CHANNEL_SET":                   "lite",
			},
			expect: "core",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, ops := newMemoryCache()
			reader := &settingsReader{cache: ops, lookup: envLookup(testCase.env)}
			runtime, err := reader.telegramRuntimeConfig(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			if runtime.ChannelSet != testCase.expect {
				t.Fatalf("channelSet = %q, want %q", runtime.ChannelSet, testCase.expect)
			}
		})
	}
}

func TestTelegramRuntimeConfigPrefersStoredValues(t *testing.T) {
	store, ops := newMemoryCache()
	store.values[settingsCacheKey] = []byte(`{
		"exists":true,
		"value":{
			"telegramEnabled":true,
			"telegramApiId":"stored-id",
			"telegramApiHash":"stored-hash",
			"telegramSession":"stored-session",
			"telegramChannelSet":"stored-set"
		}
	}`)
	reader := &settingsReader{cache: ops, lookup: envLookup(map[string]string{
		"SITUATION_MONITOR_TELEGRAM_API_ID": "env-id",
		"TELEGRAM_API_HASH":                 "env-hash",
	})}
	runtime, err := reader.telegramRuntimeConfig(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if runtime.APIID != "stored-id" || runtime.APIHash != "stored-hash" || runtime.Session != "stored-session" {
		t.Fatalf("runtime = %+v", runtime)
	}
	if runtime.ChannelSet != "stored-set" || !runtime.Enabled || !runtime.configured() {
		t.Fatalf("runtime = %+v", runtime)
	}
}

func TestLoadCachedTelegramStateNormalization(t *testing.T) {
	store, ops := newMemoryCache()
	store.values[telegramStateKey] = []byte(`{
		"channelSet":"  full  ",
		"cursorByHandle":{"  chan-a  ":5,"chan-b":"7","chan-c":0,"chan-d":-1,"chan-e":"abc","":"9","chan-f":null},
		"items":[{"id":"1"},{"id":"2"}],
		"lastPollAt":"1710000000000",
		"lastError":"boom"
	}`)
	service := &Service{cache: ops}
	state := service.loadCachedTelegramState(t.Context())

	if state.ChannelSet == nil || *state.ChannelSet != "full" {
		t.Fatalf("channelSet = %v", state.ChannelSet)
	}
	if len(state.Cursors) != 2 {
		t.Fatalf("cursors = %v", state.Cursors)
	}
	if state.Cursors["chan-a"] != 5 || state.Cursors["chan-b"] != 7 {
		t.Fatalf("cursors = %v", state.Cursors)
	}
	if len(state.Items) != 2 || state.LastPollAt != 1710000000000 {
		t.Fatalf("state = %+v", state)
	}
	if state.LastError == nil || *state.LastError != "boom" {
		t.Fatalf("lastError = %v", state.LastError)
	}
}

func TestLoadCachedTelegramStateInvalidShapes(t *testing.T) {
	cases := []struct {
		name  string
		value string
	}{
		{"missing key", ""},
		{"not an object", `[1,2]`},
		{"items missing", `{"channelSet":"full"}`},
		{"items not an array", `{"channelSet":"full","items":{}}`},
		{"items null", `{"channelSet":"full","items":null}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store, ops := newMemoryCache()
			if tc.value != "" {
				store.values[telegramStateKey] = []byte(tc.value)
			}
			service := &Service{cache: ops}
			state := service.loadCachedTelegramState(t.Context())
			if state.ChannelSet != nil || len(state.Items) != 0 || state.LastPollAt != 0 || state.LastError != nil {
				t.Fatalf("state = %+v", state)
			}
		})
	}
}

func TestSyncTelegramStateWithRuntimeBranches(t *testing.T) {
	item := rawJSON{raw: json.RawMessage(`{"id":"1"}`)}

	t.Run("same channel set is a no-op", func(t *testing.T) {
		store, ops := newMemoryCache()
		service := &Service{cache: ops}
		channelSet := "full"
		before := store.values[telegramStateKey]
		state := service.syncTelegramStateWithRuntime(t.Context(), telegramCachedState{
			ChannelSet: &channelSet,
			Cursors:    map[string]float64{},
			Items:      []rawJSON{item},
		}, "full")
		if state.ChannelSet == nil || *state.ChannelSet != "full" || len(state.Items) != 1 {
			t.Fatalf("state = %+v", state)
		}
		if string(store.values[telegramStateKey]) != string(before) {
			t.Fatal("a matching channel set must not rewrite the cache")
		}
	})

	t.Run("stale channel set with cached data clears and persists", func(t *testing.T) {
		store, ops := newMemoryCache()
		service := &Service{cache: ops}
		channelSet := "old"
		state := service.syncTelegramStateWithRuntime(t.Context(), telegramCachedState{
			ChannelSet: &channelSet,
			Cursors:    map[string]float64{"a": 1},
			Items:      []rawJSON{item},
			LastPollAt: 123,
			LastError:  strPtr("boom"),
		}, "full")
		if state.ChannelSet == nil || *state.ChannelSet != "full" {
			t.Fatalf("state = %+v", state)
		}
		if len(state.Items) != 0 || len(state.Cursors) != 0 || state.LastPollAt != 0 || state.LastError != nil {
			t.Fatalf("state = %+v", state)
		}
		persisted := string(store.values[telegramStateKey])
		for _, want := range []string{`"channelSet":"full"`, `"items":[]`, `"lastPollAt":0`, `"lastError":null`, `"cursorByHandle":{}`} {
			if !strings.Contains(persisted, want) {
				t.Fatalf("persisted %s missing %s", persisted, want)
			}
		}
		if store.ttls[telegramStateKey] != telegramStateTTL {
			t.Fatalf("ttl = %v", store.ttls[telegramStateKey])
		}
	})

	t.Run("stale channel set without cache data but a non-null set clears", func(t *testing.T) {
		store, ops := newMemoryCache()
		service := &Service{cache: ops}
		channelSet := "old"
		state := service.syncTelegramStateWithRuntime(t.Context(), telegramCachedState{
			ChannelSet: &channelSet,
			Cursors:    map[string]float64{},
			Items:      []rawJSON{},
		}, "full")
		if state.ChannelSet == nil || *state.ChannelSet != "full" {
			t.Fatalf("state = %+v", state)
		}
		if store.values[telegramStateKey] == nil {
			t.Fatal("the cleared state must be persisted")
		}
	})

	t.Run("null channel set without cached data is a no-op", func(t *testing.T) {
		store, ops := newMemoryCache()
		service := &Service{cache: ops}
		state := service.syncTelegramStateWithRuntime(t.Context(), telegramCachedState{
			Cursors: map[string]float64{},
			Items:   []rawJSON{},
		}, "full")
		if state.ChannelSet != nil {
			t.Fatalf("state = %+v", state)
		}
		if store.values[telegramStateKey] != nil {
			t.Fatal("a fresh process with no cached state must not write anything")
		}
	})
}

func TestFilterTelegramItems(t *testing.T) {
	items := []rawJSON{
		{raw: json.RawMessage(`{"id":"1","topic":"war","channel":"alpha","channelTitle":"Alpha","text":"first"}`)},
		{raw: json.RawMessage(`{"id":"2","topic":"econ","channel":"alpha","channelTitle":"Alpha","text":"second"}`)},
		{raw: json.RawMessage(`{"id":"3","topic":"war","channel":"beta","channelTitle":"Beta","text":"third"}`)},
	}
	if got := filterTelegramItems(items, "", "", 50); len(got) != 3 {
		t.Fatalf("no filter = %d", len(got))
	}
	if got := filterTelegramItems(items, "war", "", 50); len(got) != 2 {
		t.Fatalf("topic filter = %d", len(got))
	}
	if got := filterTelegramItems(items, "", "beta", 50); len(got) != 1 {
		t.Fatalf("channel filter = %d", len(got))
	}
	if got := filterTelegramItems(items, "war", "beta", 50); len(got) != 1 {
		t.Fatalf("combined filter = %d", len(got))
	}
	if got := filterTelegramItems(items, "", "", 2); len(got) != 2 {
		t.Fatalf("limit = %d", len(got))
	}
	if got := filterTelegramItems(items, "", "", 1); len(got) != 1 {
		t.Fatalf("limit one = %d", len(got))
	}
}

func TestGetTelegramFeedResponseShape(t *testing.T) {
	store, ops := newMemoryCache()
	store.values[settingsCacheKey] = []byte(`{"exists":true,"value":{"telegramEnabled":true,"telegramApiId":"1","telegramApiHash":"h","telegramSession":"s","telegramChannelSet":"full"}}`)
	store.values[telegramStateKey] = []byte(`{
		"channelSet":"full",
		"cursorByHandle":{},
		"items":[
			{"id":"1","source":"telegram","channel":"alpha","channelTitle":"Alpha","url":"https://t/1","ts":"2026-01-02T03:04:05.000Z","text":"Alpha text","topic":"war","tags":["a"],"earlySignal":true},
			{"id":"2","source":"telegram","channel":"alpha","channelTitle":"Alpha","url":"https://t/2","ts":"2026-01-02T04:04:05.000Z","text":"Beta text","topic":"econ","tags":[],"earlySignal":true}
		],
		"lastPollAt":1767323045000,
		"lastError":null
	}`)
	settings := &settingsReader{cache: ops, lookup: envLookup(map[string]string{})}
	service := &Service{cache: ops, settings: settings}
	service.loadMonitors = func(context.Context, string, string) ([]monitorRecord, error) {
		return []monitorRecord{}, nil
	}

	response, err := service.getTelegramFeed(t.Context(), "org-1", "user-1", 50, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if response.Source != "telegram" || response.Scope != "global" || !response.EarlySignal {
		t.Fatalf("response = %+v", response)
	}
	if !response.Configured || !response.Enabled || response.ChannelSet != "full" {
		t.Fatalf("response = %+v", response)
	}
	if response.Count != 2 || len(response.Items) != 2 {
		t.Fatalf("count = %d", response.Count)
	}
	if response.UpdatedAt == nil || *response.UpdatedAt != "2026-01-02T03:04:05.000Z" {
		t.Fatalf("updatedAt = %v", response.UpdatedAt)
	}
	if response.Error != "" {
		t.Fatalf("error = %q", response.Error)
	}
	if len(response.MonitorMatches) != 0 {
		t.Fatalf("matches = %v", response.MonitorMatches)
	}

	// The raw cached item is passed through unchanged.
	encoded, err := response.encodeJSON()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"earlySignal":true`) {
		t.Fatalf("encoded = %s", encoded)
	}

	// The lastError branch adds the key when a message is cached.
	store.values[telegramStateKey] = []byte(`{"channelSet":"full","cursorByHandle":{},"items":[],"lastPollAt":0,"lastError":"boom"}`)
	response, err = service.getTelegramFeed(t.Context(), "org-1", "user-1", 50, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if response.Error != "boom" || response.UpdatedAt != nil {
		t.Fatalf("response = %+v", response)
	}
	encoded, err = response.encodeJSON()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"error":"boom"`) {
		t.Fatalf("encoded = %s", encoded)
	}
}

func strPtr(value string) *string { return &value }

func TestCacheTTLConstants(t *testing.T) {
	if telegramStateTTL != 24*time.Hour {
		t.Fatalf("telegram ttl = %v", telegramStateTTL)
	}
	if refreshRunTTL != 15*time.Minute {
		t.Fatalf("refresh run ttl = %v", refreshRunTTL)
	}
	if insightsRevTTL != 90*24*time.Hour {
		t.Fatalf("insights ttl = %v", insightsRevTTL)
	}
}
