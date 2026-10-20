package situationsignalsworker

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/telegramclient"
)

// TestNewEnvFromLookupDefaults pins the env defaults of env.schema.ts and the
// readNumberEnv minimums.
func TestNewEnvFromLookupDefaults(t *testing.T) {
	env := NewEnvFromLookup(func(string) (string, bool) { return "", false })
	want := Env{
		TelegramEnabled:            false,
		TelegramChannelSet:         "full",
		TelegramMaxFeedItems:       200,
		TelegramMaxTextChars:       800,
		TelegramChannelTimeoutMS:   15_000,
		TelegramPollCycleTimeoutMS: 180_000,
		TelegramStartupDelayMS:     60_000,
		TelegramRateLimitMS:        800,
		TelegramPollIntervalMS:     60_000,
		OrefEnabled:                false,
		OrefAlertsURL:              "https://www.oref.org.il/WarningMessages/alert/alerts.json",
		OrefHistoryURL:             "https://www.oref.org.il/WarningMessages/alert/History/AlertsHistory.json",
		OrefHistoryRetention:       7,
		OrefHistoryMaxWaves:        200,
		OrefCurlTimeoutSeconds:     15,
		OrefBootstrapRetries:       3,
		OrefPollIntervalMS:         300_000,
	}
	if !reflect.DeepEqual(env, want) {
		t.Fatalf("NewEnvFromLookup() = %#v, want %#v", env, want)
	}
}

// TestNewEnvFromLookupParsing pins the JavaScript Number()/boolean coercion and
// the lower-bound clamps.
func TestNewEnvFromLookupParsing(t *testing.T) {
	values := map[string]string{
		"SITUATION_MONITOR_TELEGRAM_ENABLED":               " YES ",
		"TELEGRAM_API_ID":                                  " 42 ",
		"SITUATION_MONITOR_TELEGRAM_API_ID":                "7",
		"SITUATION_MONITOR_TELEGRAM_API_HASH":              "hash",
		"SITUATION_MONITOR_TELEGRAM_MAX_FEED_ITEMS":        "10",
		"SITUATION_MONITOR_TELEGRAM_MAX_TEXT_CHARS":        "1234.9",
		"SITUATION_MONITOR_TELEGRAM_CHANNEL_TIMEOUT_MS":    "bogus",
		"SITUATION_MONITOR_TELEGRAM_POLL_CYCLE_TIMEOUT_MS": "0x10",
		"SITUATION_MONITOR_OREF_ENABLED":                   "on",
		"SITUATION_MONITOR_OREF_PROXY_AUTH":                " user:pass@proxy:8080 ",
		"SITUATION_MONITOR_OREF_HISTORY_RETENTION_DAYS":    " 3 ",
		"SITUATION_MONITOR_OREF_CURL_TIMEOUT_SEC":          "abc",
	}
	lookup := func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
	env := NewEnvFromLookup(lookup)

	if !env.TelegramEnabled {
		t.Errorf("TelegramEnabled = false, want true")
	}
	if env.TelegramAPIID != "7" {
		t.Errorf("TelegramAPIID = %q, want canonical value to win", env.TelegramAPIID)
	}
	if env.TelegramMaxFeedItems != 50 {
		t.Errorf("TelegramMaxFeedItems = %d, want min clamp 50", env.TelegramMaxFeedItems)
	}
	if env.TelegramMaxTextChars != 1234 {
		t.Errorf("TelegramMaxTextChars = %d, want floored 1234", env.TelegramMaxTextChars)
	}
	if env.TelegramChannelTimeoutMS != 15_000 {
		t.Errorf("TelegramChannelTimeoutMS = %d, want fallback 15000", env.TelegramChannelTimeoutMS)
	}
	if env.TelegramPollCycleTimeoutMS != 30_000 {
		t.Errorf("TelegramPollCycleTimeoutMS = %d, want hex parse then min clamp 30000", env.TelegramPollCycleTimeoutMS)
	}
	if !env.OrefEnabled {
		t.Errorf("OrefEnabled = false, want true")
	}
	if env.OrefProxyAuth != "user:pass@proxy:8080" {
		t.Errorf("OrefProxyAuth = %q, want trimmed value", env.OrefProxyAuth)
	}
	if env.OrefHistoryRetention != 3 {
		t.Errorf("OrefHistoryRetention = %d, want 3", env.OrefHistoryRetention)
	}
	if env.OrefCurlTimeoutSeconds != 15 {
		t.Errorf("OrefCurlTimeoutSeconds = %d, want fallback 15", env.OrefCurlTimeoutSeconds)
	}
}

