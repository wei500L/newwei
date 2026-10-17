package situationsignals

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// refreshRecordJSON builds a cached refresh-run record. `extra` is merged into
// the base document so a test can drop or corrupt individual fields.
func refreshRecordJSON(t *testing.T, body string) string {
	t.Helper()
	return `{"refreshId":"run-1","orgId":"org-1","requestedAt":"2026-01-01T00:00:00.000Z",` + body
}

func TestGetRefreshRunMissingAndCrossTenant(t *testing.T) {
	store, ops := newMemoryCache()
	service := &Service{cache: ops}
	if _, err := service.getRefreshRun(t.Context(), "org-1", "missing"); !errors.Is(err, errRefreshRunMissing) {
		t.Fatalf("missing err = %v", err)
	}

	store.values[refreshRunPrefix+"run-1"] = []byte(refreshRecordJSON(t, `"taskWindowStart":"2026-01-01T00:00:00.000Z","activeSourceIds":[],"warnings":[],"terminal":false}`))
	if _, err := service.getRefreshRun(t.Context(), "org-2", "run-1"); !errors.Is(err, errRefreshRunMissing) {
		t.Fatalf("cross tenant err = %v", err)
	}
	// A record without orgId is indistinguishable from another tenant's record.
	store.values[refreshRunPrefix+"run-2"] = []byte(`{"refreshId":"run-2","taskWindowStart":"2026-01-01T00:00:00.000Z"}`)
	if _, err := service.getRefreshRun(t.Context(), "org-1", "run-2"); !errors.Is(err, errRefreshRunMissing) {
		t.Fatalf("missing org err = %v", err)
	}
}

func TestGetRefreshRunInvalidTaskWindowIsNotFound(t *testing.T) {
	for _, window := range []string{`"not-a-timestamp"`, `""`, `null`, `{}`} {
		store, ops := newMemoryCache()
		store.values[refreshRunPrefix+"run-1"] = []byte(refreshRecordJSON(t, `"taskWindowStart":`+window+`,"activeSourceIds":[],"warnings":[]}`))
		service := &Service{cache: ops}
		if _, err := service.getRefreshRun(t.Context(), "org-1", "run-1"); !errors.Is(err, errRefreshRunMissing) {
			t.Fatalf("window %s err = %v", window, err)
		}
	}
}

func TestGetRefreshRunDefensiveNormalization(t *testing.T) {
	store, ops := newMemoryCache()
	// A record written by an older revision: no activeSourceIds, no warnings and
	// no crawl object. Before the fix every read of this record raised.
	store.values[refreshRunPrefix+"run-1"] = []byte(`{"refreshId":"run-1","orgId":"org-1","requestedAt":"2026-01-01T00:00:00.000Z","taskWindowStart":"2026-01-01T00:00:00.000Z","terminal":false}`)
	service := &Service{cache: ops}

	response, err := service.getRefreshRun(t.Context(), "org-1", "run-1")
	if err != nil {
		t.Fatal(err)
	}
	if response.Progress.CrawlTasks != (crawlTaskCounts{}) || response.Progress.AnalysisTasks != (analysisTaskCounts{}) {
		t.Fatalf("progress = %+v", response.Progress)
	}
	if len(response.Warnings) != 0 {
		t.Fatalf("warnings = %v", response.Warnings)
	}
	if response.Signals != nil || response.Cache != nil {
		t.Fatalf("signals/cache must be omitted: %+v", response)
	}
	if response.Status != refreshStatusCompleted {
		t.Fatalf("status = %s", response.Status)
	}
	// With no crawl object the placeholder makes activeSourceCount === 0 true,
	// which is what makes the run terminal.
	if !response.Terminal {
		t.Fatalf("terminal = %v", response.Terminal)
	}
	encoded := string(mustEncode(t, response))
	if !strings.Contains(encoded, `"crawl":{"activeSourceCount":0,"permitted":false,"attempted":false,"schedulerTriggered":false,"crawlTaskCount":0,"analysisTaskCount":0}`) {
		t.Fatalf("crawl placeholder = %s", encoded)
	}
	if strings.Contains(encoded, `"signals"`) || strings.Contains(encoded, `"cache"`) {
		t.Fatalf("signals/cache must be absent: %s", encoded)
	}

	// The terminal write-back patched only that field and refreshed the TTL.
	persisted := string(store.values[refreshRunPrefix+"run-1"])
	if !strings.Contains(persisted, `"terminal":true`) {
		t.Fatalf("persisted = %s", persisted)
	}
	if !strings.Contains(persisted, `"requestedAt":"2026-01-01T00:00:00.000Z"`) {
		t.Fatalf("persisted lost a field: %s", persisted)
	}
	if store.ttls[refreshRunPrefix+"run-1"] != refreshRunTTL {
		t.Fatalf("ttl = %v", store.ttls[refreshRunPrefix+"run-1"])
	}
}

