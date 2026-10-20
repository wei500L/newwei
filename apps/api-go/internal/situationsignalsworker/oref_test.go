package situationsignalsworker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/situationsignals"
)

// orefServer is a controllable OREF upstream: alerts and history bodies can be
// swapped per test while the request counters stay observable.
type orefServer struct {
	mu              sync.Mutex
	alertsBody      string
	alertsStatus    int
	historyBody     string
	historyStatus   int
	alertsRequests  int
	historyRequests int
}

func newOrefServer() *orefServer {
	return &orefServer{
		alertsBody:    "[]",
		alertsStatus:  http.StatusOK,
		historyBody:   "[]",
		historyStatus: http.StatusOK,
	}
}

func (s *orefServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	switch {
	case r.URL.Path == "/alerts":
		body, status := s.alertsBody, s.alertsStatus
		s.alertsRequests++
		s.mu.Unlock()
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	case r.URL.Path == "/history":
		body, status := s.historyBody, s.historyStatus
		s.historyRequests++
		s.mu.Unlock()
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	default:
		s.mu.Unlock()
		http.NotFound(w, r)
	}
}

func (s *orefServer) setAlerts(body string, status int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.alertsBody = body
	s.alertsStatus = status
}

func (s *orefServer) setHistory(body string, status int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.historyBody = body
	s.historyStatus = status
}

func (s *orefServer) counts() (alerts, history int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.alertsRequests, s.historyRequests
}

// newOrefWorker builds a worker pointed at the fake OREF upstream.
func newOrefWorker(t *testing.T) (*testWorker, *orefServer) {
	t.Helper()
	upstream := newOrefServer()
	server := httptest.NewServer(upstream)
	t.Cleanup(server.Close)

	env := testEnv()
	env.OrefEnabled = true
	env.OrefProxyAuth = "user:pass@127.0.0.1:3128"
	env.OrefAlertsURL = server.URL + "/alerts"
	env.OrefHistoryURL = server.URL + "/history"
	worker := newTestWorker(t, testWorkerOptions{env: env, httpClient: server.Client()})
	return worker, upstream
}

// TestParseOrefAlertsResponse pins the parsing matrix and the B3 fix.
func TestParseOrefAlertsResponse(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		want    int
		wantErr bool
	}{
		{name: "empty", body: "", want: 0},
		{name: "whitespace", body: " \n\t ", want: 0},
		{name: "empty array", body: "[]", want: 0},
		{name: "null", body: "null", want: 0},
		{name: "bom array", body: "\uFEFF[]", want: 0},
		{name: "array", body: `[{"id":"a"},{"id":"b"}]`, want: 2},
		{name: "object", body: `{"id":"a"}`, want: 1},
		{name: "number", body: `42`, want: 0},
		{name: "string", body: `"hi"`, want: 0},
		{name: "html error page", body: `<html>bad gateway</html>`, wantErr: true},
		{name: "truncated array", body: `[{"id":`, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			alerts, err := parseOrefAlertsResponse([]byte(tt.body))
			if tt.wantErr {
				if err == nil {
					t.Fatalf("parseOrefAlertsResponse(%q) error = nil, want error", tt.body)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseOrefAlertsResponse(%q) error = %v", tt.body, err)
			}
			if len(alerts) != tt.want {
				t.Fatalf("alerts = %d, want %d", len(alerts), tt.want)
			}
		})
	}
}

