package itemsreading

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/metrics"
)

// searchMetricsLines returns the rendered integration_events_total series.
func searchMetricsLines() []string {
	var lines []string
	for _, line := range strings.Split(metrics.Render(), "\n") {
		if strings.HasPrefix(line, "integration_events_total{") {
			lines = append(lines, line)
		}
	}
	return lines
}

// counterValue returns the exposition value of the one series carrying every
// fragment, or 0 when no such series exists yet. Parsing the value instead of
// counting lines lets a test assert an exact delta on a shared process registry.
func counterValue(t *testing.T, fragments ...string) float64 {
	t.Helper()
	for _, line := range searchMetricsLines() {
		matched := true
		for _, fragment := range fragments {
			if !strings.Contains(line, fragment) {
				matched = false
				break
			}
		}
		if !matched {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 {
			t.Fatalf("unexpected exposition line %q", line)
		}
		value, err := strconv.ParseFloat(fields[1], 64)
		if err != nil {
			t.Fatalf("parse counter value in %q: %v", line, err)
		}
		return value
	}
	return 0
}

// esServer is a minimal Elasticsearch _search endpoint. A non-2xx status makes the
// search fail the way a real cluster error does.
func esServer(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/items-current/_search" {
			t.Errorf("unexpected ES path %q", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
}

// TestSearchRecordsTheSuccessIntegrationEvent drives the real Search method against
// a test server and asserts the production call site produced the exact NestJS
// label triple.
func TestSearchRecordsTheSuccessIntegrationEvent(t *testing.T) {
	server := esServer(t, http.StatusOK, `{"hits":{"hits":[{"_score":1,"_source":{"itemMetaId":"item-1"}}]}}`)
	defer server.Close()
	searcher := &elasticSearcher{
		node:   server.URL,
		alias:  "items-current",
		client: server.Client(),
	}
	before := counterValue(t, `integration="elasticsearch"`, `operation="items_search"`, `status="success"`)
	hits, err := searcher.Search(context.Background(), "org-1", "climate", 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 1 || hits[0].ID != "item-1" {
		t.Fatalf("hits = %+v, want one item-1", hits)
	}
	after := counterValue(t, `integration="elasticsearch"`, `operation="items_search"`, `status="success"`)
	if after != before+1 {
		t.Fatalf("success counter went %v -> %v, want exactly one new sample", before, after)
	}
}

// TestSearchRecordsTheFailureIntegrationEvent covers the failure shapes the NestJS
// catch block covers: a non-2xx response and an unparseable body.
func TestSearchRecordsTheFailureIntegrationEvent(t *testing.T) {
	t.Run("non-2xx status", func(t *testing.T) {
		server := esServer(t, http.StatusInternalServerError, `{"error":"boom"}`)
		defer server.Close()
		searcher := &elasticSearcher{node: server.URL, alias: "items-current", client: server.Client()}
		before := counterValue(t, `integration="elasticsearch"`, `operation="items_search"`, `status="failure"`)
		if hits, err := searcher.Search(context.Background(), "org-1", "climate", 10); err != nil || hits != nil {
			t.Fatalf("Search = (%v, %v), want (nil, nil) like NestJS", hits, err)
		}
		after := counterValue(t, `integration="elasticsearch"`, `operation="items_search"`, `status="failure"`)
		if after != before+1 {
			t.Fatalf("failure counter went %v -> %v, want one new sample", before, after)
		}
	})
	t.Run("unparseable body", func(t *testing.T) {
		server := esServer(t, http.StatusOK, `not json`)
		defer server.Close()
		searcher := &elasticSearcher{node: server.URL, alias: "items-current", client: server.Client()}
		before := counterValue(t, `integration="elasticsearch"`, `operation="items_search"`, `status="failure"`)
		_, _ = searcher.Search(context.Background(), "org-1", "climate", 10)
		after := counterValue(t, `integration="elasticsearch"`, `operation="items_search"`, `status="failure"`)
		if after != before+1 {
			t.Fatalf("failure counter went %v -> %v, want one new sample", before, after)
		}
	})
}

// TestSearchDoesNotRecordSkippedCalls proves the two early returns (no client, blank
// query) produce no sample: NestJS returns before its try block for the blank query,
// so counting it would inflate the series.
func TestSearchDoesNotRecordSkippedCalls(t *testing.T) {
	before := len(searchMetricsLines())
	var nilSearcher *elasticSearcher
	_, _ = nilSearcher.Search(context.Background(), "org-1", "climate", 10)
	blank := &elasticSearcher{node: "http://unused.invalid", alias: "items-current", client: &http.Client{}}
	_, _ = blank.Search(context.Background(), "org-1", "   ", 10)
	if after := len(searchMetricsLines()); after != before {
		t.Fatalf("a skipped call added %d integration series", after-before)
	}
}