// TestEnvApplyDefaults makes a hand-built Env usable.
func TestEnvApplyDefaults(t *testing.T) {
	env := Env{}.applyDefaults()
	if env.TelegramChannelSet != "full" || env.OrefAlertsURL == "" || env.OrefHistoryMaxWaves != 200 {
		t.Fatalf("applyDefaults() = %#v", env)
	}
}

// TestJSSliceUTF16 covers String.prototype.slice(0, n) semantics, including
// cutting through a surrogate pair.
func TestJSSliceUTF16(t *testing.T) {
	tests := []struct {
		name  string
		value string
		limit int
		want  string
	}{
		{name: "ascii shorter", value: "abcd", limit: 10, want: "abcd"},
		{name: "ascii cut", value: "abcd", limit: 2, want: "ab"},
		{name: "emoji whole", value: "a\U0001F600b", limit: 3, want: "a\U0001F600"},
		{name: "emoji cut", value: "a\U0001F600b", limit: 2, want: "a\uFFFD"},
		{name: "zero", value: "abc", limit: 0, want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := jsSliceUTF16(tt.value, tt.limit); got != tt.want {
				t.Fatalf("jsSliceUTF16(%q, %d) = %q, want %q", tt.value, tt.limit, got, tt.want)
			}
		})
	}
}

// TestStripBOMOnlyRemovesFirst verifies the charCodeAt(0) === 0xFEFF check.
func TestStripBOMOnlyRemovesFirst(t *testing.T) {
	if got := stripBOM("\uFEFF\uFEFFx"); got != "\uFEFFx" {
		t.Fatalf("stripBOM() = %q, want one BOM removed", got)
	}
	if got := stripBOM("x"); got != "x" {
		t.Fatalf("stripBOM(no bom) = %q", got)
	}
}

// TestRedactOrefError covers the proxy credential redaction.
func TestRedactOrefError(t *testing.T) {
	got := redactOrefError("proxy error http://user:pass@proxy.example:9000 failed")
	want := "proxy error http://<redacted>@proxy.example:9000 failed"
	if got != want {
		t.Fatalf("redactOrefError() = %q, want %q", got, want)
	}
}

// TestNormalizeTelegramMessage pins every field.
func TestNormalizeTelegramMessage(t *testing.T) {
	channel := TelegramChannelConfig{Handle: "chan", Label: "Chan", Topic: "conflict", Region: "iran"}
	message := telegramclient.Message{ID: 17, DateUnix: 1_700_000_000, Text: "  hello \U0001F600  "}

	item := normalizeTelegramMessage(message, channel, "chan", 8)
	if item.ID != "chan:17" {
		t.Errorf("ID = %q", item.ID)
	}
	if item.URL != "https://t.me/chan/17" {
		t.Errorf("URL = %q", item.URL)
	}
	if item.TS != "2023-11-14T22:13:20.000Z" {
		t.Errorf("TS = %q", item.TS)
	}
	if item.Text != "  hello " {
		t.Errorf("Text = %q, want the raw text sliced to 8 UTF-16 units", item.Text)
	}
	if item.ChannelTitle != "Chan" || item.Topic != "conflict" {
		t.Errorf("title/topic = %q/%q", item.ChannelTitle, item.Topic)
	}
	if !reflect.DeepEqual(item.Tags, []string{"iran"}) {
		t.Errorf("Tags = %#v", item.Tags)
	}
	if !item.EarlySignal || item.Source != "telegram" {
		t.Errorf("source/earlySignal = %q/%t", item.Source, item.EarlySignal)
	}

	fallback := normalizeTelegramMessage(message, TelegramChannelConfig{Handle: "chan"}, "chan", 100)
	if fallback.ChannelTitle != "chan" || fallback.Topic != "other" || len(fallback.Tags) != 0 || fallback.Tags == nil {
		t.Errorf("fallback fields = %#v", fallback)
	}
}

