package accountsecurity

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"sync"
)

// This file provides a minimal in-memory database/sql driver so the CAS
// transaction and the machine-token rotation transaction can be unit tested
// without a real MySQL server. It never opens a socket. The database handle is
// created with sql.OpenDB, so no driver name is registered globally.

// fakeState is the shared behaviour of every connection the fake driver hands
// out.
type fakeState struct {
	mu sync.Mutex

	execHandler  func(query string, args []driver.NamedValue) (driver.Result, error)
	queryHandler func(query string, args []driver.NamedValue) (driver.Rows, error)

	execQueries []string
	execArgs    [][]driver.NamedValue
	queryTexts  []string

	commits   int
	rollbacks int
}

// recordExec keeps the executed statement and its arguments in order.
func (s *fakeState) recordExec(query string, args []driver.NamedValue) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.execQueries = append(s.execQueries, query)
	copied := make([]driver.NamedValue, len(args))
	copy(copied, args)
	s.execArgs = append(s.execArgs, copied)
}

// recordQuery keeps the queried statement in order.
func (s *fakeState) recordQuery(query string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.queryTexts = append(s.queryTexts, query)
}

// executedStatements returns a copy of the executed statement list.
func (s *fakeState) executedStatements() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.execQueries))
	copy(out, s.execQueries)
	return out
}

// txCounts returns the commit/rollback counters.
func (s *fakeState) txCounts() (int, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.commits, s.rollbacks
}

// newFakeDB wraps the state in a *sql.DB.
func newFakeDB(state *fakeState) *sql.DB {
	return sql.OpenDB(fakeConnector{state: state})
}

// fakeConnector produces connections sharing one state.
type fakeConnector struct{ state *fakeState }

// Connect implements driver.Connector.
func (c fakeConnector) Connect(context.Context) (driver.Conn, error) {
	return &fakeConn{state: c.state}, nil
}

// Driver implements driver.Connector.
func (c fakeConnector) Driver() driver.Driver { return fakeDriver{} }

// fakeDriver is the driver.Driver for the in-memory test connection.
type fakeDriver struct{}

// Open implements driver.Driver.
func (fakeDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("fakeDriver: Open is not supported; use the connector")
}

// fakeConn is one in-memory connection.
type fakeConn struct{ state *fakeState }

// Prepare implements driver.Conn.
func (c *fakeConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("fakeConn: Prepare is not supported")
}

// Close implements driver.Conn.
func (c *fakeConn) Close() error { return nil }

// Begin implements driver.Conn.
func (c *fakeConn) Begin() (driver.Tx, error) { return &fakeTx{state: c.state}, nil }

// BeginTx implements driver.ConnBeginTx.
func (c *fakeConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return &fakeTx{state: c.state}, nil
}

// ExecContext implements driver.ExecerContext.
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

// QueryContext implements driver.QueryerContext.
func (c *fakeConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	c.state.recordQuery(query)
	c.state.mu.Lock()
	handler := c.state.queryHandler
	c.state.mu.Unlock()
	if handler != nil {
		return handler(query, args)
	}
	return &fakeRows{columns: []string{"value"}}, nil
}

// fakeTx counts commits and rollbacks.
type fakeTx struct{ state *fakeState }

// Commit implements driver.Tx.
func (t *fakeTx) Commit() error {
	t.state.mu.Lock()
	defer t.state.mu.Unlock()
	t.state.commits++
	return nil
}

// Rollback implements driver.Tx.
func (t *fakeTx) Rollback() error {
	t.state.mu.Lock()
	defer t.state.mu.Unlock()
	t.state.rollbacks++
	return nil
}

// fakeResult is a configurable driver.Result.
type fakeResult struct {
	rows int64
	err  error
}

// LastInsertId implements driver.Result.
func (r fakeResult) LastInsertId() (int64, error) { return 0, nil }

// RowsAffected implements driver.Result.
func (r fakeResult) RowsAffected() (int64, error) {
	if r.err != nil {
		return 0, r.err
	}
	return r.rows, nil
}

// fakeRows is a static driver.Rows.
type fakeRows struct {
	columns []string
	rows    [][]driver.Value
	index   int
}

// Columns implements driver.Rows.
func (r *fakeRows) Columns() []string { return r.columns }

// Close implements driver.Rows.
func (r *fakeRows) Close() error { return nil }

// Next implements driver.Rows.
func (r *fakeRows) Next(dest []driver.Value) error {
	if r.index >= len(r.rows) {
		return io.EOF
	}
	copy(dest, r.rows[r.index])
	r.index++
	return nil
}

// rowsWithValues builds a single-row result set.
func rowsWithValues(columns []string, values ...driver.Value) *fakeRows {
	return &fakeRows{columns: columns, rows: [][]driver.Value{values}}
}

// namedArg returns the value of the first argument whose name or position
// matches, for assertions. It returns nil when absent.
func namedArg(args []driver.NamedValue, ordinal int) driver.Value {
	for _, arg := range args {
		if arg.Ordinal == ordinal {
			return arg.Value
		}
	}
	return nil
}
