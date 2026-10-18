package authfactors

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"strings"
	"sync"
	"time"
)

// This file provides a minimal in-memory database/sql driver so the lock
// protocol, the MFA transaction boundaries, the recovery-code claim and the
// OIDC secret-preservation write can be unit tested without a real MySQL
// server. It never opens a socket.
//
// Transactions are emulated with undo closures: every mutation applies
// immediately (so the transaction reads its own writes) and registers how to
// reverse itself. Commit discards the undo log; rollback replays it in reverse.
// That is exactly what the AF2 assertions need.

// ---- typed in-memory rows ----

type fakeFactor struct {
	id               string
	secret           []byte
	pendingSecret    []byte
	label            *string
	pendingLabel     *string
	pendingStartedAt *time.Time
	enrolledAt       time.Time
	verifiedAt       *time.Time
	disabledAt       *time.Time
	lastUsedAt       *time.Time
}

type fakeRecoveryCode struct {
	id        string
	userID    string
	codeHash  string
	usedAt    *time.Time
	createdAt time.Time
}

type fakeOidcConfig struct {
	id                   string
	orgID                string
	enabled              bool
	issuerURL            string
	discoveryURL         *string
	clientID             string
	clientSecret         []byte
	scopes               []byte
	buttonLabel          *string
	requireEmailVerified bool
}

type fakeMachineToken struct {
	id          string
	orgID       string
	permissions string
	expiresAt   *time.Time
	revokedAt   *time.Time
	orgActive   bool
}

// fakeStore is the shared state every fake connection reads and writes.
type fakeStore struct {
	mu sync.Mutex

	users        map[string]string
	memberships  map[string][]string
	settings     map[string]string
	factors      map[string]*fakeFactor
	recovery     []*fakeRecoveryCode
	oidc         map[string]*fakeOidcConfig
	machineToken map[string]fakeMachineToken

	// execFailures makes the first statement containing the fragment fail.
	execFailures map[string]error

	getLock     int64
	releaseLock int64

	tx            *fakeTx
	statements    []string
	commitCalls   int
	rollbackCalls int
}

// fakeTx records how to undo every mutation performed inside it.
type fakeTx struct {
	undos []func()
	done  bool
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		users:        map[string]string{},
		memberships:  map[string][]string{},
		settings:     map[string]string{},
		factors:      map[string]*fakeFactor{},
		oidc:         map[string]*fakeOidcConfig{},
		machineToken: map[string]fakeMachineToken{},
		execFailures: map[string]error{},
		getLock:      1,
		releaseLock:  1,
	}
}

func (s *fakeStore) db() *sql.DB {
	return sql.OpenDB(fakeConnector{store: s})
}

func (s *fakeStore) record(statement string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.statements = append(s.statements, statement)
}

// undo registers one reversal on the active transaction, if any.
func (s *fakeStore) undo(fn func()) {
	if s.tx != nil && !s.tx.done {
		s.tx.undos = append(s.tx.undos, fn)
	}
}

func (s *fakeStore) setFactor(userID string, factor *fakeFactor) {
	s.factors[userID] = factor
}

func (s *fakeStore) unusedRecoveryCount(userID string) int {
	count := 0
	for _, code := range s.recovery {
		if code.userID == userID && code.usedAt == nil {
			count++
		}
	}
	return count
}

func (s *fakeStore) recoveryFor(userID string) []*fakeRecoveryCode {
	out := []*fakeRecoveryCode{}
	for _, code := range s.recovery {
		if code.userID == userID {
			out = append(out, code)
		}
	}
	return out
}

// ---- driver plumbing ----

type fakeConnector struct{ store *fakeStore }

func (c fakeConnector) Connect(context.Context) (driver.Conn, error) {
	return &fakeConn{store: c.store}, nil
}

func (c fakeConnector) Driver() driver.Driver { return fakeDriver{} }

type fakeDriver struct{}

func (fakeDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("fakeDriver: Open is not supported; use the connector")
}

type fakeConn struct{ store *fakeStore }

func (c *fakeConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("fakeConn: Prepare is not supported")
}

func (c *fakeConn) Close() error { return nil }

func (c *fakeConn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}

func (c *fakeConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	c.store.mu.Lock()
	defer c.store.mu.Unlock()
	tx := &fakeTx{}
	c.store.tx = tx
	return &fakeDriverTx{store: c.store, tx: tx}, nil
}

