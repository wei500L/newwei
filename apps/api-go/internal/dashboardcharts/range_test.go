package dashboardcharts

import (
	"net/http/httptest"
	"testing"
	"time"
)

func TestDateContract(t *testing.T) {
	now := time.Date(2026, 10, 9, 14, 0, 0, 0, time.UTC)
	start, end, message := resolveRange(dashboardQuery{}, now)
	if message != "" {
		t.Fatal(message)
	}
	if toISO(start) != "2026-09-09T00:00:00.000Z" || toISO(end) != "2026-10-09T23:59:59.999Z" {
		t.Fatalf("default window %s .. %s", toISO(start), toISO(end))
	}

	query := parseDashboardQuery(httptest.NewRequest("GET", "/api/dashboard/sector-heatmap?start=nope&end=2026-03-01", nil))
	if got := validationMessage(query); got != "start must be a valid ISO 8601 date string" {
		t.Fatalf("iso message = %q", got)
	}
	query = parseDashboardQuery(httptest.NewRequest("GET", "/api/dashboard/sector-heatmap?start=2026-02-31", nil))
	if validationMessage(query) != "" {
		t.Fatal("overflow day still passes ISO validation")
	}
	start, _, message = resolveRange(query, now)
	if message != "" || toISO(start) != "2026-03-03T00:00:00.000Z" {
		t.Fatalf("feb 31 overflow start=%s message=%q", toISO(start), message)
	}

	query = parseDashboardQuery(httptest.NewRequest("GET", "/api/dashboard/war-map/geojson?start=2026-03-20&end=2026-03-01", nil))
	if _, _, message = resolveRange(query, now); message != "Start must be before end" {
		t.Fatalf("order message = %q", message)
	}
	query = parseDashboardQuery(httptest.NewRequest("GET", "/api/dashboard/sector-heatmap?start=2026-03-15T23:00:00Z&end=2026-03-15T01:00:00Z", nil))
	start, end, message = resolveRange(query, now)
	if message != "" || toISO(start) != "2026-03-15T00:00:00.000Z" || toISO(end) != "2026-03-15T23:59:59.999Z" {
		t.Fatalf("same utc day start=%s end=%s message=%q", toISO(start), toISO(end), message)
	}

	query = parseDashboardQuery(httptest.NewRequest("GET", "/api/dashboard/sector-heatmap?orgId=org-b&start=2026-03-01", nil))
	if got := validationMessage(query); got != "property orgId should not exist" {
		t.Fatalf("unknown query = %q", got)
	}
	parsed, ok := parseJSDate("2026-03-01T12:00:00+08:00")
	if !ok || toISO(parsed) != "2026-03-01T04:00:00.000Z" {
		t.Fatalf("offset parse = %s ok=%v", toISO(parsed), ok)
	}
	parsed, ok = parseJSDate("2026-02-31T12:00:00.000Z")
	if !ok || toISO(parsed) != "2026-03-03T12:00:00.000Z" {
		t.Fatalf("datetime overflow = %s ok=%v", toISO(parsed), ok)
	}
}