// TestMergeTelegramItems covers ordered dedupe, stable ts-descending sort and
// the maxFeedItems cut.
func TestMergeTelegramItems(t *testing.T) {
	fresh := []TelegramItem{
		{ID: "b:2", TS: "2026-01-02T00:00:02.000Z"},
		{ID: "b:1", TS: "2026-01-02T00:00:01.000Z"},
	}
	cached := []TelegramItem{
		{ID: "b:2", TS: "2026-01-02T00:00:02.000Z"},
		{ID: "b:3", TS: "2026-01-02T00:00:03.000Z"},
		{ID: "b:1", TS: "2026-01-02T00:00:01.000Z"},
	}
	merged := mergeTelegramItems(fresh, cached, 10)
	ids := make([]string, 0, len(merged))
	for _, item := range merged {
		ids = append(ids, item.ID)
	}
	if want := []string{"b:3", "b:2", "b:1"}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("merged ids = %v, want %v", ids, want)
	}

	// Equal timestamps keep the fresh-before-cached insertion order.
	stable := mergeTelegramItems(
		[]TelegramItem{{ID: "x", TS: "2026-01-02T00:00:00.000Z"}, {ID: "y", TS: "2026-01-02T00:00:00.000Z"}},
		[]TelegramItem{{ID: "z", TS: "2026-01-02T00:00:00.000Z"}},
		10,
	)
	if stable[0].ID != "x" || stable[1].ID != "y" || stable[2].ID != "z" {
		t.Fatalf("stable order = %v", []string{stable[0].ID, stable[1].ID, stable[2].ID})
	}

	if got := len(mergeTelegramItems(fresh, cached, 2)); got != 2 {
		t.Fatalf("maxFeedItems cut = %d, want 2", got)
	}
}

// TestTelegramStateDocumentJSON pins the persisted state document byte shape.
func TestTelegramStateDocumentJSON(t *testing.T) {
	worker := newTestWorker(t, testWorkerOptions{env: testEnv()})
	channelSet := "full"
	state := telegramState{
		ChannelSet:     &channelSet,
		CursorByHandle: map[string]int64{"b": 2, "a": 1},
		Items: []TelegramItem{{
			ID: "h:1", Source: "telegram", Channel: "h", ChannelTitle: "H",
			URL: "https://t.me/h/1", TS: "2026-01-02T03:04:05.000Z", Text: "",
			Topic: "other", Tags: []string{}, EarlySignal: true,
		}},
		LastPollAt: 1_700_000_000_000,
		LastError:  "boom",
	}
	worker.service.persistTelegramState(context.Background(), state)
	raw, ok := worker.store.raw(telegramStateCacheKey)
	if !ok {
		t.Fatal("telegram state was not persisted")
	}
	want := `{"channelSet":"full","cursorByHandle":{"a":1,"b":2},"items":[{"id":"h:1","source":"telegram","channel":"h","channelTitle":"H","url":"https://t.me/h/1","ts":"2026-01-02T03:04:05.000Z","text":"","topic":"other","tags":[],"earlySignal":true}],"lastPollAt":1700000000000,"lastError":"boom"}`
	if raw != want {
		t.Fatalf("telegram state JSON = %s, want %s", raw, want)
	}

	// Empty state encodes items as [] and lastError as null.
	empty := emptyTelegramState()
	worker.service.persistTelegramState(context.Background(), empty)
	raw, _ = worker.store.raw(telegramStateCacheKey)
	wantEmpty := `{"channelSet":null,"cursorByHandle":{},"items":[],"lastPollAt":0,"lastError":null}`
	if raw != wantEmpty {
		t.Fatalf("empty telegram state JSON = %s, want %s", raw, wantEmpty)
	}
}

