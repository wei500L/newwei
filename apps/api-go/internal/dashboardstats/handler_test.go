package dashboardstats

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

type stubAuth struct {
	identity *authhttp.Identity
}

func (s stubAuth) Authenticate(http.ResponseWriter, *http.Request) *authhttp.Identity {
	return s.identity
}

type fakeSource struct {
	mu           sync.Mutex
	orgs         []string
	items        map[string]int64
	processed    map[string]int64
	itemErr      error
	processedErr error
	logsErr      error
	queueOK      bool
	queue        queueCounts
}

func (f *fakeSource) note(orgID string) {
	f.mu.Lock()
	f.orgs = append(f.orgs, orgID)
	f.mu.Unlock()
}

func (f *fakeSource) CountItems(_ context.Context, orgID string) (int64, error) {
	f.note(orgID)
	if f.itemErr != nil {
		return 0, f.itemErr
	}
	return f.items[orgID], nil
}

func (f *fakeSource) CountProcessed(_ context.Context, orgID string) (int64, error) {
	f.note(orgID)
	if f.processedErr != nil {
		return 0, f.processedErr
	}
	return f.processed[orgID], nil
}

func (f *fakeSource) RecentLogs(_ context.Context, orgID string) ([]recentLog, error) {
	f.note(orgID)
	if f.logsErr != nil {
		return nil, f.logsErr
	}
	return []recentLog{}, nil
}

func (f *fakeSource) QueueCounts(_ context.Context, orgID string) (queueCounts, bool) {
	f.note(orgID)
	return f.queue, f.queueOK
}

func TestStatsUsesServerOrgAndIgnoresQuery(t *testing.T) {
	src := &fakeSource{
		items:     map[string]int64{"org-a": 4, "org-b": 9},
		processed: map[string]int64{"org-a": 2, "org-b": 7},
		queueOK:   true,
		queue:     queueCounts{Waiting: 3, Delayed: 1},
	}
	handler := &Handler{
		gate: membershipGate{auth: stubAuth{identity: authhttp.NewIdentity("user-1", "org-a", []string{"items.read"})}},
		src:  src,
	}
	req := httptest.NewRequest(http.MethodGet, "/api/dashboard/stats?orgId=org-b", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["itemCount"] != float64(4) || body["processedCount"] != float64(2) {
		t.Fatalf("body leaked the other org or ignored the server org: %s", rec.Body.String())
	}
	if body["queueCountsAvailable"] != true {
		t.Fatalf("countsAvailable = %v", body["queueCountsAvailable"])
	}
	src.mu.Lock()
	defer src.mu.Unlock()
	if len(src.orgs) == 0 {
		t.Fatal("source was not queried")
	}
	for _, orgID := range src.orgs {
		if orgID != "org-a" {
			t.Fatalf("query used %s, want only org-a", orgID)
		}
	}
}

func TestStatsRedisDegradationKeepsDocumentCounts(t *testing.T) {
	src := &fakeSource{
		items:     map[string]int64{"org-a": 4},
		processed: map[string]int64{"org-a": 2},
		queueOK:   false,
		queue:     queueCounts{Waiting: 99},
	}
	handler := &Handler{
		gate: membershipGate{auth: stubAuth{identity: authhttp.NewIdentity("user-1", "org-a", []string{"items.read"})}},
		src:  src,
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/dashboard/stats", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		ItemCount            int64       `json:"itemCount"`
		ProcessedCount       int64       `json:"processedCount"`
		Queue                queueCounts `json:"queue"`
		QueueCountsAvailable bool        `json:"queueCountsAvailable"`
		RecentQueueLogs      []recentLog `json:"recentQueueLogs"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.ItemCount != 4 || body.ProcessedCount != 2 || body.QueueCountsAvailable || body.Queue != (queueCounts{}) {
		t.Fatalf("degraded body = %+v", body)
	}
	if body.RecentQueueLogs == nil {
		t.Fatal("recentQueueLogs must be an empty array, not null")
	}
}

func TestStatsMongoFailureIsNotZeroData(t *testing.T) {
	src := &fakeSource{
		items:        map[string]int64{"org-a": 4},
		processedErr: errors.New("mongodb://user:s3cret@mongo:27017/app: server selection timeout"),
	}
	handler := &Handler{
		gate: membershipGate{auth: stubAuth{identity: authhttp.NewIdentity("user-1", "org-a", []string{"items.read"})}},
		src:  src,
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/dashboard/stats", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "s3cret") || strings.Contains(rec.Body.String(), "itemCount") {
		t.Fatalf("body leaked the failure or disguised it as data: %s", rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["statusCode"] != float64(500) || body["message"] != "Internal server error" {
		t.Fatalf("body = %s", rec.Body.String())
	}
	if _, ok := body["error"]; ok {
		t.Fatalf("production 500 must omit error: %s", rec.Body.String())
	}
}

func TestStatsMySQLFailureIsUnavailable(t *testing.T) {
	src := &fakeSource{itemErr: errors.New("dial tcp: connection refused")}
	handler := &Handler{
		gate: membershipGate{auth: stubAuth{identity: authhttp.NewIdentity("user-1", "org-a", []string{"items.read"})}},
		src:  src,
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/dashboard/stats", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestStatsRequiresItemsRead(t *testing.T) {
	src := &fakeSource{items: map[string]int64{"org-a": 1}}
	handler := &Handler{
		gate: membershipGate{auth: stubAuth{identity: authhttp.NewIdentity("user-1", "org-a", []string{"dashboards.read"})}},
		src:  src,
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/dashboard/stats", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d", rec.Code)
	}
	src.mu.Lock()
	defer src.mu.Unlock()
	if len(src.orgs) != 0 {
		t.Fatalf("forbidden request still queried data: %v", src.orgs)
	}
}