// TestPollOrefSuccess pins the whole success path: documents, event payload and
// counters.
func TestPollOrefSuccess(t *testing.T) {
	worker, upstream := newOrefWorker(t)
	// Deliberately spaced JSON: the normalized alert keeps the original key
	// order but loses the whitespace, like JSON.parse + JSON.stringify.
	upstream.setAlerts(`[ { "id": "a", "cat": "c", "title": "t", "data": ["x", "y"], "desc": "", "alertDate": "2026-01-01 12:00:00" } ]`, http.StatusOK)

	worker.handleJob(t, SourceOref)
	nowTimestamp := nestISOTimeMillis(worker.clock.now().UnixMilli())

	state, err := worker.service.loadOrefState(context.Background())
	if err != nil {
		t.Fatalf("loadOrefState() error = %v", err)
	}
	wantFingerprint := `[{"id":"a","cat":"c","title":"t","data":["x","y"],"desc":"","alertDate":"2026-01-01 12:00:00"}]`
	if state.LastAlertsJSON != wantFingerprint {
		t.Fatalf("LastAlertsJSON = %s, want %s", state.LastAlertsJSON, wantFingerprint)
	}
	if len(state.History) != 1 {
		t.Fatalf("history = %d entries, want 1", len(state.History))
	}
	if state.History[0].Timestamp != nowTimestamp {
		t.Fatalf("history timestamp = %q, want %q", state.History[0].Timestamp, nowTimestamp)
	}
	if state.HistoryCount24h != 2 || state.TotalHistoryCount != 2 {
		t.Fatalf("counts = %d/%d, want 2/2 (two alert areas)", state.HistoryCount24h, state.TotalHistoryCount)
	}
	if state.LastError != "" {
		t.Fatalf("lastError = %q", state.LastError)
	}

	alertsRaw, _ := worker.store.raw(orefAlertsCacheKey)
	wantAlerts := `{"scope":"global","configured":true,"alerts":[` + wantFingerprint[1:len(wantFingerprint)-1] + `],"historyCount24h":2,"totalHistoryCount":2,"timestamp":"` + nowTimestamp + `"}`
	if alertsRaw != wantAlerts {
		t.Fatalf("alerts document = %s, want %s", alertsRaw, wantAlerts)
	}
	metricsRaw, _ := worker.store.raw(orefMetricsCacheKey)
	wantMetrics := `{"activeAlerts":1,"historyCount24h":2,"updatedAt":"` + nowTimestamp + `"}`
	if metricsRaw != wantMetrics {
		t.Fatalf("metrics document = %s, want %s", metricsRaw, wantMetrics)
	}

	events := worker.publisher.snapshot()
	if len(events) != 1 || events[0].Type != RealtimeEventOrefUpdate {
		t.Fatalf("events = %#v", events)
	}
	var payload orefUpdatePayload
	if err := json.Unmarshal(events[0].Payload, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if len(payload.Alerts) != 1 || payload.HistoryCount24h != 2 || payload.TotalHistoryCount != 2 {
		t.Fatalf("payload = %#v", payload)
	}
	if payload.HistoryEntry == nil || payload.HistoryEntry.Timestamp != nowTimestamp || len(payload.HistoryEntry.Alerts) != 1 {
		t.Fatalf("historyEntry = %#v", payload.HistoryEntry)
	}
	if payload.UpdatedAt != nowTimestamp {
		t.Fatalf("updatedAt = %q, want %q", payload.UpdatedAt, nowTimestamp)
	}
}

// TestPollOrefUnchanged checks that an identical alert list produces no new
// event and no duplicated history wave.
func TestPollOrefUnchanged(t *testing.T) {
	worker, upstream := newOrefWorker(t)
	upstream.setAlerts(`[{"id":"a"}]`, http.StatusOK)

	worker.handleJob(t, SourceOref)
	worker.clock.advance(time.Minute)
	worker.handleJob(t, SourceOref)

	state, err := worker.service.loadOrefState(context.Background())
	if err != nil {
		t.Fatalf("loadOrefState() error = %v", err)
	}
	if len(state.History) != 1 {
		t.Fatalf("history = %d entries, want 1", len(state.History))
	}
	if events := worker.publisher.snapshot(); len(events) != 1 {
		t.Fatalf("events = %d, want only the first change", len(events))
	}
}

// TestPollOrefB3KeepsLastGoodState covers B3: an HTML body and a non-2xx
// response must not overwrite the cache, publish an event or count as an empty
// alert list.
func TestPollOrefB3KeepsLastGoodState(t *testing.T) {
	for _, tt := range []struct {
		name   string
		status int
		body   string
	}{
		{name: "html error page", status: http.StatusOK, body: `<html><body>Bad Gateway</body></html>`},
		{name: "http 503", status: http.StatusServiceUnavailable, body: `[]`},
	} {
		t.Run(tt.name, func(t *testing.T) {
			worker, upstream := newOrefWorker(t)
			upstream.setAlerts(`[{"id":"a","data":["x"]}]`, http.StatusOK)
			worker.handleJob(t, SourceOref)

			alertsBefore, _ := worker.store.raw(orefAlertsCacheKey)
			historyBefore, _ := worker.store.raw(orefHistoryCacheKey)
			metricsBefore, _ := worker.store.raw(orefMetricsCacheKey)
			eventsBefore := len(worker.publisher.snapshot())

			upstream.setAlerts(tt.body, tt.status)
			worker.clock.advance(time.Minute)
			worker.handleJob(t, SourceOref)

			if got, _ := worker.store.raw(orefAlertsCacheKey); got != alertsBefore {
				t.Fatalf("alerts document was overwritten: %s", got)
			}
			if got, _ := worker.store.raw(orefHistoryCacheKey); got != historyBefore {
				t.Fatalf("history document was overwritten: %s", got)
			}
			if got, _ := worker.store.raw(orefMetricsCacheKey); got != metricsBefore {
				t.Fatalf("metrics document was overwritten: %s", got)
			}
			if events := worker.publisher.snapshot(); len(events) != eventsBefore {
				t.Fatalf("events = %d, want %d", len(events), eventsBefore)
			}
			if worker.service.orefState.LastError == "" {
				t.Fatal("lastError was not set")
			}
			if !strings.Contains(worker.service.orefState.LastError, "OREF") {
				t.Fatalf("lastError = %q", worker.service.orefState.LastError)
			}
		})
	}
}

// TestPollOrefEmptyBodies pins the empty-body branches that still mean "no
// active alerts".
func TestPollOrefEmptyBodies(t *testing.T) {
	for _, body := range []string{"", "[]", "null", " \n "} {
		t.Run(body, func(t *testing.T) {
			worker, upstream := newOrefWorker(t)
			upstream.setAlerts(body, http.StatusOK)
			worker.handleJob(t, SourceOref)

			state, err := worker.service.loadOrefState(context.Background())
			if err != nil {
				t.Fatalf("loadOrefState() error = %v", err)
			}
			if len(state.LastAlerts) != 0 || state.LastAlertsJSON != "[]" {
				t.Fatalf("alerts = %#v", state.LastAlerts)
			}
			if state.LastError != "" {
				t.Fatalf("lastError = %q", state.LastError)
			}
			if events := worker.publisher.snapshot(); len(events) != 0 {
				t.Fatalf("events = %d, want 0 (the cache was already empty)", len(events))
			}
		})
	}
}

// TestPollOrefSingleObject treats one alert object as a one-element list.
func TestPollOrefSingleObject(t *testing.T) {
	worker, upstream := newOrefWorker(t)
	upstream.setAlerts(`{"id":"solo"}`, http.StatusOK)
	worker.handleJob(t, SourceOref)

	state, err := worker.service.loadOrefState(context.Background())
	if err != nil {
		t.Fatalf("loadOrefState() error = %v", err)
	}
	if len(state.LastAlerts) != 1 {
		t.Fatalf("alerts = %#v", state.LastAlerts)
	}
}

// TestPollOrefBootstrapFromCache: the cached history document is adopted and no
// upstream history request is made.
func TestPollOrefBootstrapFromCache(t *testing.T) {
	worker, upstream := newOrefWorker(t)
	worker.store.put(orefHistoryCacheKey, `{"scope":"global","configured":true,"history":[{"alerts":[{"id":"old","data":["a","b"]}],"timestamp":"2026-01-01T00:00:00.000Z"}],"historyCount24h":2,"totalHistoryCount":2,"timestamp":"2026-01-01T00:00:00.000Z"}`)
	upstream.setAlerts(`[{"id":"new"}]`, http.StatusOK)

	worker.handleJob(t, SourceOref)

	if alerts, history := upstream.counts(); history != 0 {
		t.Fatalf("history requests = %d, want 0 when the cache exists", history)
	} else if alerts != 1 {
		t.Fatalf("alerts requests = %d, want 1", alerts)
	}
	state, err := worker.service.loadOrefState(context.Background())
	if err != nil {
		t.Fatalf("loadOrefState() error = %v", err)
	}
	if len(state.History) != 2 {
		t.Fatalf("history = %d entries, want the cached wave plus the new one", len(state.History))
	}
	if state.BootstrapSource != "cache" {
		t.Fatalf("bootstrap source = %q", state.BootstrapSource)
	}
}

// TestPollOrefBootstrapFromUpstream pins the history rebuild: one wave per
// alertDate, alert ids typeIndex-based and the shared OrefDateToUTC conversion.
func TestPollOrefBootstrapFromUpstream(t *testing.T) {
	worker, _ := newOrefServerWorker(t, `[
		{"alertDate":"2026-01-01 12:00:00","category":"rockets","title":"Rockets","data":"Area A"},
		{"alertDate":"2026-01-01 12:00:00","category":"uav","title":"UAV","data":""},
		{"alertDate":"2026-01-02 08:30:00","category":"rockets","title":"Rockets","data":"Area B"}
	]`)

	worker.handleJob(t, SourceOref)

	historyRaw, _ := worker.store.raw(orefHistoryCacheKey)
	var document orefHistoryDocument
	if err := json.Unmarshal([]byte(historyRaw), &document); err != nil {
		t.Fatalf("decode history document: %v", err)
	}
	if len(document.History) != 2 {
		t.Fatalf("history waves = %d, want 2", len(document.History))
	}
	if want := situationsignals.OrefDateToUTC("2026-01-01 12:00:00"); document.History[0].Timestamp != want {
		t.Fatalf("first wave timestamp = %q, want %q", document.History[0].Timestamp, want)
	}
	if len(document.History[0].Alerts) != 2 || len(document.History[1].Alerts) != 1 {
		t.Fatalf("wave sizes = %d/%d", len(document.History[0].Alerts), len(document.History[1].Alerts))
	}
	var first orefHistoryAlert
	if err := json.Unmarshal(document.History[0].Alerts[0], &first); err != nil {
		t.Fatalf("decode first alert: %v", err)
	}
	if first.ID != "rockets-0-20260101120000" || first.Cat != "rockets" || first.Title != "Rockets" || !reflect.DeepEqual(first.Data, []string{"Area A"}) || first.Desc != "" {
		t.Fatalf("first alert = %#v", first)
	}
	var second orefHistoryAlert
	if err := json.Unmarshal(document.History[0].Alerts[1], &second); err != nil {
		t.Fatalf("decode second alert: %v", err)
	}
	if second.ID != "uav-1-20260101120000" || len(second.Data) != 0 {
		t.Fatalf("second alert = %#v", second)
	}
}

// newOrefServerWorker builds a worker whose history endpoint serves records and
// whose alerts endpoint serves "[]".
func newOrefServerWorker(t *testing.T, historyBody string) (*testWorker, *orefServer) {
	t.Helper()
	worker, upstream := newOrefWorker(t)
	upstream.setHistory(historyBody, http.StatusOK)
	upstream.setAlerts("[]", http.StatusOK)
	return worker, upstream
}

// TestPollOrefRetentionAndCounts covers recomputeOrefHistoryCounts.
func TestPollOrefRetentionAndCounts(t *testing.T) {
	worker, upstream := newOrefWorker(t)
	now := worker.clock.now()
	timestamp := func(offset time.Duration) string {
		return nestISOTimeMillis(now.Add(offset).UnixMilli())
	}
	document := orefHistoryDocument{
		Scope:      "global",
		Configured: true,
		History: []OrefHistoryEntry{
			{Alerts: []json.RawMessage{json.RawMessage(`{"data":["a"]}`)}, Timestamp: timestamp(-8 * 24 * time.Hour)},
			{Alerts: []json.RawMessage{json.RawMessage(`{"data":["a","b"]}`)}, Timestamp: timestamp(-25 * time.Hour)},
			{Alerts: []json.RawMessage{json.RawMessage(`{"data":[]}`)}, Timestamp: timestamp(-time.Hour)},
		},
		HistoryCount24h:   0,
		TotalHistoryCount: 0,
		Timestamp:         timestamp(0),
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("marshal history document: %v", err)
	}
	worker.store.put(orefHistoryCacheKey, string(encoded))
	upstream.setAlerts("[]", http.StatusOK)

	worker.handleJob(t, SourceOref)

	state, err := worker.service.loadOrefState(context.Background())
	if err != nil {
		t.Fatalf("loadOrefState() error = %v", err)
	}
	// The 8-day-old wave is purged; of the remaining two, only the newest is
	// inside 24h (an empty data array counts as one alert area).
	if len(state.History) != 2 {
		t.Fatalf("history = %d entries, want 2 after retention purge", len(state.History))
	}
	if state.HistoryCount24h != 1 {
		t.Fatalf("historyCount24h = %d, want 1", state.HistoryCount24h)
	}
	if state.TotalHistoryCount != 3 {
		t.Fatalf("totalHistoryCount = %d, want 3", state.TotalHistoryCount)
	}
}

// TestPollOrefHistoryTailTruncates checks the max-waves cut on persist.
func TestPollOrefHistoryTailTruncates(t *testing.T) {
	worker := newTestWorker(t, testWorkerOptions{env: testEnv()})
	state := emptyOrefState()
	for index := 0; index < 5; index++ {
		state.History = append(state.History, OrefHistoryEntry{Timestamp: nestISOTimeMillis(int64(index))})
	}
	worker.service.persistOrefHistory(context.Background(), state, true, "2026-01-02T03:04:05.000Z", 2)
	raw, _ := worker.store.raw(orefHistoryCacheKey)
	var document orefHistoryDocument
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		t.Fatalf("decode history document: %v", err)
	}
	if len(document.History) != 2 {
		t.Fatalf("history = %d entries, want the last 2", len(document.History))
	}
}