// TestTelegramStateRoundTrip loads the persisted document back into the state.
func TestTelegramStateRoundTrip(t *testing.T) {
	worker := newTestWorker(t, testWorkerOptions{env: testEnv()})
	worker.store.put(telegramStateCacheKey, `{"channelSet":" tech ","cursorByHandle":{" @a ":2,"b":0,"":5},"items":[{"id":"a:1","source":"telegram","channel":"a","channelTitle":"A","url":"https://t.me/a/1","ts":"2026-01-02T03:04:05.000Z","text":"x","topic":"other","tags":[],"earlySignal":true}],"lastPollAt":123,"lastError":"err"}`)

	state, err := worker.service.loadTelegramState(context.Background())
	if err != nil {
		t.Fatalf("loadTelegramState() error = %v", err)
	}
	if state.ChannelSet == nil || *state.ChannelSet != "tech" {
		t.Fatalf("ChannelSet = %v", state.ChannelSet)
	}
	if !reflect.DeepEqual(state.CursorByHandle, map[string]int64{"@a": 2}) {
		t.Fatalf("CursorByHandle = %#v", state.CursorByHandle)
	}
	if len(state.Items) != 1 || state.Items[0].ID != "a:1" {
		t.Fatalf("Items = %#v", state.Items)
	}
	if state.LastPollAt != 123 || state.LastError != "err" {
		t.Fatalf("lastPollAt/lastError = %d/%q", state.LastPollAt, state.LastError)
	}
}

// TestOrefDocumentsJSON pins the three OREF cache documents.
func TestOrefDocumentsJSON(t *testing.T) {
	worker := newTestWorker(t, testWorkerOptions{env: testEnv()})
	state := orefState{
		LastAlerts:        []json.RawMessage{json.RawMessage(`{"id":"a","cat":"c"}`)},
		HistoryCount24h:   2,
		TotalHistoryCount: 3,
		LastError:         "boom",
	}
	timestamp := "2026-01-02T03:04:05.000Z"
	worker.service.persistOrefAlerts(context.Background(), state, true, timestamp)
	raw, _ := worker.store.raw(orefAlertsCacheKey)
	wantAlerts := `{"scope":"global","configured":true,"alerts":[{"id":"a","cat":"c"}],"historyCount24h":2,"totalHistoryCount":3,"timestamp":"2026-01-02T03:04:05.000Z","error":"boom"}`
	if raw != wantAlerts {
		t.Fatalf("alerts JSON = %s, want %s", raw, wantAlerts)
	}

	state.History = []OrefHistoryEntry{{Alerts: []json.RawMessage{json.RawMessage(`{"id":"a"}`)}, Timestamp: timestamp}}
	worker.service.persistOrefHistory(context.Background(), state, true, timestamp, 200)
	raw, _ = worker.store.raw(orefHistoryCacheKey)
	wantHistory := `{"scope":"global","configured":true,"history":[{"alerts":[{"id":"a"}],"timestamp":"2026-01-02T03:04:05.000Z"}],"historyCount24h":2,"totalHistoryCount":3,"timestamp":"2026-01-02T03:04:05.000Z"}`
	if raw != wantHistory {
		t.Fatalf("history JSON = %s, want %s", raw, wantHistory)
	}

	worker.service.persistOrefMetrics(context.Background(), state, timestamp)
	raw, _ = worker.store.raw(orefMetricsCacheKey)
	wantMetrics := `{"activeAlerts":1,"historyCount24h":2,"updatedAt":"2026-01-02T03:04:05.000Z"}`
	if raw != wantMetrics {
		t.Fatalf("metrics JSON = %s, want %s", raw, wantMetrics)
	}
}

// TestOrefStateRoundTrip reconstructs lastAlertsJson from the cached raw alerts.
func TestOrefStateRoundTrip(t *testing.T) {
	worker := newTestWorker(t, testWorkerOptions{env: testEnv()})
	worker.store.put(orefAlertsCacheKey, `{"scope":"global","configured":true,"alerts":[ {"id":"a", "cat":"c"} ],"historyCount24h":1,"totalHistoryCount":2,"timestamp":"2026-01-02T03:04:05.000Z"}`)
	worker.store.put(orefHistoryCacheKey, `{"scope":"global","configured":true,"history":[{"alerts":[],"timestamp":"2026-01-02T03:04:05.000Z"}],"historyCount24h":1,"totalHistoryCount":2,"timestamp":"2026-01-02T03:04:05.000Z"}`)

	state, err := worker.service.loadOrefState(context.Background())
	if err != nil {
		t.Fatalf("loadOrefState() error = %v", err)
	}
	if got, want := state.LastAlertsJSON, `[{"id":"a","cat":"c"}]`; got != want {
		t.Fatalf("LastAlertsJSON = %s, want %s", got, want)
	}
	if state.LastPollAt != time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC).UnixMilli() {
		t.Fatalf("LastPollAt = %d", state.LastPollAt)
	}
	if state.HistoryCount24h != 1 || state.TotalHistoryCount != 2 || len(state.History) != 1 {
		t.Fatalf("history state = %#v", state)
	}
}

