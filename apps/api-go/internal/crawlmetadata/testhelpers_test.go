package crawlmetadata

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// This file holds the test doubles shared by the package tests. The SSRF rules
// are never relaxed: every stubbed target uses a public IP literal
// (8.8.8.8/93.184.216.34) so the per-hop validation passes without DNS, or a
// deliberately localhost URL when the test asserts a block. The HTTP transport
// is replaced, so no request ever leaves the process.

// stubTransport records every request and answers from a caller-supplied
// function.
type stubTransport struct {
	mu      sync.Mutex
	seen    []string
	headers []http.Header
	respond func(req *http.Request) (*http.Response, error)
}

func (t *stubTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.mu.Lock()
	t.seen = append(t.seen, req.Method+" "+req.URL.String())
	t.headers = append(t.headers, req.Header.Clone())
	t.mu.Unlock()
	return t.respond(req)
}

func (t *stubTransport) requests() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]string, len(t.seen))
	copy(out, t.seen)
	return out
}

func (t *stubTransport) requestHeaders() []http.Header {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]http.Header, len(t.headers))
	copy(out, t.headers)
	return out
}

// textResponse builds a stubbed response with an optional body.
func textResponse(status int, headers map[string]string, body string) *http.Response {
	header := http.Header{}
	for name, value := range headers {
		header.Set(name, value)
	}
	return &http.Response{
		StatusCode: status,
		Status:     fmt.Sprintf("%d %s", status, http.StatusText(status)),
		Header:     header,
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

// newStubService returns a service whose outbound HTTP is intercepted.
func newStubService(t *testing.T, respond func(req *http.Request) (*http.Response, error)) (*Service, *stubTransport) {
	t.Helper()
	transport := &stubTransport{respond: respond}
	service := NewService(nil, nil)
	service.client = &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	return service, transport
}

// memoryStateStore is the in-memory discoveryStateStore used instead of Redis.
type memoryStateStore struct {
	mu     sync.Mutex
	states map[string]discoveryHTTPState
	writes int
}

func newMemoryStateStore() *memoryStateStore {
	return &memoryStateStore{states: map[string]discoveryHTTPState{}}
}

func (m *memoryStateStore) read(_ context.Context, url string) *discoveryHTTPState {
	m.mu.Lock()
	defer m.mu.Unlock()
	state, ok := m.states[url]
	if !ok {
		return nil
	}
	copy := state
	return &copy
}

func (m *memoryStateStore) write(_ context.Context, url string, state discoveryHTTPState) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.writes++
	m.states[url] = state
}

func (m *memoryStateStore) stored(url string) (discoveryHTTPState, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	state, ok := m.states[url]
	return state, ok
}
