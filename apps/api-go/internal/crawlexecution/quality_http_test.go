package crawlexecution

// Publish-signal probes: HTML head extraction, the soft-limit reader and the
// enrichment loop. The outbound fetch is injected so the probes run against an
// httptest server; the production path keeps the shared SSRF guard.

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestExtractPublishSignalFromHTMLMeta(t *testing.T) {
	document := `<html><head>` +
		`<meta property="og:published_time" content="2026-10-19T10:00:00Z">` +
		`<meta property="article:published_time" content="2026-10-18T10:00:00Z">` +
		`</head><body></body></html>`
	signal, ok := extractPublishSignalFromHTML(document, true)
	if !ok || signal.Source != publishTimeSourceMeta || signal.Confidence != 0.95 {
		t.Fatalf("signal = %#v, ok = %v", signal, ok)
	}
	want := time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC).UnixMilli()
	if signal.Timestamp == nil || *signal.Timestamp != want {
		t.Fatalf("timestamp = %#v", signal.Timestamp)
	}
}

func TestExtractPublishSignalFromHTMLJSONLD(t *testing.T) {
	document := `<html><head><script type="application/ld+json">` +
		`{"@type":"NewsArticle","datePublished":"2026-10-17T09:30:00Z"}` +
		`</script></head><body></body></html>`
	signal, ok := extractPublishSignalFromHTML(document, true)
	if !ok || signal.Source != publishTimeSourceJSONLD || signal.Confidence != 0.92 {
		t.Fatalf("signal = %#v, ok = %v", signal, ok)
	}
	// An invalid JSON-LD script is skipped, not fatal.
	if _, ok := extractPublishSignalFromHTML(
		`<html><head><script type="application/ld+json">{not json}</script></head></html>`, true); ok {
		t.Fatal("invalid JSON-LD must not produce a signal")
	}
}

func TestExtractPublishSignalFromHTMLTimeTag(t *testing.T) {
	document := `<html><head></head><body><time datetime="2026-10-16T08:00:00Z">yesterday</time></body></html>`
	signal, ok := extractPublishSignalFromHTML(document, true)
	if !ok || signal.Source != publishTimeSourceTimeTag || signal.Confidence != 0.88 {
		t.Fatalf("signal = %#v, ok = %v", signal, ok)
	}
	if _, ok := extractPublishSignalFromHTML(document, false); ok {
		t.Fatal("the head probe must ignore time tags")
	}
	if _, ok := extractPublishSignalFromHTML(`<html><head></head><body>plain</body></html>`, true); ok {
		t.Fatal("no publish signal must report not found")
	}
}

func TestReadPublishSignalHTMLEarlyStopsAfterHeadSignal(t *testing.T) {
	head := `<html><head><meta property="article:published_time" content="2026-10-19T10:00:00Z"></head>`
	body := strings.Repeat("x", 40_000)
	reader := strings.NewReader(head + "<body>" + body + "</body></html>")
	document, truncated, earlyStopped := readPublishSignalHTML(reader, 1_000_000)
	if !earlyStopped || truncated {
		t.Fatalf("earlyStopped = %v, truncated = %v", earlyStopped, truncated)
	}
	if len(document) >= len(head)+len(body) {
		t.Fatalf("document length = %d", len(document))
	}
	if !strings.Contains(document, "</head>") {
		t.Fatal("the early stop must keep the closed head")
	}
}

func TestReadPublishSignalHTMLTruncatesAtLimit(t *testing.T) {
	document := strings.Repeat("y", 100_000)
	read, truncated, earlyStopped := readPublishSignalHTML(strings.NewReader(document), publishSignalMinReadBytes)
	if !truncated || earlyStopped {
		t.Fatalf("truncated = %v, earlyStopped = %v", truncated, earlyStopped)
	}
	if len(read) != publishSignalMinReadBytes {
		t.Fatalf("read bytes = %d", len(read))
	}
}

func TestResolvePublishSignalTopK(t *testing.T) {
	if got := resolvePublishSignalTopK(5, 12, 0); got != 0 {
		t.Fatalf("empty pool = %d", got)
	}
	if got := resolvePublishSignalTopK(5, 12, 40); got != 12 {
		t.Fatalf("topK = %d", got)
	}
	if got := resolvePublishSignalTopK(2, 4, 40); got != 4 {
		t.Fatalf("min topK = %d", got)
	}
	if got := resolvePublishSignalTopK(30, 12, 40); got != 18 {
		t.Fatalf("max topK = %d", got)
	}
	if got := resolvePublishSignalTopK(5, 12, 3); got != 3 {
		t.Fatalf("pool-bounded topK = %d", got)
	}
}

