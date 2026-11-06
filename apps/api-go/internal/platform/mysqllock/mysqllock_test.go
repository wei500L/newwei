package mysqllock

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
)

// fakeState drives the in-memory driver. It records connections and statements
// so the tests can prove eviction and the exact SQL surface.
type fakeState struct {
	mu sync.Mutex

	getLock driver.Value
	release driver.Value
	conns   []*fakeConn
	stmts   []string
}

func (s *fakeState) closedConnections() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	closed := 0
	for _, conn := range s.conns {
		if conn.closed {
			closed++
		}
	}
	return closed
}

func (s *fakeState) createdConnections() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.conns)
}

type fakeConnector struct{ state *fakeState }

func (c fakeConnector) Connect(context.Context) (driver.Conn, error) {
	conn := &fakeConn{state: c.state}
	c.state.mu.Lock()
	c.state.conns = append(c.state.conns, conn)
	c.state.mu.Unlock()
	return conn, nil
}

func (c fakeConnector) Driver() driver.Driver { return fakeDriver{} }

type fakeDriver struct{}

func (fakeDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("fakeDriver: Open is not supported; use the connector")
}

type fakeConn struct {
	state  *fakeState
	closed bool
}

func (c *fakeConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("fakeConn: Prepare is not supported")
}

func (c *fakeConn) Close() error {
	c.state.mu.Lock()
	defer c.state.mu.Unlock()
	c.closed = true
	return nil
}

func (c *fakeConn) Begin() (driver.Tx, error) {
	return nil, errors.New("fakeConn: Begin is not supported")
}

func (c *fakeConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	c.state.mu.Lock()
	defer c.state.mu.Unlock()
	c.state.stmts = append(c.state.stmts, query)
	switch {
	case strings.Contains(query, "SELECT GET_LOCK"):
		return &fakeRows{columns: []string{"acquired"}, rows: [][]driver.Value{{c.state.getLock}}}, nil
	case strings.Contains(query, "SELECT RELEASE_LOCK"):
		return &fakeRows{columns: []string{"released"}, rows: [][]driver.Value{{c.state.release}}}, nil
	default:
		return &fakeRows{columns: []string{"value"}}, nil
	}
}

type fakeRows struct {
	columns []string
	rows    [][]driver.Value
	index   int
}

func (r *fakeRows) Columns() []string { return r.columns }
func (r *fakeRows) Close() error      { return nil }

func (r *fakeRows) Next(dest []driver.Value) error {
	if r.index >= len(r.rows) {
		return io.EOF
	}
	copy(dest, r.rows[r.index])
	r.index++
	return nil
}

func newFake(t *testing.T, getLock, release driver.Value) (*sql.DB, *fakeState) {
	t.Helper()
	state := &fakeState{getLock: getLock, release: release}
	return sql.OpenDB(fakeConnector{state: state}), state
}

func TestWithLockRunsAndReleases(t *testing.T) {
	db, state := newFake(t, int64(1), int64(1))
	defer db.Close()

	ran := false
	err := WithLock(context.Background(), db, "test:lock", 10, func(context.Context) error {
		ran = true
		return nil
	})
	if err != nil || !ran {
		t.Fatalf("err=%v ran=%t", err, ran)
	}
	if len(state.stmts) < 2 || !strings.Contains(state.stmts[0], "GET_LOCK") || !strings.Contains(state.stmts[1], "RELEASE_LOCK") {
		t.Fatalf("statements = %v", state.stmts)
	}
	if created := state.createdConnections(); created != 1 {
		t.Fatalf("a successful release must return the connection to the pool, created=%d", created)
	}
}

func TestWithLockNotAcquired(t *testing.T) {
	db, _ := newFake(t, int64(0), int64(1))
	defer db.Close()

	ran := false
	err := WithLock(context.Background(), db, "test:lock", 10, func(context.Context) error {
		ran = true
		return nil
	})
	if !errors.Is(err, ErrNotAcquired) {
		t.Fatalf("err = %v, want ErrNotAcquired", err)
	}
	if ran {
		t.Fatal("the callback ran without the lock")
	}
}