func TestGetRefreshRunEmptySourceListSkipsCounts(t *testing.T) {
	store, ops := newMemoryCache()
	// activeSourceIds is present but empty: every count is 0 without MySQL.
	store.values[refreshRunPrefix+"run-1"] = []byte(refreshRecordJSON(t, `"taskWindowStart":"2026-01-01T00:00:00.000Z","activeSourceIds":[],"warnings":[],"crawl":{"attempted":true,"permitted":true,"activeSourceCount":3,"schedulerTriggered":true,"crawlTaskCount":2,"analysisTaskCount":1},"signals":{"telegram":{}},"cache":{"insightsCleared":0},"terminal":false}`))
	service := &Service{cache: ops}
	response, err := service.getRefreshRun(t.Context(), "org-1", "run-1")
	if err != nil {
		t.Fatal(err)
	}
	if response.Progress.CrawlTasks.Pending != 0 || response.Progress.AnalysisTasks.Delayed != 0 {
		t.Fatalf("progress = %+v", response.Progress)
	}
	// crawlTaskCount is 2 so hasAnyTasks is true; with activeTaskCount 0 and
	// activeSourceCount 3 the run is terminal, and an empty warning list means
	// "completed".
	if response.Status != refreshStatusCompleted || !response.Terminal {
		t.Fatalf("status = %s terminal = %v", response.Status, response.Terminal)
	}
	// signals and cache pass through verbatim.
	if response.Signals == nil || response.Cache == nil {
		t.Fatalf("signals/cache must be present: %+v", response)
	}
}

func TestGetRefreshRunNonEmptySourceListRequiresDatabase(t *testing.T) {
	store, ops := newMemoryCache()
	store.values[refreshRunPrefix+"run-1"] = []byte(refreshRecordJSON(t, `"taskWindowStart":"2026-01-01T00:00:00.000Z","activeSourceIds":["source-1"],"warnings":[]}`))
	service := &Service{cache: ops}
	if _, err := service.getRefreshRun(t.Context(), "org-1", "run-1"); !errors.Is(err, errNoDatabase) {
		t.Fatalf("err = %v (a non-empty source filter must reach MySQL)", err)
	}
}

func TestGetRefreshRunStateMachine(t *testing.T) {
	cases := []struct {
		name     string
		warnings string
		crawl    string
		terminal bool
		status   refreshLifecycleStatus
	}{
		{
			name:     "no tasks, no warnings completes",
			warnings: `[]`,
			crawl:    `{"attempted":true,"permitted":true,"activeSourceCount":1,"schedulerTriggered":true,"crawlTaskCount":0,"analysisTaskCount":0}`,
			terminal: true,
			status:   refreshStatusCompleted,
		},
		{
			name:     "warning severity makes it partial",
			warnings: `[{"severity":"warning","message":"m"}]`,
			crawl:    `{"attempted":true,"permitted":true,"activeSourceCount":1,"schedulerTriggered":true,"crawlTaskCount":0,"analysisTaskCount":0}`,
			terminal: true,
			status:   refreshStatusPartial,
		},
		{
			name:     "error severity makes it failed",
			warnings: `[{"severity":"error"}]`,
			crawl:    `{"attempted":true,"permitted":true,"activeSourceCount":1,"schedulerTriggered":true,"crawlTaskCount":0,"analysisTaskCount":0}`,
			terminal: true,
			status:   refreshStatusFailed,
		},
		{
			name:     "crawl not permitted is terminal",
			warnings: `[]`,
			crawl:    `{"attempted":false,"permitted":false,"activeSourceCount":2,"schedulerTriggered":false,"crawlTaskCount":0,"analysisTaskCount":0}`,
			terminal: true,
			status:   refreshStatusCompleted,
		},
		{
			// Every term of the terminal OR is false: sources are configured, the
			// caller is permitted, the crawl was attempted, no task ran and the
			// scheduler fired.
			name:     "all terminal terms false is not terminal",
			warnings: `[]`,
			crawl:    `{"attempted":true,"permitted":true,"activeSourceCount":2,"schedulerTriggered":true,"crawlTaskCount":0,"analysisTaskCount":0}`,
			terminal: false,
			status:   refreshStatusCompleted,
		},
		{
			name:     "scheduler not triggered is terminal",
			warnings: `[]`,
			crawl:    `{"attempted":true,"permitted":true,"activeSourceCount":2,"schedulerTriggered":false,"crawlTaskCount":0,"analysisTaskCount":0}`,
			terminal: true,
			status:   refreshStatusCompleted,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store, ops := newMemoryCache()
			store.values[refreshRunPrefix+"run-1"] = []byte(refreshRecordJSON(t, `"taskWindowStart":"2026-01-01T00:00:00.000Z","activeSourceIds":[],"warnings":`+tc.warnings+`,"crawl":`+tc.crawl+`,"terminal":`+boolLiteral(!tc.terminal)+`}`))
			service := &Service{cache: ops}
			response, err := service.getRefreshRun(t.Context(), "org-1", "run-1")
			if err != nil {
				t.Fatal(err)
			}
			if response.Status != tc.status {
				t.Fatalf("status = %s, want %s", response.Status, tc.status)
			}
			if response.Terminal != tc.terminal {
				t.Fatalf("terminal = %v, want %v", response.Terminal, tc.terminal)
			}
		})
	}
}