// TestRealtimeEventJSON pins the event envelope and both payload shapes.
func TestRealtimeEventJSON(t *testing.T) {
	item := TelegramItem{ID: "h:1", Source: "telegram", Channel: "h", ChannelTitle: "H", URL: "https://t.me/h/1", TS: "2026-01-02T03:04:05.000Z", Text: "x", Topic: "other", Tags: []string{}, EarlySignal: true}
	event, err := newRealtimeEvent(RealtimeEventTelegramUpdate, telegramUpdatePayload{
		Count:     1,
		UpdatedAt: "2026-01-02T03:04:05.000Z",
		Items:     []TelegramItem{item},
	})
	if err != nil {
		t.Fatalf("newRealtimeEvent() error = %v", err)
	}
	event.Timestamp = "2026-01-02T03:04:05.000Z"
	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshal event: %v", err)
	}
	want := `{"version":1,"type":"situation:telegram.update","payload":{"count":1,"updatedAt":"2026-01-02T03:04:05.000Z","items":[{"id":"h:1","source":"telegram","channel":"h","channelTitle":"H","url":"https://t.me/h/1","ts":"2026-01-02T03:04:05.000Z","text":"x","topic":"other","tags":[],"earlySignal":true}]},"timestamp":"2026-01-02T03:04:05.000Z"}`
	if string(encoded) != want {
		t.Fatalf("telegram event JSON = %s, want %s", encoded, want)
	}

	orefEvent, err := newRealtimeEvent(RealtimeEventOrefUpdate, orefUpdatePayload{
		Alerts:            []json.RawMessage{json.RawMessage(`{"id":"a"}`)},
		HistoryCount24h:   1,
		TotalHistoryCount: 2,
		UpdatedAt:         "2026-01-02T03:04:05.000Z",
		HistoryEntry:      nil,
	})
	if err != nil {
		t.Fatalf("newRealtimeEvent(oref) error = %v", err)
	}
	orefEvent.Timestamp = "2026-01-02T03:04:05.000Z"
	encoded, err = json.Marshal(orefEvent)
	if err != nil {
		t.Fatalf("marshal oref event: %v", err)
	}
	want = `{"version":1,"type":"situation:oref.update","payload":{"alerts":[{"id":"a"}],"historyCount24h":1,"totalHistoryCount":2,"updatedAt":"2026-01-02T03:04:05.000Z","historyEntry":null},"timestamp":"2026-01-02T03:04:05.000Z"}`
	if string(encoded) != want {
		t.Fatalf("oref event JSON = %s, want %s", encoded, want)
	}
}

// TestBuildDefaultOrefRuleID pins the sha1-based rule id.
func TestBuildDefaultOrefRuleID(t *testing.T) {
	got := buildDefaultOrefRuleID("org-1", orefActiveAlertsMetricSlug)
	want := "default-oref-alert-b5d20747bc0686942e4ee06078665a3252b72e73"
	if got != want {
		t.Fatalf("buildDefaultOrefRuleID() = %q, want %q", got, want)
	}
	history := buildDefaultOrefRuleID("org-1", orefHistory24hMetricSlug)
	if want := "default-oref-alert-bdb8770c0e2636fe9fb2d4be48a12d2727b6119b"; history != want {
		t.Fatalf("history rule id = %q, want %q", history, want)
	}
}

// TestOrefDefaultRuleDefinitions pins the rule constants.
func TestOrefDefaultRuleDefinitions(t *testing.T) {
	if len(orefDefaultAlertRules) != 2 {
		t.Fatalf("definitions = %d", len(orefDefaultAlertRules))
	}
	first := orefDefaultAlertRules[0]
	if first.Slug != "situation.oref.active_alerts" || first.ThresholdValue != 1 || first.Name != "Situation Monitor: OREF Active Alerts" {
		t.Fatalf("first definition = %#v", first)
	}
	second := orefDefaultAlertRules[1]
	if second.Slug != "situation.oref.history_24h" || second.ThresholdValue != 25 {
		t.Fatalf("second definition = %#v", second)
	}
}