func TestWithLockNullIsUnavailable(t *testing.T) {
	db, _ := newFake(t, nil, int64(1))
	defer db.Close()

	if err := WithLock(context.Background(), db, "test:lock", 10, func(context.Context) error { return nil }); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
}

func TestWithLockPropagatesCallbackError(t *testing.T) {
	db, _ := newFake(t, int64(1), int64(1))
	defer db.Close()

	sentinel := errors.New("business failure")
	if err := WithLock(context.Background(), db, "test:lock", 10, func(context.Context) error { return sentinel }); !errors.Is(err, sentinel) {
		t.Fatalf("err = %v, want the callback error", err)
	}
}

// TestReleaseFailureEvictsConnection proves a failed RELEASE_LOCK drops the
// physical session instead of returning a possibly still-locked connection to
// the pool.
func TestReleaseFailureEvictsConnection(t *testing.T) {
	db, state := newFake(t, int64(1), int64(0))
	defer db.Close()

	if err := WithLock(context.Background(), db, "test:lock", 10, func(context.Context) error { return nil }); err != nil {
		t.Fatalf("a failed release must not surface as an error: %v", err)
	}
	// Reaching into the pool after the failure must open a brand new connection:
	// the evicted one was closed and never handed back.
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	if created := state.createdConnections(); created < 2 {
		t.Fatalf("the evicted connection must be replaced, created=%d", created)
	}
}

// TestWithConnLockRunsOnPinnedConnection proves the callback receives the same
// pinned connection that owns the advisory lock, and that a successful release
// returns it to the pool.
func TestWithConnLockRunsOnPinnedConnection(t *testing.T) {
	db, state := newFake(t, int64(1), int64(1))
	defer db.Close()

	var got *sql.Conn
	err := WithConnLock(context.Background(), db, "test:conn-lock", 10, func(_ context.Context, conn *sql.Conn) error {
		got = conn
		return nil
	})
	if err != nil || got == nil {
		t.Fatalf("err=%v conn=%v", err, got)
	}
	if len(state.stmts) < 2 || !strings.Contains(state.stmts[0], "GET_LOCK") || !strings.Contains(state.stmts[1], "RELEASE_LOCK") {
		t.Fatalf("statements = %v", state.stmts)
	}
	if created := state.createdConnections(); created != 1 {
		t.Fatalf("a successful release must return the connection to the pool, created=%d", created)
	}
}

// TestWithConnLockNotAcquired proves a GET_LOCK timeout does not run the
// callback and surfaces ErrNotAcquired.
func TestWithConnLockNotAcquired(t *testing.T) {
	db, _ := newFake(t, int64(0), int64(1))
	defer db.Close()

	ran := false
	err := WithConnLock(context.Background(), db, "test:conn-lock", 10, func(context.Context, *sql.Conn) error {
		ran = true
		return nil
	})
	if !errors.Is(err, ErrNotAcquired) || ran {
		t.Fatalf("err=%v ran=%t", err, ran)
	}
}

// TestWithConnLockReleaseFailureEvictsConnection pins the defect fix: a failed
// RELEASE_LOCK must evict the pinned connection instead of pooling it.
func TestWithConnLockReleaseFailureEvictsConnection(t *testing.T) {
	db, state := newFake(t, int64(1), int64(0))
	defer db.Close()

	if err := WithConnLock(context.Background(), db, "test:conn-lock", 10, func(context.Context, *sql.Conn) error { return nil }); err != nil {
		t.Fatalf("a failed release must not surface as an error: %v", err)
	}
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	if created := state.createdConnections(); created < 2 {
		t.Fatalf("the evicted connection must be replaced, created=%d", created)
	}
}
