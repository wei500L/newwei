package gdeltsnapshot

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ---- in-memory ports ----

// fakeCache is an in-memory cachePort. It records every write so the tests can
// assert keys, TTLs and raw JSON bytes.
type fakeCache struct {
	mu     sync.Mutex
	values map[string]string
	writes []cacheEntry
	getErr error
	setErr error
}

func newFakeCache() *fakeCache {
	return &fakeCache{values: make(map[string]string)}
}

func (c *fakeCache) MGet(_ context.Context, keys ...string) ([]cacheValue, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.getErr != nil {
		return nil, c.getErr
	}
	values := make([]cacheValue, len(keys))
	for index, key := range keys {
		if value, ok := c.values[key]; ok && value != "" {
			values[index] = cacheValue{value: value, found: true}
		}
	}
	return values, nil
}

func (c *fakeCache) SetMany(_ context.Context, entries ...cacheEntry) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.setErr != nil {
		return c.setErr
	}
	for _, entry := range entries {
		c.writes = append(c.writes, entry)
		c.values[entry.key] = string(entry.value)
	}
	return nil
}

func (c *fakeCache) seed(key, value string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.values[key] = value
}

func (c *fakeCache) written(key string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	value, ok := c.values[key]
	return value, ok
}

// fakeStore is an in-memory storePort. The mutex guards the appended rows
// because a scheduler test reads them while a tick goroutine may still write.
type fakeStore struct {
	mu           sync.Mutex
	payload      []byte
	found        bool
	rows         []snapshotRow
	pruned       []time.Time
	aggregates   aggregateRow
	latestErr    error
	insertErr    error
	pruneErr     error
	aggregateErr error
}

// rowCount reports how many history rows have been inserted so far.
func (s *fakeStore) rowCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.rows)
}

func (s *fakeStore) LatestPayload(context.Context) ([]byte, bool, error) {
	if s.latestErr != nil {
		return nil, false, s.latestErr
	}
	return s.payload, s.found, nil
}

