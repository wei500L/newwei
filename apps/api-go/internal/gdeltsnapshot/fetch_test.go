package gdeltsnapshot

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func newFetchRig(t *testing.T, category Category, response gdeltStubResponse, timeout time.Duration) (*gdeltFetcher, *gdeltStubServer) {
	t.Helper()
	stub := newGdeltStubServer(t, map[Category]gdeltStubResponse{category: response})
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	fetcher := newGDeltFetcher(func() time.Time { return now })
	fetcher.doc2URL = stub.server.URL
	if timeout > 0 {
		fetcher.timeout = timeout
	}
	return fetcher, stub
}

// TestFetchCategoryParsesArticles pins the field mapping of one successful
// response: domain wins over source, a blank domain does NOT fall through to
// source, a missing domain does, duplicate links are dropped and the seendate is
// parsed as UTC.
func TestFetchCategoryParsesArticles(t *testing.T) {
	body := `{"articles":[
      {"url":"https://example.com/a","title":"  Alpha  ","domain":"alpha.example","seendate":"20261020T101112Z"},
      {"url":"https://example.com/b","title":"Beta","domain":"","source":"fallback.example","seendate":"20261020T101112Z"},
      {"url":"https://example.com/c","title":"Gamma","source":"source.example","seendate":"bad-date"},
      {"url":"https://example.com/a","title":"Duplicate","domain":"alpha.example","seendate":"20261020T101112Z"},
      {"url":"https://example.com/d","title":42,"domain":"alpha.example","seendate":"20261020T101112Z"},
      {"title":"No link","domain":"alpha.example"}
    ]}`
	fetcher, _ := newFetchRig(t, CategoryPolitics, gdeltStubResponse{status: http.StatusOK, body: body}, 0)

	outcome := fetcher.fetchCategory(context.Background(), CategoryPolitics, categoryLimit)
	if outcome.warning != nil {
		t.Fatalf("warning = %+v, want none", *outcome.warning)
	}
	if len(outcome.headlines) != 3 {
		t.Fatalf("headlines = %d, want 3", len(outcome.headlines))
	}
	first := outcome.headlines[0]
	if first.ID != "gdelt:https://example.com/a" || first.Title != "Alpha" || first.Link != "https://example.com/a" {
		t.Errorf("first headline = %+v", first)
	}
	if first.Source != "alpha.example" {
		t.Errorf("first source = %q, want alpha.example", first.Source)
	}
	if first.Category != CategoryPolitics || first.Origin != "gdelt" || first.IsAlert {
		t.Errorf("first headline metadata = %+v", first)
	}
	wantTimestamp := time.Date(2026, 10, 20, 10, 11, 12, 0, time.UTC).UnixMilli()
	if first.Timestamp != wantTimestamp {
		t.Errorf("first timestamp = %d, want %d", first.Timestamp, wantTimestamp)
	}
	if outcome.headlines[1].Source != "GDELT" {
		t.Errorf("blank domain source = %q, want GDELT (?? does not fall through on empty string)", outcome.headlines[1].Source)
	}
	if outcome.headlines[2].Source != "source.example" {
		t.Errorf("missing domain source = %q, want source.example", outcome.headlines[2].Source)
	}
}

// TestFetchCategoryClassifiesFailures covers the four warning codes and their
// severity/message/detail.
func TestFetchCategoryClassifiesFailures(t *testing.T) {
	cases := []struct {
		name         string
		response     gdeltStubResponse
		wantCode     string
		wantSeverity string
		wantDetail   string
		// anyDetail covers the decode failure: the detail text is the
		// implementation's JSON error, like the Node SyntaxError text.
		anyDetail bool
	}{
		{
			name:         "rate limited",
			response:     gdeltStubResponse{status: http.StatusTooManyRequests},
			wantCode:     codeRateLimited,
			wantSeverity: severityWarning,
			wantDetail:   "HTTP 429",
		},
		{
			name:         "http error",
			response:     gdeltStubResponse{status: http.StatusInternalServerError},
			wantCode:     codeHTTPError,
			wantSeverity: severityWarning,
		},
		{
			name:         "invalid body",
			response:     gdeltStubResponse{status: http.StatusOK, body: "<html>not json</html>"},
			wantCode:     codeFetchFailed,
			wantSeverity: severityWarning,
			anyDetail:    true,
		},
		{
			name:         "empty list",
			response:     gdeltStubResponse{status: http.StatusOK, body: `{"articles":[]}`},
			wantCode:     codeEmpty,
			wantSeverity: severityInfo,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fetcher, _ := newFetchRig(t, CategoryTech, testCase.response, 0)
			outcome := fetcher.fetchCategory(context.Background(), CategoryTech, categoryLimit)
			if len(outcome.headlines) != 0 {
				t.Fatalf("headlines = %d, want 0", len(outcome.headlines))
			}
			if outcome.warning == nil {
				t.Fatal("warning = nil")
			}
			if outcome.warning.Code != testCase.wantCode {
				t.Errorf("code = %q, want %q", outcome.warning.Code, testCase.wantCode)
			}
			if outcome.warning.Severity != testCase.wantSeverity {
				t.Errorf("severity = %q, want %q", outcome.warning.Severity, testCase.wantSeverity)
			}
			if testCase.anyDetail {
				if outcome.warning.Detail == "" {
					t.Error("detail is empty, want the decode error text")
				}
			} else if outcome.warning.Detail != testCase.wantDetail {
				t.Errorf("detail = %q, want %q", outcome.warning.Detail, testCase.wantDetail)
			}
		})
	}
}

