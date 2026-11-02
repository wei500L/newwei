package legacyproxy

import (
	"bufio"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/cors"
)

// loadRouteFixture reads "METHOD /path" lines, skipping comments and blanks.
func loadRouteFixture(t *testing.T, path string) [][2]string {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("open route fixture %s: %v", path, err)
	}
	defer file.Close()

	var routes [][2]string
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 {
			t.Fatalf("invalid route fixture line %q", line)
		}
		routes = append(routes, [2]string{strings.ToUpper(fields[0]), fields[1]})
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan route fixture %s: %v", path, err)
	}
	if len(routes) < 100 {
		t.Fatalf("route fixture %s has %d routes; refusing to pass on a truncated list", path, len(routes))
	}
	return routes
}

// concreteRoutePath replaces the ":param" placeholder used by the fixture with
// one non-empty concrete segment so the segment matcher classifies it exactly
// like a real request path.
func concreteRoutePath(path string) string {
	parts := strings.Split(path, "/")
	for i, part := range parts {
		if strings.HasPrefix(part, ":") && len(part) > 1 {
			parts[i] = "x"
		}
	}
	return strings.Join(parts, "/")
}

// TestAllGoCutoverRoutesAreOwnedByGo is the T2 cutover gate: every A-class REST
// route from the ownership audit must match a declared Go rule in the AllRoutes
// table. A route that matches no rule is a real gap in the migration map or the
// rule table.
func TestAllGoCutoverRoutesAreOwnedByGo(t *testing.T) {
	gateway := New(AllRoutes())

	for _, route := range loadRouteFixture(t, "testdata/nest-routes.txt") {
		method, path := route[0], route[1]
		rule, matched := gateway.matchRule(method, concreteRoutePath(path))
		if !matched {
			t.Errorf("%s %s matched no Go rule", method, path)
			continue
		}
		if rule.Prefix == "" {
			t.Errorf("%s %s matched an empty-prefix rule", method, path)
		}
		if rule.Prefix == "/api/" {
			t.Errorf("%s %s matched the generic /api/ catch-all; expected a declared Go rule", method, path)
		}
	}
}

// TestAllGoUnknownPathAnswers404WithoutUpstream is the C-9 cutover gate: a
// request that no rule claims is answered by the gateway itself with the
// NestJS-equivalent 404 and never leaks to another backend (the pure router has
// no upstream at all).
func TestAllGoUnknownPathAnswers404WithoutUpstream(t *testing.T) {
	gateway := New(AllRoutes())
	gateway.SetNotFound(cors.New(""), nil)

	for _, probe := range []struct {
		method string
		target string
	}{
		{http.MethodGet, "/admin/queues"},
		{http.MethodGet, "/api/not-migrated-yet"},
		{http.MethodGet, "/"},
		{http.MethodGet, "/unknown?x=1"},
	} {
		recorder := httptest.NewRecorder()
		gateway.ServeHTTP(recorder, httptest.NewRequest(probe.method, probe.target, nil))
		if recorder.Code != http.StatusNotFound {
			t.Errorf("%s %s status = %d, want 404", probe.method, probe.target, recorder.Code)
			continue
		}
		if got := recorder.Header().Get("x-trace-id"); got == "" {
			t.Errorf("%s %s missing x-trace-id", probe.method, probe.target)
		}
		body := recorder.Body.String()
		if !strings.Contains(body, `"statusCode":404`) || !strings.Contains(body, `"error":"Not Found"`) {
			t.Errorf("%s %s body = %s, want the NestJS 404 body", probe.method, probe.target, body)
		}
		wantPath := strings.SplitN(probe.target, "?", 2)[0]
		if !strings.Contains(body, `"path":"`+wantPath) {
			t.Errorf("%s %s body = %s, want path %q", probe.method, probe.target, body, wantPath)
		}
	}
}

// TestAllGoUnclaimedMethodsAnswer404 proves a method a matched rule does not
// whitelist is still answered with the NestJS 404 instead of being dispatched
// to the Go handler.
func TestAllGoUnclaimedMethodsAnswer404(t *testing.T) {
	gateway := New(AllRoutes())
	gateway.SetNotFound(cors.New(""), nil)

	// /api/metrics is registered GET-only, so POST must not match it.
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/metrics", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("POST /api/metrics status = %d, want 404", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), `"statusCode":404`) {
		t.Fatalf("POST /api/metrics body = %s, want the NestJS 404 body", recorder.Body.String())
	}
}