func TestPublishSignalSettingsResolution(t *testing.T) {
	if got := resolvePublishSignalFetchTimeoutMs(0, 0); got != defaultPublishSignalHeadFetchTimeoutMs {
		t.Fatalf("default timeout = %d", got)
	}
	if got := resolvePublishSignalFetchTimeoutMs(1_500, 800); got != 800 {
		t.Fatalf("request-bounded timeout = %d", got)
	}
	if got := resolvePublishSignalFetchTimeoutMs(100, 0); got != 500 {
		t.Fatalf("minimum timeout = %d", got)
	}
	if got := resolvePublishSignalFetchTimeoutMs(60_000, 0); got != 10_000 {
		t.Fatalf("maximum timeout = %d", got)
	}
	if got := resolvePublishSignalFetchConcurrency(0); got != defaultPublishSignalHeadFetchConcurrency {
		t.Fatalf("default concurrency = %d", got)
	}
	if got := resolvePublishSignalFetchConcurrency(50); got != 8 {
		t.Fatalf("maximum concurrency = %d", got)
	}
	if got := resolvePublishSignalMaxReadBytes(0); got != defaultPublishSignalHeadFetchMaxReadBytes {
		t.Fatalf("default max bytes = %d", got)
	}
	if got := resolvePublishSignalMaxReadBytes(1); got != 1_048_576 {
		t.Fatalf("minimum max bytes = %d", got)
	}
}

// newPublishSignalTestService builds a service whose probe fetch bypasses the
// SSRF guard so the probes can target an httptest server.
func newPublishSignalTestService(t *testing.T, server *httptest.Server) *Service {
	t.Helper()
	client := server.Client()
	service := New(Options{Now: fixedNow})
	service.publishSignalFetch = func(ctx context.Context, targetURL string, timeoutMs int) (*http.Response, bool) {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
		if err != nil {
			return nil, false
		}
		response, err := client.Do(request)
		if err != nil {
			return nil, false
		}
		return response, true
	}
	return service
}

func TestEnrichCandidatePublishSignals(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/with-meta":
			writer.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = io.WriteString(writer, `<html><head><meta property="article:published_time" content="2026-10-19T10:00:00Z"></head><body>story</body></html>`)
		case "/not-found":
			writer.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(writer, "missing")
		case "/json":
			writer.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(writer, `{"ok":true}`)
		default:
			writer.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer server.Close()
	service := newPublishSignalTestService(t, server)

	result := service.enrichCandidatePublishSignals(context.Background(), []string{
		server.URL + "/with-meta",
		server.URL + "/not-found",
		server.URL + "/json",
		server.URL + "/with-meta",
		"   ",
	}, 0, defaultPublishSignalSettings())

	if result.Attempted != 3 || result.Succeeded != 1 || result.Failed != 2 {
		t.Fatalf("counts = %#v", result)
	}
	if result.SoftFailures.HTTPStatus != 1 || result.SoftFailures.NonHTML != 1 {
		t.Fatalf("soft failures = %#v", result.SoftFailures)
	}
	if result.softFailureCount() != 2 {
		t.Fatalf("soft failure count = %d", result.softFailureCount())
	}
	signal, ok := result.Signals[server.URL+"/with-meta"]
	if !ok || signal.Source != publishTimeSourceMeta {
		t.Fatalf("signals = %#v", result.Signals)
	}
	if result.EffectiveTimeoutMs != defaultPublishSignalHeadFetchTimeoutMs {
		t.Fatalf("effective timeout = %d", result.EffectiveTimeoutMs)
	}
	// Three unique URLs but the configured concurrency is two, so the effective
	// concurrency stays two.
	if result.EffectiveConcurrency != defaultPublishSignalHeadFetchConcurrency {
		t.Fatalf("effective concurrency = %d", result.EffectiveConcurrency)
	}
}

func TestEnrichCandidatePublishSignalsEmptyInput(t *testing.T) {
	service := New(Options{Now: fixedNow})
	result := service.enrichCandidatePublishSignals(context.Background(), nil, 0, defaultPublishSignalSettings())
	if result.Attempted != 0 || len(result.Signals) != 0 || result.Skipped {
		t.Fatalf("result = %#v", result)
	}
}