// TestFetchCategoryTimeoutRetriesOnceWithIPv4 locks the fallback semantics: a
// timed-out attempt is retried exactly once (IPv4) and both attempts share the
// message shape of the NestJS timeout error.
func TestFetchCategoryTimeoutRetriesOnceWithIPv4(t *testing.T) {
	fetcher, stub := newFetchRig(t, CategoryAI, gdeltStubResponse{
		status: http.StatusOK,
		body:   `{"articles":[]}`,
		delay:  300 * time.Millisecond,
	}, 60*time.Millisecond)

	outcome := fetcher.fetchCategory(context.Background(), CategoryAI, categoryLimit)
	if outcome.warning == nil || outcome.warning.Code != codeFetchFailed {
		t.Fatalf("warning = %+v, want gdelt_fetch_failed", outcome.warning)
	}
	if outcome.warning.Detail != "Network request timed out after 60ms" {
		t.Errorf("detail = %q", outcome.warning.Detail)
	}
	if got := stub.requestCount(); got != 2 {
		t.Errorf("attempts = %d, want 2 (primary + one IPv4 fallback)", got)
	}
}

// TestFetchCategoryCallerCancellationIsNotRetried proves a shutdown abort is not
// turned into an IPv4 retry: the caller context is cancelled while the first
// request is in flight, so exactly one attempt reaches the server.
func TestFetchCategoryCallerCancellationIsNotRetried(t *testing.T) {
	fetcher, stub := newFetchRig(t, CategoryAI, gdeltStubResponse{
		status: http.StatusOK,
		body:   `{"articles":[]}`,
		delay:  300 * time.Millisecond,
	}, 5*time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan fetchOutcome, 1)
	go func() { done <- fetcher.fetchCategory(ctx, CategoryAI, categoryLimit) }()
	select {
	case <-stub.started:
	case <-time.After(5 * time.Second):
		t.Fatal("the first request never reached the stub server")
	}
	cancel()

	outcome := <-done
	if outcome.warning == nil || outcome.warning.Code != codeFetchFailed {
		t.Fatalf("warning = %+v, want gdelt_fetch_failed", outcome.warning)
	}
	if got := stub.requestCount(); got != 1 {
		t.Errorf("attempts = %d, want 1", got)
	}
}

// TestFetchCategoryCapsRecordsAndKeepsParameterOrder pins the request line: the
// per-category limit is clamped to GDELT_MAX_RECORDS (25) and to at least 1,
// and the parameters keep the NestJS order.
func TestFetchCategoryCapsRecordsAndKeepsParameterOrder(t *testing.T) {
	fetcher, stub := newFetchRig(t, CategoryGov, gdeltStubResponse{status: http.StatusOK, body: `{"articles":[]}`}, 0)
	ctx := context.Background()

	if outcome := fetcher.fetchCategory(ctx, CategoryGov, 100); outcome.warning == nil || outcome.warning.Code != codeEmpty {
		t.Fatalf("warning = %+v, want gdelt_empty for the stub body", outcome.warning)
	}
	if outcome := fetcher.fetchCategory(ctx, CategoryGov, 0); outcome.warning == nil || outcome.warning.Code != codeEmpty {
		t.Fatalf("warning = %+v, want gdelt_empty for the stub body", outcome.warning)
	}
	if len(stub.requests) != 2 {
		t.Fatalf("requests = %d, want 2", len(stub.requests))
	}
	wantParams := "?query=" + url.QueryEscape(categoryQueries[CategoryGov]) +
		"&mode=artlist&maxrecords=25&timespan=24h&format=json&lang=eng"
	if !strings.HasSuffix(stub.requests[0], wantParams) {
		t.Errorf("request = %q\nwant the suffix %q", stub.requests[0], wantParams)
	}
	if !strings.HasSuffix(stub.requests[1], strings.Replace(wantParams, "maxrecords=25", "maxrecords=1", 1)) {
		t.Errorf("request = %q, want maxrecords=1 for a zero limit", stub.requests[1])
	}
}
