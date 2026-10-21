package crawlfrontierruns

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// stubDriver is a minimal database/sql driver that answers the two queries the
// authentication and run-lookup paths need. It lets the handler tests assert
// the 401 -> 403 -> 400 -> 404 ordering without a live MySQL instance.
type stubDriver struct{}

type stubInstance struct {
	name  string
	state *stubState
}

var stubInstances = []stubInstance{}

func init() {
	sql.Register("crawlfrontierruns-stub", stubDriver{})
}

// stubState is the per-DSN fixture.
type stubState struct {
	tokens   []stubToken
	runFound bool
}

// stubToken is one MachineAccessToken row fixture.
type stubToken struct {
	hash        string
	permissions string
}

// Open resolves a DSN to its registered fixture.
func (stubDriver) Open(name string) (driver.Conn, error) {
	for _, instance := range stubInstances {
		if instance.name == name {
			return &stubConn{state: instance.state}, nil
		}
	}
	return nil, errors.New("unknown stub dsn")
}

type stubConn struct {
	state *stubState
}

func (c *stubConn) Prepare(query string) (driver.Stmt, error) {
	return &stubStmt{state: c.state, query: query}, nil
}

func (c *stubConn) Close() error { return nil }

func (c *stubConn) Begin() (driver.Tx, error) { return stubTx{}, nil }

func (c *stubConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	return c.state.query(query, args)
}

func (c *stubConn) ExecContext(_ context.Context, _ string, _ []driver.NamedValue) (driver.Result, error) {
	return driver.RowsAffected(0), nil
}

type stubStmt struct {
	state *stubState
	query string
}

func (s *stubStmt) Close() error  { return nil }
func (s *stubStmt) NumInput() int { return -1 }

func (s *stubStmt) Exec(_ []driver.Value) (driver.Result, error) {
	return driver.RowsAffected(0), nil
}

func (s *stubStmt) Query(_ []driver.Value) (driver.Rows, error) {
	return s.state.query(s.query, nil)
}

type stubTx struct{}

func (stubTx) Commit() error   { return nil }
func (stubTx) Rollback() error { return nil }

type stubRows struct {
	columns []string
	rows    [][]driver.Value
	index   int
}

func (r *stubRows) Columns() []string { return r.columns }
func (r *stubRows) Close() error      { return nil }

func (r *stubRows) Next(dest []driver.Value) error {
	if r.index >= len(r.rows) {
		return io.EOF
	}
	row := r.rows[r.index]
	r.index++
	for index := range dest {
		if index < len(row) {
			dest[index] = row[index]
		} else {
			dest[index] = nil
		}
	}
	return nil
}

// query answers the authentication and run-lookup statements.
func (s *stubState) query(query string, args []driver.NamedValue) (driver.Rows, error) {
	machineColumns := []string{"id", "orgId", "permissions", "expiresAt", "revokedAt", "isActive"}
	if strings.Contains(query, "FROM MachineAccessToken") {
		hash := ""
		if len(args) > 0 {
			if text, ok := args[0].Value.(string); ok {
				hash = text
			}
		}
		for _, token := range s.tokens {
			if token.hash == hash {
				return &stubRows{
					columns: machineColumns,
					rows:    [][]driver.Value{{"token-1", "org-1", []byte(token.permissions), nil, nil, int64(1)}},
				}, nil
			}
		}
		return &stubRows{columns: machineColumns}, nil
	}
	if strings.Contains(query, "FROM CrawlFrontierRun WHERE id = ?") {
		if s.runFound {
			return &stubRows{columns: []string{"id"}, rows: [][]driver.Value{{"run-1"}}}, nil
		}
		return &stubRows{columns: []string{"id"}}, nil
	}
	// The retry routes look the node up joined with its run. An empty result is
	// the "node belongs to no organization" case, which the handler answers with
	// 404 before it ever needs the run columns.
	if strings.Contains(query, "FROM CrawlFrontierNode n") {
		return &stubRows{columns: []string{"id", "orgId", "runId", "crawlTaskId"}}, nil
	}
	return &stubRows{}, nil
}