func TestFetchCandidatePublishSignalSoftFailures(t *testing.T) {
	service := New(Options{Now: fixedNow})
	service.publishSignalFetch = func(context.Context, string, int) (*http.Response, bool) {
		return nil, false
	}
	if _, ok, truncated, earlyStopped, reason := service.fetchCandidatePublishSignal(context.Background(), "https://example.com", 100, 0); ok || truncated || earlyStopped || reason != "network_or_timeout" {
		t.Fatalf("network failure = %v/%v/%v/%q", ok, truncated, earlyStopped, reason)
	}
	service.publishSignalFetch = func(context.Context, string, int) (*http.Response, bool) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"text/html"}},
			Body:       io.NopCloser(strings.NewReader("")),
		}, true
	}
	if _, ok, _, _, reason := service.fetchCandidatePublishSignal(context.Background(), "https://example.com", 100, 0); ok || reason != "empty_html" {
		t.Fatalf("empty html = %v/%q", ok, reason)
	}
	service.publishSignalFetch = func(context.Context, string, int) (*http.Response, bool) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"text/html"}},
			Body:       io.NopCloser(strings.NewReader("<html><head></head><body>no date</body></html>")),
		}, true
	}
	if _, ok, _, _, reason := service.fetchCandidatePublishSignal(context.Background(), "https://example.com", 100, 0); ok || reason != "no_publish_signal" {
		t.Fatalf("no signal = %v/%q", ok, reason)
	}
}

func TestResolveCandidatePublishSignalPrefersStrongerSignal(t *testing.T) {
	url := "https://news.example.com/2026/10/19/story"
	pathSignal := resolveCandidatePublishSignal(url, nil)
	if pathSignal.Source != publishTimeSourceURLPath || pathSignal.Confidence != 0.82 || pathSignal.Timestamp == nil {
		t.Fatalf("path signal = %#v", pathSignal)
	}
	timestamp := time.Date(2026, 10, 19, 10, 0, 0, 0, time.UTC).UnixMilli()
	weaker := publishCandidateSignal{Confidence: 0.6, Source: publishTimeSourceMeta, Timestamp: &timestamp}
	if got := resolveCandidatePublishSignal(url, &weaker); got.Source != publishTimeSourceURLPath {
		t.Fatalf("weaker enriched signal must lose: %#v", got)
	}
	stronger := publishCandidateSignal{Confidence: 0.95, Source: publishTimeSourceMeta, Timestamp: &timestamp}
	if got := resolveCandidatePublishSignal(url, &stronger); got.Source != publishTimeSourceMeta || got.Confidence != 0.95 {
		t.Fatalf("stronger enriched signal must win: %#v", got)
	}
	// A URL without a date keeps the lowest URL-path confidence.
	if got := resolveCandidatePublishSignal("https://news.example.com/story", nil); got.Confidence != 0.38 {
		t.Fatalf("plain url confidence = %v", got.Confidence)
	}
}

func TestBuildDetailCandidateConfidenceBuckets(t *testing.T) {
	signals := map[string]publishCandidateSignal{
		"https://news.example.com/a": {Confidence: 0.2, Source: publishTimeSourceMeta},
		"https://news.example.com/b": {Confidence: 0.5, Source: publishTimeSourceMeta},
		"https://news.example.com/c": {Confidence: 0.7, Source: publishTimeSourceMeta},
		"https://news.example.com/d": {Confidence: 0.9, Source: publishTimeSourceMeta},
	}
	buckets := buildDetailCandidateConfidenceBuckets(signals, []string{
		"https://news.example.com/a",
		"https://news.example.com/b",
		"https://news.example.com/c",
		"https://news.example.com/d",
	})
	if buckets.LT04 != 1 || buckets.From04To06 != 1 || buckets.From06To08 != 1 || buckets.GTE08 != 1 {
		t.Fatalf("buckets = %#v", buckets)
	}
}

func TestEnrichCandidatePublishSignalsRunsProbesConcurrently(t *testing.T) {
	var inFlight int32
	peak := int32(0)
	var mutex sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mutex.Lock()
		inFlight++
		if inFlight > peak {
			peak = inFlight
		}
		mutex.Unlock()
		time.Sleep(20 * time.Millisecond)
		mutex.Lock()
		inFlight--
		mutex.Unlock()
		writer.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(writer, `<html><head><meta property="article:published_time" content="2026-10-19T10:00:00Z"></head></html>`)
	}))
	defer server.Close()
	service := newPublishSignalTestService(t, server)
	result := service.enrichCandidatePublishSignals(context.Background(), []string{
		server.URL + "/a",
		server.URL + "/b",
		server.URL + "/c",
		server.URL + "/d",
	}, 0, publishSignalSettings{Concurrency: 4})
	if result.Succeeded != 4 {
		t.Fatalf("succeeded = %d", result.Succeeded)
	}
	if peak < 2 {
		t.Fatalf("peak concurrent probes = %d, want at least 2", peak)
	}
}
