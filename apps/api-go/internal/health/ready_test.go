package health

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

type recordingHuman struct {
	calls atomic.Int32
}

func (h *recordingHuman) Authenticate(http.ResponseWriter, *http.Request) *authhttp.Identity {
	h.calls.Add(1)
	return authhttp.NewIdentity("user-1", "org-1", nil)
}

type memoryMachines struct {
	record   machineRecord
	found    bool
	err      error
	touch    error
	seen     string
	seenHash string
	used     atomic.Int32
}

func (m *memoryMachines) Find(_ context.Context, tokenHash string) (machineRecord, bool, error) {
	m.seenHash = tokenHash
	return m.record, m.found, m.err
}

func (m *memoryMachines) Touch(_ context.Context, id string, _ time.Time) error {
	m.seen = id
	m.used.Add(1)
	return m.touch
}

func TestReadyAssemblyKeepsFailuresAndCaches(t *testing.T) {
	var calls atomic.Int32
	fixed := time.Date(2026, 10, 10, 16, 0, 0, 0, time.UTC)
	handler := &ReadyHandler{
		gate: Gate{humans: &recordingHuman{}},
		run: func(context.Context) []outcome {
			calls.Add(1)
			return []outcome{
				up(probeMySQL),
				up(probeRedis),
				up(probeMongo),
				down(probeCrawl, "crawl4ai health check failed"),
				{name: probeSSRF, up: false, value: `{"status":"down","durationMs":0,"message":"crawl4ai SSRF proxy is not configured"}`},
				down(probeLLM, "LLM gateway completion model is not configured in MySQL profiles"),
				up(probeDisk),
			}
		},
		now:     func() time.Time { return fixed },
		version: APIVersion,
	}
	req := httptest.NewRequest(http.MethodGet, ReadyPath, nil)
	req.Header.Set("Authorization", "Bearer human-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, part := range []string{
		`"status":"error"`,
		`"version":"0.1.0"`,
		`"now":"2026-10-10T16:00:00.000Z"`,
		`"mysql":{"status":"up"}`,
		`"crawl4ai":{"status":"down"`,
		`"crawl4aiSsrfProxy"`,
		"not configured",
	} {
		if !strings.Contains(body, part) {
			t.Fatalf("body missing %s: %s", part, body)
		}
	}
	if strings.Contains(body, `"status":"ok"`) {
		t.Fatalf("failure was reported as ok: %s", body)
	}
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if calls.Load() != 1 {
		t.Fatalf("cache missed, calls=%d", calls.Load())
	}
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("cached status = %d", rec.Code)
	}
}

func TestMachineTokenBoundary(t *testing.T) {
	token := "mtk_metrics-only"
	sum := sha256.Sum256([]byte(token))
	wantHash := hex.EncodeToString(sum[:])
	store := &memoryMachines{found: true, record: machineRecord{ID: "mat-1", OrgActive: true}}
	humans := &recordingHuman{}
	handler := &ReadyHandler{
		gate:    Gate{humans: humans, machines: store},
		run:     func(context.Context) []outcome { return []outcome{up(probeMySQL), up(probeRedis), up(probeMongo), up(probeCrawl), up(probeSSRF), up(probeLLM), up(probeDisk)} },
		now:     time.Now,
		version: APIVersion,
	}

	okReq := httptest.NewRequest(http.MethodGet, ReadyPath, nil)
	okReq.Header.Set("Authorization", "Bearer "+token)
	okRec := httptest.NewRecorder()
	handler.ServeHTTP(okRec, okReq)
	if okRec.Code != http.StatusOK {
		t.Fatalf("valid machine token status=%d body=%s", okRec.Code, okRec.Body.String())
	}
	if humans.calls.Load() != 0 {
		t.Fatal("machine token was treated as a JWT")
	}
	if store.seen != "mat-1" || store.used.Load() != 1 || store.seenHash != wantHash {
		t.Fatalf("touch id=%s used=%d hash=%s", store.seen, store.used.Load(), store.seenHash)
	}
	if strings.Contains(okRec.Body.String(), "dashboards.read") || strings.Contains(okRec.Body.String(), "metrics.read") {
		t.Fatalf("token permissions leaked: %s", okRec.Body.String())
	}

	store.record.RevokedAt = sql.NullTime{Time: time.Now().Add(-time.Minute), Valid: true}
	revoked := httptest.NewRecorder()
	handler.cached = nil
	handler.ServeHTTP(revoked, okReq)
	if revoked.Code != http.StatusUnauthorized || !strings.Contains(revoked.Body.String(), "Invalid machine token") {
		t.Fatalf("revoked status=%d body=%s", revoked.Code, revoked.Body.String())
	}

	store.record.RevokedAt = sql.NullTime{}
	store.record.ExpiresAt = sql.NullTime{Time: time.Now().Add(-time.Second), Valid: true}
	expired := httptest.NewRecorder()
	handler.ServeHTTP(expired, okReq)
	if expired.Code != http.StatusUnauthorized {
		t.Fatalf("expired status=%d body=%s", expired.Code, expired.Body.String())
	}

	store.record.ExpiresAt = sql.NullTime{}
	store.record.OrgActive = false
	inactive := httptest.NewRecorder()
	handler.ServeHTTP(inactive, okReq)
	if inactive.Code != http.StatusUnauthorized {
		t.Fatalf("inactive org status=%d", inactive.Code)
	}

	store.found = false
	store.record.OrgActive = true
	missing := httptest.NewRecorder()
	handler.ServeHTTP(missing, okReq)
	if missing.Code != http.StatusUnauthorized {
		t.Fatalf("missing token status=%d", missing.Code)
	}

	store.touch = sql.ErrConnDone
	store.found = true
	store.record = machineRecord{ID: "mat-1", OrgActive: true}
	handler.cached = nil
	touched := httptest.NewRecorder()
	handler.ServeHTTP(touched, okReq)
	if touched.Code != http.StatusOK {
		t.Fatalf("touch failure should still allow healthz, status=%d body=%s", touched.Code, touched.Body.String())
	}
}

func TestHumanTokenDoesNotNeedDashboardPermission(t *testing.T) {
	humans := &recordingHuman{}
	handler := &ReadyHandler{
		gate:    Gate{humans: humans, machines: &memoryMachines{}},
		run:     func(context.Context) []outcome { return []outcome{up(probeDisk)} },
		now:     time.Now,
		version: APIVersion,
	}
	req := httptest.NewRequest(http.MethodGet, ReadyPath, nil)
	req.Header.Set("Authorization", "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if humans.calls.Load() != 1 {
		t.Fatalf("human auth calls=%d", humans.calls.Load())
	}
	if !strings.Contains(rec.Body.String(), `"status":"error"`) {
		t.Fatalf("partial probes were not an error: %s", rec.Body.String())
	}
}

func TestCRC16MatchesRedis(t *testing.T) {
	if got := crc16([]byte("123456789")); got != 0x31C3 {
		t.Fatalf("crc16 = %x", got)
	}
}

func TestScrubProxyRemovesAddress(t *testing.T) {
	got := scrubProxy("dial tcp proxy.internal:8888 via http://user:pass@10.0.0.8:8888", "http://user:pass@10.0.0.8:8888")
	if strings.Contains(got, "10.0.0.8") || strings.Contains(got, "pass") || strings.Contains(got, "://") {
		t.Fatalf("secret leaked: %s", got)
	}
}