func TestGetRefreshRunTerminalWriteBackOnlyWhenChanged(t *testing.T) {
	store, ops := newMemoryCache()
	store.values[refreshRunPrefix+"run-1"] = []byte(refreshRecordJSON(t, `"taskWindowStart":"2026-01-01T00:00:00.000Z","activeSourceIds":[],"warnings":[],"terminal":true}`))
	service := &Service{cache: ops}
	if _, err := service.getRefreshRun(t.Context(), "org-1", "run-1"); err != nil {
		t.Fatal(err)
	}
	if store.ttls[refreshRunPrefix+"run-1"] != 0 {
		t.Fatal("an unchanged terminal must not rewrite the cache")
	}
}

func TestGetRefreshRunInvalidJSONIsServerError(t *testing.T) {
	store, ops := newMemoryCache()
	store.values[refreshRunPrefix+"run-1"] = []byte(`{not json`)
	service := &Service{cache: ops}
	_, err := service.getRefreshRun(t.Context(), "org-1", "run-1")
	var status *statusError
	if !errors.As(err, &status) || status.status != 500 {
		t.Fatalf("err = %v", err)
	}
}

func TestWarningsContainError(t *testing.T) {
	warnings := []rawJSON{
		{raw: json.RawMessage(`"not an object"`)},
		{raw: json.RawMessage(`null`)},
		{raw: json.RawMessage(`{"severity":"warning"}`)},
	}
	if warningsContainError(warnings) {
		t.Fatal("no error severity present")
	}
	warnings = append(warnings, rawJSON{raw: json.RawMessage(`{"severity":"error"}`)})
	if !warningsContainError(warnings) {
		t.Fatal("error severity must be detected")
	}
	if warningsContainError([]rawJSON{}) {
		t.Fatal("an empty list has no error")
	}
}

func TestIsJSONNumberZero(t *testing.T) {
	cases := map[string]bool{
		`0`:     true,
		`0.0`:   true,
		`-0`:    true,
		`"0"`:   false,
		`1`:     false,
		`null`:  false,
		`false`: false,
		`{}`:    false,
	}
	for raw, want := range cases {
		if got := (rawJSON{raw: json.RawMessage(raw)}).isJSONNumberZero(); got != want {
			t.Fatalf("%s: got %v, want %v", raw, got, want)
		}
	}
}

func boolLiteral(value bool) string {
	if value {
		return "true"
	}
	return "false"
}

func mustEncode(t *testing.T, value encodedResponse) []byte {
	t.Helper()
	encoded, err := value.encodeJSON()
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestTerminalNeedsWriteBack(t *testing.T) {
	cases := []struct {
		raw      string
		terminal bool
		want     bool
	}{
		{"true", true, false},
		{"true", false, true},
		{"false", false, false},
		{"false", true, true},
		{"", false, true},
		{"null", false, true},
		{"0", false, true},
		{`"false"`, false, true},
	}
	for _, tc := range cases {
		raw := rawJSON{}
		if tc.raw != "" {
			raw = rawJSON{raw: json.RawMessage(tc.raw)}
		}
		if got := terminalNeedsWriteBack(raw, tc.terminal); got != tc.want {
			t.Fatalf("%q/%v: got %v, want %v", tc.raw, tc.terminal, got, tc.want)
		}
	}
}