func (s *fakeStore) Insert(_ context.Context, row snapshotRow) error {
	if s.insertErr != nil {
		return s.insertErr
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rows = append(s.rows, row)
	return nil
}

func (s *fakeStore) Prune(_ context.Context, cutoff time.Time) (int64, error) {
	if s.pruneErr != nil {
		return 0, s.pruneErr
	}
	s.pruned = append(s.pruned, cutoff)
	return 0, nil
}

func (s *fakeStore) Aggregates(context.Context, time.Time) (aggregateRow, error) {
	if s.aggregateErr != nil {
		return aggregateRow{}, s.aggregateErr
	}
	return s.aggregates, nil
}

// fakeLock is a configurable lockPort.
type fakeLock struct {
	acquired   bool
	acquireErr error
	calls      int
	lastKey    string
	lastTTL    time.Duration
}

func newFakeLock() *fakeLock {
	return &fakeLock{acquired: true}
}

func (l *fakeLock) WithLock(ctx context.Context, key string, ttl time.Duration, runner func(context.Context) error) (bool, error) {
	l.calls++
	l.lastKey = key
	l.lastTTL = ttl
	if l.acquireErr != nil {
		return false, l.acquireErr
	}
	if !l.acquired {
		return false, nil
	}
	return true, runner(ctx)
}

// ---- GDELT test server ----

// gdeltStubResponse is one category's stubbed reply.
type gdeltStubResponse struct {
	status int
	body   string
	delay  time.Duration
}

// gdeltStubServer answers the DOC 2.0 requests of the fetcher. It maps the query
// parameter back to a category and records the request count.
type gdeltStubServer struct {
	server   *httptest.Server
	attempts int32
	requests []string
	// started receives one signal per accepted request so a test can cancel a
	// caller context while a request is in flight.
	started chan struct{}
	mu      sync.Mutex
}

func newGdeltStubServer(t *testing.T, responses map[Category]gdeltStubResponse) *gdeltStubServer {
	t.Helper()
	stub := &gdeltStubServer{started: make(chan struct{}, 16)}
	stub.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&stub.attempts, 1)
		select {
		case stub.started <- struct{}{}:
		default:
		}
		query := r.URL.Query().Get("query")
		stub.mu.Lock()
		stub.requests = append(stub.requests, r.URL.RequestURI())
		stub.mu.Unlock()

		response := gdeltStubResponse{status: http.StatusOK, body: `{"articles":[]}`}
		for category, candidate := range responses {
			if query == categoryQueries[category] {
				response = candidate
				break
			}
		}
		if response.delay > 0 {
			select {
			case <-time.After(response.delay):
			case <-r.Context().Done():
				return
			}
		}
		status := response.status
		if status == 0 {
			status = http.StatusOK
		}
		body := response.body
		if body == "" {
			body = `{"articles":[]}`
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(stub.server.Close)
	return stub
}

func (s *gdeltStubServer) requestCount() int {
	return int(atomic.LoadInt32(&s.attempts))
}

// articlesBody builds a DOC 2.0 success body. Every entry gets
// https://example.com/<slug> as link and "Title <slug>" as title.
func articlesBody(entries ...map[string]string) string {
	articles := make([]string, 0, len(entries))
	for _, entry := range entries {
		fields := make([]string, 0, len(entry))
		for key, value := range entry {
			encoded, _ := json.Marshal(value)
			fields = append(fields, fmt.Sprintf("%q:%s", key, encoded))
		}
		articles = append(articles, "{"+strings.Join(fields, ",")+"}")
	}
	return `{"articles":[` + strings.Join(articles, ",") + `]}`
}

// article is the common success entry builder.
func article(slug, title, domain, seenDate string) map[string]string {
	return map[string]string{
		"url":      "https://example.com/" + slug,
		"title":    title,
		"domain":   domain,
		"seendate": seenDate,
	}
}

// ---- service under test ----

type testRig struct {
	service *Service
	cache   *fakeCache
	store   *fakeStore
	lock    *fakeLock
	stub    *gdeltStubServer
	sleeps  []time.Duration
	now     time.Time
}

type rigOptions struct {
	enabled      bool
	responses    map[Category]gdeltStubResponse
	timeout      time.Duration
	aggregates   aggregateRow
	now          time.Time
	sleepRecords bool
}

func newTestRig(t *testing.T, options rigOptions) *testRig {
	t.Helper()
	now := options.now
	if now.IsZero() {
		now = time.Date(2026, 10, 20, 12, 34, 56, 789000000, time.UTC)
	}
	rig := &testRig{
		cache: newFakeCache(),
		store: &fakeStore{aggregates: options.aggregates},
		lock:  newFakeLock(),
		now:   now,
	}
	rig.stub = newGdeltStubServer(t, options.responses)
	fetcher := newGDeltFetcher(func() time.Time { return rig.now })
	fetcher.doc2URL = rig.stub.server.URL
	if options.timeout > 0 {
		fetcher.timeout = options.timeout
	}
	rig.service = &Service{
		store:   rig.store,
		cache:   rig.cache,
		locks:   rig.lock,
		fetch:   fetcher,
		enabled: options.enabled,
		now:     func() time.Time { return rig.now },
		sleep: func(_ context.Context, d time.Duration) error {
			if options.sleepRecords {
				rig.sleeps = append(rig.sleeps, d)
			}
			return nil
		},
	}
	return rig
}

// allCategoriesFailed builds a response map where every category returns the
// given status and body.
func allCategoriesFailed(status int, body string) map[Category]gdeltStubResponse {
	responses := make(map[Category]gdeltStubResponse, len(Categories))
	for _, category := range Categories {
		responses[category] = gdeltStubResponse{status: status, body: body}
	}
	return responses
}

// allCategoriesArticles builds a response map where every category returns one
// article.
func allCategoriesArticles() map[Category]gdeltStubResponse {
	responses := make(map[Category]gdeltStubResponse, len(Categories))
	for _, category := range Categories {
		responses[category] = gdeltStubResponse{
			status: http.StatusOK,
			body:   articlesBody(article(string(category)+"-1", "Title "+string(category), "example.com", "20261020T101112Z")),
		}
	}
	return responses
}