// TestPollOrefDisabledAndNotConfigured covers the two early-return messages.
func TestPollOrefDisabledAndNotConfigured(t *testing.T) {
	t.Run("disabled", func(t *testing.T) {
		worker := newTestWorker(t, testWorkerOptions{env: testEnv()})
		worker.handleJob(t, SourceOref)
		if worker.service.orefState.LastError != orefDisabledMessage {
			t.Fatalf("lastError = %q", worker.service.orefState.LastError)
		}
	})

	t.Run("not configured", func(t *testing.T) {
		env := testEnv()
		env.OrefEnabled = true
		worker := newTestWorker(t, testWorkerOptions{env: env})
		worker.handleJob(t, SourceOref)
		if worker.service.orefState.LastError != orefNotConfiguredText {
			t.Fatalf("lastError = %q", worker.service.orefState.LastError)
		}
	})
}

// TestPollOrefSkipsWhenAnotherInstanceHoldsTheLock covers the OREF B1 lease.
func TestPollOrefSkipsWhenAnotherInstanceHoldsTheLock(t *testing.T) {
	worker, upstream := newOrefWorker(t)
	upstream.setAlerts(`[{"id":"a"}]`, http.StatusOK)
	worker.locker.busy = true

	worker.handleJob(t, SourceOref)
	if alerts, history := upstream.counts(); alerts != 0 || history != 0 {
		t.Fatalf("upstream requests = %d/%d, want none while the lock is held", alerts, history)
	}
	if _, ok := worker.store.raw(orefAlertsCacheKey); ok {
		t.Fatal("state was written while the lock was held")
	}
}