func (c *fakeConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	return c.store.exec(query, args)
}

func (c *fakeConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	return c.store.query(query, args)
}

type fakeDriverTx struct {
	store *fakeStore
	tx    *fakeTx
}

func (t *fakeDriverTx) Commit() error {
	t.store.mu.Lock()
	defer t.store.mu.Unlock()
	t.tx.done = true
	t.tx.undos = nil
	t.store.tx = nil
	t.store.commitCalls++
	return nil
}

func (t *fakeDriverTx) Rollback() error {
	t.store.mu.Lock()
	defer t.store.mu.Unlock()
	if !t.tx.done {
		for index := len(t.tx.undos) - 1; index >= 0; index-- {
			t.tx.undos[index]()
		}
	}
	t.tx.done = true
	t.tx.undos = nil
	t.store.tx = nil
	t.store.rollbackCalls++
	return nil
}

type fakeResult struct{ rows int64 }

func (r fakeResult) LastInsertId() (int64, error) { return 0, nil }
func (r fakeResult) RowsAffected() (int64, error) { return r.rows, nil }

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

// ---- argument helpers ----

func argAt(args []driver.NamedValue, index int) driver.Value {
	if index >= len(args) {
		return nil
	}
	return args[index].Value
}

func argString(args []driver.NamedValue, index int) string {
	text, _ := argAt(args, index).(string)
	return text
}

func argBytes(args []driver.NamedValue, index int) []byte {
	switch value := argAt(args, index).(type) {
	case []byte:
		return value
	case string:
		return []byte(value)
	default:
		return nil
	}
}

func argTime(args []driver.NamedValue, index int) (time.Time, bool) {
	value, ok := argAt(args, index).(time.Time)
	return value, ok
}

func argBool(args []driver.NamedValue, index int) bool {
	value, _ := argAt(args, index).(bool)
	return value
}

// ---- queries ----

func (s *fakeStore) query(query string, args []driver.NamedValue) (driver.Rows, error) {
	s.record(query)
	s.mu.Lock()
	defer s.mu.Unlock()

	switch {
	case strings.Contains(query, "SELECT GET_LOCK"):
		return &fakeRows{columns: []string{"acquired"}, rows: [][]driver.Value{{s.getLock}}}, nil
	case strings.Contains(query, "SELECT RELEASE_LOCK"):
		return &fakeRows{columns: []string{"released"}, rows: [][]driver.Value{{s.releaseLock}}}, nil
	case strings.Contains(query, "SELECT `email` FROM `User`"):
		email, found := s.users[argString(args, 0)]
		if !found {
			return &fakeRows{columns: []string{"email"}}, nil
		}
		return &fakeRows{columns: []string{"email"}, rows: [][]driver.Value{{email}}}, nil
	case strings.Contains(query, "SELECT `orgId` FROM `Membership`"):
		rows := [][]driver.Value{}
		for _, orgID := range s.memberships[argString(args, 0)] {
			rows = append(rows, []driver.Value{orgID})
		}
		return &fakeRows{columns: []string{"orgId"}, rows: rows}, nil
	case strings.Contains(query, "SELECT `value` FROM `SystemSetting`"):
		value, found := s.settings[argString(args, 0)]
		if !found {
			return &fakeRows{columns: []string{"value"}}, nil
		}
		return &fakeRows{columns: []string{"value"}, rows: [][]driver.Value{{[]byte(value)}}}, nil
	case strings.Contains(query, "SELECT COUNT(*) FROM `UserRecoveryCode`"):
		return &fakeRows{columns: []string{"count"}, rows: [][]driver.Value{{int64(s.unusedRecoveryCount(argString(args, 0)))}}}, nil
	case strings.Contains(query, "SELECT `id` FROM `UserRecoveryCode`"):
		userID, codeHash := argString(args, 0), argString(args, 1)
		for _, code := range s.recovery {
			if code.userID == userID && code.codeHash == codeHash && code.usedAt == nil {
				return &fakeRows{columns: []string{"id"}, rows: [][]driver.Value{{code.id}}}, nil
			}
		}
		return &fakeRows{columns: []string{"id"}}, nil
	case strings.Contains(query, "FROM `UserTotpFactor` WHERE `userId`"):
		factor, found := s.factors[argString(args, 0)]
		if !found {
			return &fakeRows{columns: []string{"secret"}}, nil
		}
		return &fakeRows{
			columns: strings.Split(factorColumns, ", "),
			rows: [][]driver.Value{{
				nullableBytes(factor.secret),
				nullableBytes(factor.pendingSecret),
				nullableString(factor.label),
				nullableString(factor.pendingLabel),
				factor.enrolledAt,
				nullableTime(factor.verifiedAt),
				nullableTime(factor.disabledAt),
				nullableTime(factor.lastUsedAt),
			}},
		}, nil
	case strings.Contains(query, "FROM `OrgOidcConfig` WHERE `orgId`"):
		row, found := s.oidc[argString(args, 0)]
		if !found {
			return &fakeRows{columns: []string{"enabled"}}, nil
		}
		return &fakeRows{
			columns: strings.Split(oidcColumns, ", "),
			rows: [][]driver.Value{{
				row.enabled,
				row.issuerURL,
				nullableString(row.discoveryURL),
				row.clientID,
				nullableBytes(row.clientSecret),
				nullableBytes(row.scopes),
				nullableString(row.buttonLabel),
				row.requireEmailVerified,
			}},
		}, nil
	case strings.Contains(query, "FROM MachineAccessToken t"):
		token, found := s.machineToken[argString(args, 0)]
		if !found {
			return &fakeRows{columns: []string{"id"}}, nil
		}
		active := int64(0)
		if token.orgActive {
			active = 1
		}
		return &fakeRows{
			columns: []string{"id", "orgId", "permissions", "expiresAt", "revokedAt", "isActive"},
			rows: [][]driver.Value{{
				token.id,
				token.orgID,
				[]byte(token.permissions),
				nullableTime(token.expiresAt),
				nullableTime(token.revokedAt),
				active,
			}},
		}, nil
	default:
		return &fakeRows{columns: []string{"value"}}, nil
	}
}

