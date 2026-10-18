package identityonboarding

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"sync"
)

// This file provides the minimal in-memory database/sql driver the unit tests
// use. It opens no socket and registers no driver name: the handle comes from
// sql.OpenDB, and each test supplies query and exec handlers.

type stubState struct {
	mu sync.Mutex

	query func(query string, args []driver.NamedValue) (driver.Rows, error)
	exec  func(query string, args []driver.NamedValue) (driver.Result, error)

	execQueries []string
}

func (s *stubState) record(query string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.execQueries = append(s.execQueries, query)
}

func (s *stubState) statements() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.execQueries))
	copy(out, s.execQueries)
	return out
}

func newStubDB(state *stubState) *sql.DB { return sql.OpenDB(stubConnector{state: state}) }

type stubConnector struct{ state *stubState }

func (c stubConnector) Connect(context.Context) (driver.Conn, error) {
	return &stubConn{state: c.state}, nil
}

func (c stubConnector) Driver() driver.Driver { return stubDriver{} }

type stubDriver struct{}

func (stubDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("stubDriver: use the connector")
}

type stubConn struct{ state *stubState }

func (c *stubConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("stubConn: Prepare is not supported")
}

func (c *stubConn) Close() error { return nil }

func (c *stubConn) Begin() (driver.Tx, error) { return stubTx{}, nil }

func (c *stubConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return stubTx{}, nil
}

func (c *stubConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.state.record(query)
	c.state.mu.Lock()
	handler := c.state.exec
	c.state.mu.Unlock()
	if handler != nil {
		return handler(query, args)
	}
	return stubResult{rows: 1}, nil
}

func (c *stubConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	c.state.mu.Lock()
	handler := c.state.query
	c.state.mu.Unlock()
	if handler != nil {
		return handler(query, args)
	}
	return &stubRows{columns: []string{"value"}}, nil
}

type stubTx struct{}

func (stubTx) Commit() error   { return nil }
func (stubTx) Rollback() error { return nil }

type stubResult struct {
	rows int64
	err  error
}

func (r stubResult) LastInsertId() (int64, error) { return 0, nil }

func (r stubResult) RowsAffected() (int64, error) {
	if r.err != nil {
		return 0, r.err
	}
	return r.rows, nil
}

type stubRows struct {
	columns []string
	rows    [][]driver.Value
	index   int
}

func (r *stubRows) Columns() []string { return r.columns }

func (r *stubRows) Close() error { return nil }

func (r *stubRows) Next(dest []driver.Value) error {
	if r.index >= len(r.rows) {
		return io.EOF
	}
	copy(dest, r.rows[r.index])
	r.index++
	return nil
}

func rowsWith(columns []string, values ...[]driver.Value) driver.Rows {
	return &stubRows{columns: columns, rows: values}
}

func emptyRows(columns ...string) driver.Rows { return &stubRows{columns: columns} }