// stubTokenHash hashes a token the way AuthenticateMachine does.
func stubTokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// newStubHandler registers a fixture and returns a handler backed by it.
func newStubHandler(t *testing.T, name string) *Handler {
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
	return NewHandler(nil, NewService(db))
}

// callHandler performs one request against the handler.
func callHandler(handler *Handler, method, path, token, body string) *httptest.ResponseRecorder {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, "http://gateway"+path, reader)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestHandlerFailureOrder(t *testing.T) {
	handler := newStubHandler(t, "stub-handler-order")
	cancelPath := "/api/admin/crawl-frontier/runs/cancel"
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
			name:        "missing token is 401 before the body is read",
			method:      http.MethodPost,
			path:        cancelPath,
			body:        `{"ids":[]}`,
			wantStatus:  http.StatusUnauthorized,
			wantMessage: "Unauthorized",
		},
		{
			name:        "unknown machine token is 401",
			method:      http.MethodPost,
			path:        cancelPath,
			token:       "mtk_unknown",
			body:        `{"ids":[]}`,
			wantStatus:  http.StatusUnauthorized,
			wantMessage: "Invalid machine token",
		},
		{
			name:        "read only token is 403 before DTO validation",
			method:      http.MethodPost,
			path:        cancelPath,
			token:       "mtk_read",
			body:        `{"ids":[]}`,
			wantStatus:  http.StatusForbidden,
			wantMessage: "Insufficient permissions",
		},
		{
			name:       "read token can list runs",
			method:     http.MethodGet,
			path:       "/api/admin/crawl-frontier/runs",
			token:      "mtk_read",
			wantStatus: http.StatusOK,
		},
		{
			name:        "write token reaches DTO validation",
			method:      http.MethodPost,
			path:        cancelPath,
			token:       "mtk_write",
			body:        `{"ids":[]}`,
			wantStatus:  http.StatusBadRequest,
			wantMessage: "ids should not be empty",
		},
		{
			name:        "write token reaches the service for a missing run",
			method:      http.MethodGet,
			path:        "/api/admin/crawl-frontier/runs/missing",
			token:       "mtk_write",
			wantStatus:  http.StatusNotFound,
			wantMessage: "Crawl frontier run not found",
		},
		{
			name:        "GET runs/cancel is matched as runs/:id",
			method:      http.MethodGet,
			path:        cancelPath,
			token:       "mtk_write",
			wantStatus:  http.StatusNotFound,
			wantMessage: "Crawl frontier run not found",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			recorder := callHandler(handler, tc.method, tc.path, tc.token, tc.body)
			if recorder.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body %s)", recorder.Code, tc.wantStatus, recorder.Body.String())
			}
			if tc.wantMessage == "" {
				return
			}
			var document struct {
				StatusCode int    `json:"statusCode"`
				Message    string `json:"message"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &document); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			if document.Message != tc.wantMessage {
				t.Fatalf("message = %q, want %q", document.Message, tc.wantMessage)
			}
		})
	}
}

func TestRawBearer(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "http://gateway/", nil)
	if rawBearer(request) != "" {
		t.Fatal("missing header must yield an empty token")
	}
	request.Header.Set("Authorization", "bearer  token-value ")
	if got := rawBearer(request); got != "token-value" {
		t.Fatalf("rawBearer = %q", got)
	}
	request.Header.Set("Authorization", "Basic abc")
	if rawBearer(request) != "" {
		t.Fatal("non-Bearer header must yield an empty token")
	}
}

func TestDecodePathSegment(t *testing.T) {
	if got := decodePathSegment("a%20b"); got != "a b" {
		t.Fatalf("decoded = %q", got)
	}
	if got := decodePathSegment("%zz"); got != "%zz" {
		t.Fatalf("invalid escape must keep the raw text, got %q", got)
	}
}