func nullableBytes(value []byte) driver.Value {
	if len(value) == 0 {
		return nil
	}
	return value
}

func nullableString(value *string) driver.Value {
	if value == nil {
		return nil
	}
	return *value
}

func nullableTime(value *time.Time) driver.Value {
	if value == nil {
		return nil
	}
	return *value
}

// ---- mutations ----

func (s *fakeStore) exec(query string, args []driver.NamedValue) (driver.Result, error) {
	s.record(query)
	s.mu.Lock()
	defer s.mu.Unlock()

	for fragment, failure := range s.execFailures {
		if strings.Contains(query, fragment) {
			return nil, failure
		}
	}

	switch {
	case strings.Contains(query, "INSERT INTO `UserTotpFactor`"):
		userID := argString(args, 1)
		previous, existed := s.factors[userID]
		label := argString(args, 3)
		now, _ := argTime(args, 4)
		factor := &fakeFactor{
			id:         argString(args, 0),
			secret:     argBytes(args, 2),
			label:      &label,
			enrolledAt: now,
		}
		s.factors[userID] = factor
		s.undo(func() {
			if existed {
				s.factors[userID] = previous
				return
			}
			delete(s.factors, userID)
		})
		return fakeResult{rows: 1}, nil
	case strings.Contains(query, "SET `pendingSecret`"):
		userID := argString(args, 4)
		previous, existed := s.factors[userID]
		if !existed {
			return fakeResult{rows: 0}, nil
		}
		label := argString(args, 1)
		started, _ := argTime(args, 2)
		copy := *previous
		copy.pendingSecret = argBytes(args, 0)
		copy.pendingLabel = &label
		copy.pendingStartedAt = &started
		s.factors[userID] = &copy
		s.undo(func() { s.factors[userID] = previous })
		return fakeResult{rows: 1}, nil
	case strings.Contains(query, "SET `secret` = ?"):
		userID := argString(args, 6)
		previous, existed := s.factors[userID]
		if !existed {
			return fakeResult{rows: 0}, nil
		}
		label := argString(args, 1)
		enrolledAt, _ := argTime(args, 2)
		verifiedAt, _ := argTime(args, 3)
		copy := *previous
		copy.secret = argBytes(args, 0)
		copy.label = &label
		copy.pendingSecret = nil
		copy.pendingLabel = nil
		copy.pendingStartedAt = nil
		copy.enrolledAt = enrolledAt
		copy.verifiedAt = &verifiedAt
		copy.disabledAt = nil
		copy.lastUsedAt = &verifiedAt
		s.factors[userID] = &copy
		s.undo(func() { s.factors[userID] = previous })
		return fakeResult{rows: 1}, nil
	case strings.Contains(query, "SET `lastUsedAt`"):
		userID := argString(args, 2)
		previous, existed := s.factors[userID]
		if !existed {
			return fakeResult{rows: 0}, nil
		}
		usedAt, _ := argTime(args, 0)
		copy := *previous
		copy.lastUsedAt = &usedAt
		s.factors[userID] = &copy
		s.undo(func() { s.factors[userID] = previous })
		return fakeResult{rows: 1}, nil
	case strings.Contains(query, "SET `disabledAt`"):
		userID := argString(args, 2)
		previous, existed := s.factors[userID]
		if !existed {
			return fakeResult{rows: 0}, nil
		}
		disabledAt, _ := argTime(args, 0)
		copy := *previous
		copy.disabledAt = &disabledAt
		s.factors[userID] = &copy
		s.undo(func() { s.factors[userID] = previous })
		return fakeResult{rows: 1}, nil
	case strings.Contains(query, "UPDATE `UserRecoveryCode` SET `usedAt`"):
		id := argString(args, 1)
		for index, code := range s.recovery {
			if code.id != id || code.usedAt != nil {
				continue
			}
			usedAt, _ := argTime(args, 0)
			previous := *code
			updated := previous
			updated.usedAt = &usedAt
			s.recovery[index] = &updated
			s.undo(func() { s.recovery[index] = &previous })
			return fakeResult{rows: 1}, nil
		}
		return fakeResult{rows: 0}, nil
	case strings.Contains(query, "DELETE FROM `UserRecoveryCode`"):
		userID := argString(args, 0)
		removed := []*fakeRecoveryCode{}
		kept := []*fakeRecoveryCode{}
		for _, code := range s.recovery {
			if code.userID == userID {
				removed = append(removed, code)
				continue
			}
			kept = append(kept, code)
		}
		s.recovery = kept
		s.undo(func() { s.recovery = append(s.recovery, removed...) })
		return fakeResult{rows: int64(len(removed))}, nil
	case strings.Contains(query, "INSERT INTO `UserRecoveryCode`"):
		id := argString(args, 0)
		userID := argString(args, 1)
		codeHash := argString(args, 2)
		createdAt, _ := argTime(args, 3)
		row := &fakeRecoveryCode{id: id, userID: userID, codeHash: codeHash, createdAt: createdAt}
		s.recovery = append(s.recovery, row)
		s.undo(func() {
			for index, existing := range s.recovery {
				if existing == row {
					s.recovery = append(s.recovery[:index], s.recovery[index+1:]...)
					return
				}
			}
		})
		return fakeResult{rows: 1}, nil
	case strings.Contains(query, "INSERT INTO `OrgOidcConfig`"):
		orgID := argString(args, 1)
		previous, existed := s.oidc[orgID]
		row := &fakeOidcConfig{id: argString(args, 0), orgID: orgID}
		if strings.Contains(query, "`clientSecret`") {
			row.enabled = argBool(args, 2)
			row.issuerURL = argString(args, 3)
			row.discoveryURL = bytesPointer(argBytes(args, 4))
			row.clientID = argString(args, 5)
			row.clientSecret = argBytes(args, 6)
			row.scopes = argBytes(args, 7)
			row.buttonLabel = bytesPointer(argBytes(args, 8))
			row.requireEmailVerified = argBool(args, 9)
		} else {
			row.enabled = argBool(args, 2)
			row.issuerURL = argString(args, 3)
			row.discoveryURL = bytesPointer(argBytes(args, 4))
			row.clientID = argString(args, 5)
			row.scopes = argBytes(args, 6)
			row.buttonLabel = bytesPointer(argBytes(args, 7))
			row.requireEmailVerified = argBool(args, 8)
			// AF4: the statement omits the column entirely, so an existing row
			// keeps the database's current bytes.
			if existed {
				row.clientSecret = previous.clientSecret
			}
		}
		s.oidc[orgID] = row
		s.undo(func() {
			if existed {
				s.oidc[orgID] = previous
				return
			}
			delete(s.oidc, orgID)
		})
		return fakeResult{rows: 1}, nil
	case strings.Contains(query, "UPDATE MachineAccessToken SET lastUsedAt"):
		return fakeResult{rows: 1}, nil
	default:
		return fakeResult{rows: 1}, nil
	}
}

func bytesPointer(value []byte) *string {
	if value == nil {
		return nil
	}
	text := string(value)
	return &text
}
