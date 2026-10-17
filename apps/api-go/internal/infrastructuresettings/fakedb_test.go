package infrastructuresettings

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"strings"
	"sync"
)

// This file provides a minimal in-memory database/sql driver so the lock
// protocol, the audit outbox fallback and the storage read path can be unit
// tested without a real MySQL server. It never opens a socket.

// fakeState is the shared behaviour of every connection the fake driver hands
// out.
type fakeState struct {
	mu sync.Mutex

	execHandler  func(query string, args []driver.NamedValue) (driver.Result, error)
	queryHandler func(query string, args []driver.NamedValue) (driver.Rows, error)

	statements []string
	queryErrs  []error

	commitErr     error
	commitCalls   int
	rollbackCalls int

	// getLock is what `SELECT GET_LOCK(?, ?)` returns.
	getLock *int64
	// release is what `SELECT RELEASE_LOCK(?)` returns.
	release *int64
	// releaseCtxErr records ctx.Err() observed when RELEASE_LOCK ran.
	releaseCtxErr error
	releaseCalled bool
}

// record keeps the statement text in order.
func (s *fakeState) record(statement string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.statements = append(s.statements, statement)
}

// snapshot returns a copy of the recorded statements.
func (s *fakeState) snapshot() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.statements))
	copy(out, s.statements)
	return out
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
func (c *fakeConn) Begin() (driver.Tx, error) { return fakeTx{state: c.state}, nil }

// BeginTx implements driver.ConnBeginTx.
func (c *fakeConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return fakeTx{state: c.state}, nil
}

// ExecContext implements driver.ExecerContext.
func (c *fakeConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.state.record(query)
	if c.state.execHandler != nil {
		return c.state.execHandler(query, args)
	}
	return fakeResult{rows: 1}, nil
}

// QueryContext implements driver.QueryerContext.
func (c *fakeConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	c.state.record(query)
	if ctxErr := ctx.Err(); ctxErr != nil {
		c.state.mu.Lock()
		c.state.queryErrs = append(c.state.queryErrs, ctxErr)
		c.state.mu.Unlock()
	}
	if c.state.queryHandler != nil {
		return c.state.queryHandler(query, args)
	}
	return &fakeRows{columns: []string{"value"}}, nil
}

// fakeTx is a no-op transaction.
type fakeTx struct{ state *fakeState }

// Commit implements driver.Tx.
func (t fakeTx) Commit() error {
	t.state.mu.Lock()
	defer t.state.mu.Unlock()
	t.state.commitCalls++
	return t.state.commitErr
}

// Rollback implements driver.Tx.
func (t fakeTx) Rollback() error {
	t.state.mu.Lock()
	defer t.state.mu.Unlock()
	t.state.rollbackCalls++
	return nil
}

// fakeResult is a fixed-affected-rows result.
type fakeResult struct{ rows int64 }

// LastInsertId implements driver.Result.
func (r fakeResult) LastInsertId() (int64, error) { return 0, nil }

// RowsAffected implements driver.Result.
func (r fakeResult) RowsAffected() (int64, error) { return r.rows, nil }

// fakeRows is a static result set.
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

// newFakeDB builds a *sql.DB backed by the in-memory driver.
func newFakeDB(state *fakeState) *sql.DB {
	return sql.OpenDB(fakeConnector{state: state})
}

// namedValueString extracts the first string argument, used by the handlers to
// distinguish statements.
func namedValueString(args []driver.NamedValue) string {
	for _, arg := range args {
		if value, ok := arg.Value.(string); ok {
			return value
		}
	}
	return ""
}

// fakeMySQL is a tiny in-memory SystemSetting/AuditLog store used by the
// domain tests. It understands exactly the statements this unit emits.
type fakeMySQL struct {
	state    *fakeState
	settings map[string]string
	audits   []string
	deletes  []string
	lockOK   bool
	// lockResult overrides the GET_LOCK answer when non-nil.
	lockResult *int64
	// releaseFails makes RELEASE_LOCK report a lost lock.
	releaseFails bool
	// auditFails makes the direct AuditLog insert fail.
	auditFails bool
	// outboxFails makes the outbox insert fail too.
	outboxFails bool
}