// TestLoadTelegramChannels covers the enabled!==false filter, handle
// normalization and the limit clamp.
func TestLoadTelegramChannels(t *testing.T) {
	full := loadTelegramChannels("full")
	if len(full) == 0 {
		t.Fatal("full channel set is empty")
	}
	for _, channel := range full {
		if channel.Handle == "" || channel.Handle[0] == '@' {
			t.Fatalf("channel handle was not normalized: %q", channel.Handle)
		}
	}
	if tech := loadTelegramChannels("tech"); len(tech) != 0 {
		t.Fatalf("tech channel set = %d entries, want 0", len(tech))
	}
	if unknown := loadTelegramChannels("does-not-exist"); len(unknown) != 0 {
		t.Fatalf("unknown channel set = %d entries", len(unknown))
	}

	zero := 0
	fifty := 50
	if got := telegramChannelMessageLimit(TelegramChannelConfig{}); got != 25 {
		t.Fatalf("default limit = %d, want 25", got)
	}
	if got := telegramChannelMessageLimit(TelegramChannelConfig{MaxMessages: &zero}); got != 1 {
		t.Fatalf("zero limit = %d, want 1", got)
	}
	if got := telegramChannelMessageLimit(TelegramChannelConfig{MaxMessages: &fifty}); got != 50 {
		t.Fatalf("fifty limit = %d, want 50", got)
	}
}

// TestTelegramChannelsMatchesNest verifies the embedded catalog is a verbatim
// copy of the NestJS asset. The repository checkout is required; a module-only
// checkout skips the comparison.
func TestTelegramChannelsMatchesNest(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Skip("runtime.Caller unavailable")
	}
	nestPath := filepath.Join(filepath.Dir(sourceFile), "..", "..", "..", "api", "src", "modules", "situation-monitor", "signals", "telegram-channels.json")
	nestBytes, err := os.ReadFile(nestPath)
	if err != nil {
		t.Skipf("NestJS channel catalog not available at %s: %v", nestPath, err)
	}
	embedded, err := telegramChannelsAsset.ReadFile(telegramChannelsFileName)
	if err != nil {
		t.Fatalf("read embedded catalog: %v", err)
	}
	if !bytes.Equal(nestBytes, embedded) {
		t.Fatalf("telegram-channels.json drifted from the NestJS asset")
	}
}

// TestJSONMarshalingDoesNotEscapeHTML keeps the cache/event bytes under
// JSON.stringify semantics (Go escapes <, > and & by default).
func TestJSONMarshalingDoesNotEscapeHTML(t *testing.T) {
	encoded, err := marshalJSONNoEscape(map[string]string{"text": "a <b> & c"})
	if err != nil {
		t.Fatalf("marshalJSONNoEscape() error = %v", err)
	}
	if string(encoded) != `{"text":"a <b> & c"}` {
		t.Fatalf("marshalJSONNoEscape() = %s", encoded)
	}
	alerts := []json.RawMessage{json.RawMessage(`{"title":"a <b> & c"}`)}
	if got := marshalAlerts(alerts); got != `[{"title":"a <b> & c"}]` {
		t.Fatalf("marshalAlerts() = %s", got)
	}
}

// TestCompactJSONPreservesKeyOrder guards the change-detection fingerprint.
func TestCompactJSONPreservesKeyOrder(t *testing.T) {
	raw := []byte(" {\n \"z\": 1, \"a\": 2 } ")
	compacted, err := compactJSON(raw)
	if err != nil {
		t.Fatalf("compactJSON() error = %v", err)
	}
	if string(compacted) != `{"z":1,"a":2}` {
		t.Fatalf("compactJSON() = %s", compacted)
	}
	alerts := []json.RawMessage{json.RawMessage(`{"z":1,"a":2}`)}
	if got := marshalAlerts(alerts); got != `[{"z":1,"a":2}]` {
		t.Fatalf("marshalAlerts() = %s", got)
	}
}
