package authlogin

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"sync"
)

// This file provides the same minimal in-memory database/sql driver the other
// migration units use, so the flows that touch only MySQL (challenge
// consumption and the password-reset transaction) can be exercised without a
// server. It opens no socket and registers no global driver name: the handle
// comes from sql.OpenDB.

type fakeState struct {
	mu sync.Mutex

	execHandler  func(query string, args []driver.NamedValue) (driver.Result, error)
	queryHandler func(query string, args []driver.NamedValue) (driver.Rows, error)

	execQueries []string
	execArgs    [][]driver.NamedValue

	commits   int
	rollbacks int
}

func (s *fakeState) recordExec(query string, args []driver.NamedValue) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.execQueries = append(s.execQueries, query)
	copied := make([]driver.NamedValue, len(args))
	copy(copied, args)
	s.execArgs = append(s.execArgs, copied)
}

func (s *fakeState) executedStatements() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.execQueries))
	copy(out, s.execQueries)
	return out
}

func (s *fakeState) txCounts() (int, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.commits, s.rollbacks
}

func newFakeDB(state *fakeState) *sql.DB { return sql.OpenDB(fakeConnector{state: state}) }

type fakeConnector struct{ state *fakeState }

func (c fakeConnector) Connect(context.Context) (driver.Conn, error) {
	return &fakeConn{state: c.state}, nil
}

func (c fakeConnector) Driver() driver.Driver { return fakeDriver{} }

type fakeDriver struct{}

func (fakeDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("fakeDriver: Open is not supported; use the connector")
}

type fakeConn struct{ state *fakeState }

func (c *fakeConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("fakeConn: Prepare is not supported")
}

func (c *fakeConn) Close() error { return nil }

func (c *fakeConn) Begin() (driver.Tx, error) { return &fakeTx{state: c.state}, nil }

func (c *fakeConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return &fakeTx{state: c.state}, nil
}

func (c *fakeConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.state.recordExec(query, args)
	c.state.mu.Lock()
	handler := c.state.execHandler
	c.state.mu.Unlock()
	if handler != nil {
		return handler(query, args)
	}
	return fakeResult{rows: 1}, nil
}

func (c *fakeConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	c.state.mu.Lock()
	handler := c.state.queryHandler
	c.state.mu.Unlock()
	if handler != nil {
		return handler(query, args)
	}
	return &fakeRows{columns: []string{"value"}}, nil
}

type fakeTx struct{ state *fakeState }

func (t *fakeTx) Commit() error {
	t.state.mu.Lock()
	defer t.state.mu.Unlock()
	t.state.commits++
	return nil
}

func (t *fakeTx) Rollback() error {
	t.state.mu.Lock()
	defer t.state.mu.Unlock()
	t.state.rollbacks++
	return nil
}

type fakeResult struct {
	rows int64
	err  error
}

func (r fakeResult) LastInsertId() (int64, error) { return 0, nil }

func (r fakeResult) RowsAffected() (int64, error) {
	if r.err != nil {
		return 0, r.err
	}
	return r.rows, nil
}

type fakeRows struct {
	columns []string
	rows    [][]driver.Value
	index   int
}

func (r *fakeRows) Columns() []string { return r.columns }

func (r *fakeRows) Close() error { return nil }

func (r *fakeRows) Next(dest []driver.Value) error {
	if r.index >= len(r.rows) {
		return io.EOF
	}
	copy(dest, r.rows[r.index])
	r.index++
	return nil
}

func rowsWithValues(columns []string, values ...driver.Value) *fakeRows {
	return &fakeRows{columns: columns, rows: [][]driver.Value{values}}
}

// emptyRows builds a result set with no rows (sql.ErrNoRows for QueryRow).
func emptyRows(columns ...string) *fakeRows {
	return &fakeRows{columns: columns}
}