// newFakeMySQL builds a fake store seeded with `settings` (key -> raw JSON).
func newFakeMySQL(settings map[string]string) *fakeMySQL {
	store := &fakeMySQL{
		state:    &fakeState{},
		settings: map[string]string{},
		lockOK:   true,
	}
	for key, value := range settings {
		store.settings[key] = value
	}
	store.state.queryHandler = store.query
	store.state.execHandler = store.exec
	return store
}

// db returns a *sql.DB backed by the fake store.
func (m *fakeMySQL) db() *sql.DB { return newFakeDB(m.state) }

// setting returns the current raw value of one key.
func (m *fakeMySQL) setting(key string) (string, bool) {
	value, ok := m.settings[key]
	return value, ok
}

// query answers the SELECT statements used by the unit.
func (m *fakeMySQL) query(query string, args []driver.NamedValue) (driver.Rows, error) {
	switch {
	case strings.Contains(query, "SELECT GET_LOCK"):
		value := int64(0)
		if m.lockOK {
			value = 1
		}
		if m.lockResult != nil {
			value = *m.lockResult
		}
		return &fakeRows{columns: []string{"acquired"}, rows: [][]driver.Value{{value}}}, nil
	case strings.Contains(query, "SELECT RELEASE_LOCK"):
		value := int64(1)
		if m.releaseFails {
			value = 0
		}
		m.state.releaseCalled = true
		return &fakeRows{columns: []string{"released"}, rows: [][]driver.Value{{value}}}, nil
	case strings.Contains(query, "SELECT value FROM SystemSetting WHERE `key` = ?"):
		key := namedValueString(args)
		if value, ok := m.settings[key]; ok {
			return &fakeRows{columns: []string{"value"}, rows: [][]driver.Value{{[]byte(value)}}}, nil
		}
		return &fakeRows{columns: []string{"value"}}, nil
	case strings.Contains(query, "SELECT `key`, value FROM SystemSetting WHERE `key` IN"):
		rows := [][]driver.Value{}
		for _, arg := range args {
			key, ok := arg.Value.(string)
			if !ok {
				continue
			}
			if value, found := m.settings[key]; found {
				rows = append(rows, []driver.Value{key, []byte(value)})
			}
		}
		return &fakeRows{columns: []string{"key", "value"}, rows: rows}, nil
	default:
		return &fakeRows{columns: []string{"value"}}, nil
	}
}

// exec answers the INSERT/UPDATE/DELETE statements used by the unit.
func (m *fakeMySQL) exec(query string, args []driver.NamedValue) (driver.Result, error) {
	switch {
	case strings.Contains(query, "INSERT INTO SystemSetting"):
		if len(args) >= 2 {
			key, keyOK := args[0].Value.(string)
			value, valueOK := args[1].Value.([]byte)
			if keyOK && valueOK {
				m.settings[key] = string(value)
			}
		}
		return fakeResult{rows: 1}, nil
	case strings.Contains(query, "DELETE FROM SystemSetting"):
		key := namedValueString(args)
		delete(m.settings, key)
		m.deletes = append(m.deletes, key)
		return fakeResult{rows: 1}, nil
	case strings.Contains(query, "INSERT INTO AuditLogOutbox"):
		if m.outboxFails {
			return nil, errors.New("outbox unavailable")
		}
		return fakeResult{rows: 1}, nil
	case strings.Contains(query, "INSERT INTO AuditLog"):
		if m.auditFails {
			return nil, errors.New("audit unavailable")
		}
		action := ""
		if len(args) >= 5 {
			if text, ok := args[4].Value.(string); ok {
				action = text
			}
		}
		m.audits = append(m.audits, action)
		return fakeResult{rows: 1}, nil
	default:
		return fakeResult{rows: 1}, nil
	}
}
