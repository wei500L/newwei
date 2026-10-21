package legacyproxy

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/metrics"
)

// legacyProxyCounterValue reads one series of api_go_legacy_proxy_requests_total
// from the process registry. The cutover runbook asserts this counter is zero
// before NestJS is stopped, so the series name, label name and label value are
// part of the operational contract.
func legacyProxyCounterValue(t *testing.T, routePrefix string) float64 {
	t.Helper()
	needle := `api_go_legacy_proxy_requests_total{route_prefix="` + routePrefix + `"}`
	for _, line := range strings.Split(metrics.Render(), "\n") {
		if !strings.HasPrefix(line, needle) {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 {
			t.Fatalf("unexpected exposition line %q", line)
		}
		value, err := strconv.ParseFloat(fields[1], 64)
		if err != nil {
			t.Fatalf("parse counter value from %q: %v", line, err)
		}
		return value
	}
	return 0
}

func TestLegacyRoutePrefixIsBoundedByRouteFamily(t *testing.T) {
	cases := map[string]string{
		"/api/crawl/tasks/123": "/api/crawl",
		"/api/healthz/live":    "/api/healthz",
		"/api":                 "/api",
		"/api/":                "/api",
		"/graphql":             "/graphql",
		"/socket.io":           "/socket.io",
		"/docs":                "/docs",
		"/admin/queues":        "/admin",
		"/":                    "/",
		"":                     "/",
	}
	for path, want := range cases {
		if got := legacyRoutePrefix(path); got != want {
			t.Errorf("legacyRoutePrefix(%q) = %q, want %q", path, got, want)
		}
	}
}

// TestLegacyProxyCounterCountsOnlyForwardedRequests anchors the T5.6 metric:
// a request that falls through to NestJS increments the family, while a request
// served by a Go handler on the same gateway does not.
func TestLegacyProxyCounterCountsOnlyForwardedRequests(t *testing.T) {
	legacy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer legacy.Close()

	rules := []Rule{
		{Prefix: "/api/", Mode: ModeLegacy},
		{Prefix: "/api/cutover-metric-go", Mode: ModeGo, Exact: true, Methods: map[string]bool{http.MethodGet: true}},
	}
	gateway, err := New(legacy.URL, rules)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	goServed := 0
	gateway.RegisterGoHandler("/api/cutover-metric-go", func(w http.ResponseWriter, _ *http.Request) {
		goServed++
		w.WriteHeader(http.StatusOK)
	})

	legacyPrefix := "/api/cutover-metric-probe"
	before := legacyProxyCounterValue(t, legacyPrefix)
	gateway.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, legacyPrefix+"/items/1", nil))
	after := legacyProxyCounterValue(t, legacyPrefix)
	if after != before+1 {
		t.Fatalf("legacy counter for %s = %v, want %v after one forwarded request", legacyPrefix, after, before+1)
	}

	goPrefix := "/api/cutover-metric-go"
	goBefore := legacyProxyCounterValue(t, goPrefix)
	gateway.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, goPrefix, nil))
	if goServed != 1 {
		t.Fatalf("Go handler served %d requests, want 1", goServed)
	}
	if goAfter := legacyProxyCounterValue(t, goPrefix); goAfter != goBefore {
		t.Fatalf("legacy counter for %s changed from %v to %v for a Go-served request", goPrefix, goBefore, goAfter)
	}
}
