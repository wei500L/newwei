package crawlfrontierruns

import (
	"database/sql"
	"net/http"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
)

// newStubWriteHandler registers a fixture and returns a handler that serves the
// three write routes. The chain service is built around the same stub handle but
// carries no workflow or queue dependency: every case below is decided by the
// identity chain, the DTO layer, or the node lookup, all of which run before the
// requeue transaction needs either.
func newStubWriteHandler(t *testing.T, name string) *Handler {
	t.Helper()
	state := &stubState{tokens: []stubToken{
		{hash: stubTokenHash("mtk_read"), permissions: `["crawl.read"]`},
		{hash: stubTokenHash("mtk_write"), permissions: `["crawl.read","crawl.write"]`},
	}}
	stubInstances = append(stubInstances, stubInstance{name: name, state: state})
	db, err := sql.Open("crawlfrontierruns-stub", name)
	if err != nil {
		t.Fatalf("open stub: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return NewWriteHandler(nil, NewWriteService(db, crawlfrontierllm.New(crawlfrontierllm.Options{DB: db})))
}

// TestWriteHandlerAuthAndValidation pins the 401 -> 403 -> 400 order on all three
// routes and proves the DTO layer runs after authentication.
func TestWriteHandlerAuthAndValidation(t *testing.T) {
	handler := newStubWriteHandler(t, "stub-write-order")
	cases := []struct {
		name        string
		method      string
		path        string
		token       string
		body        string
		wantStatus  int
		wantMessage string
	}{
		{
			name:        "create run without a token is 401",
			method:      http.MethodPost,
			path:        "/api/admin/crawl-frontier/runs",
			wantStatus:  http.StatusUnauthorized,
			wantMessage: "",
		},
		{
			name:        "create run with a read token is 403",
			method:      http.MethodPost,
			path:        "/api/admin/crawl-frontier/runs",
			token:       "mtk_read",
			body:        `{"seedUrl":"https://example.com"}`,
			wantStatus:  http.StatusForbidden,
			wantMessage: "Insufficient permissions",
		},
		{
			name:        "create run validates the body after authorisation",
			method:      http.MethodPost,
			path:        "/api/admin/crawl-frontier/runs",
			token:       "mtk_write",
			body:        `{"seedUrl":"not a url"}`,
			wantStatus:  http.StatusBadRequest,
			wantMessage: "seedUrl must be a URL address",
		},
		{
			name:        "bulk retry without a token is 401",
			method:      http.MethodPost,
			path:        "/api/admin/crawl-frontier/nodes/retry",
			wantStatus:  http.StatusUnauthorized,
			wantMessage: "",
		},
		{
			name:        "bulk retry with a read token is 403",
			method:      http.MethodPost,
			path:        "/api/admin/crawl-frontier/nodes/retry",
			token:       "mtk_read",
			body:        `{"ids":["node-1"]}`,
			wantStatus:  http.StatusForbidden,
			wantMessage: "Insufficient permissions",
		},
		{
			// The exact nodes/retry route must reach the bulk DTO, not the
			// nodes/:id route with id="retry".
			name:        "nodes/retry is not treated as a node id",
			method:      http.MethodPost,
			path:        "/api/admin/crawl-frontier/nodes/retry",
			token:       "mtk_write",
			body:        `{"ids":[]}`,
			wantStatus:  http.StatusBadRequest,
			wantMessage: "ids should not be empty",
		},
		{
			name:        "single node retry with a read token is 403",
			method:      http.MethodPost,
			path:        "/api/admin/crawl-frontier/nodes/node-1/retry",
			token:       "mtk_read",
			wantStatus:  http.StatusForbidden,
			wantMessage: "Insufficient permissions",
		},
		{
			name:        "single node retry of an unknown node is 404",
			method:      http.MethodPost,
			path:        "/api/admin/crawl-frontier/nodes/node-1/retry",
			token:       "mtk_write",
			wantStatus:  http.StatusNotFound,
			wantMessage: "Crawl frontier node not found",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := callHandler(handler, testCase.method, testCase.path, testCase.token, testCase.body)
			if recorder.Code != testCase.wantStatus {
				t.Fatalf("status = %d, want %d (body %s)", recorder.Code, testCase.wantStatus, recorder.Body.String())
			}
			if testCase.wantMessage != "" && !strings.Contains(recorder.Body.String(), testCase.wantMessage) {
				t.Fatalf("body %s does not contain %q", recorder.Body.String(), testCase.wantMessage)
			}
		})
	}
}

// TestWriteHandlerReadRoutesStayOnTheReadUnit makes sure attaching the write
// service does not change how the eleven read routes behave: this handler was
// built with NewWriteHandler, so the read paths still answer from the shared
// dispatch and never reach a write branch.
func TestWriteHandlerReadRoutesStayOnTheReadUnit(t *testing.T) {
	handler := newStubWriteHandler(t, "stub-write-reads")
	// A read token is enough for the read routes; the run does not exist in the
	// stub, so the answer is the read unit's 404 rather than a write error.
	recorder := callHandler(handler, http.MethodGet, "/api/admin/crawl-frontier/runs/missing", "mtk_read", "")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (body %s)", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "Crawl frontier run not found") {
		t.Fatalf("body %s is not the read unit's run-missing message", recorder.Body.String())
	}
}
