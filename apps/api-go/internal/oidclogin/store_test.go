package oidclogin

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// claimDriver records the one UPDATE issued by ClaimHandoff and returns a
// configurable affected-row count. It exercises the real SQL path without a
// server.
type claimDriver struct {
	mu    sync.Mutex
	query string
	args  []driver.NamedValue
	rows  int64
}

func (d *claimDriver) Connector() driver.Connector { return claimConnector{driver: d} }

type claimConnector struct{ driver *claimDriver }

func (c claimConnector) Connect(context.Context) (driver.Conn, error) {
	return claimConn{driver: c.driver}, nil
}
func (c claimConnector) Driver() driver.Driver { return claimDriverFactory{} }

type claimDriverFactory struct{}

func (claimDriverFactory) Open(string) (driver.Conn, error) { return nil, io.EOF }

type claimConn struct{ driver *claimDriver }

func (c claimConn) Prepare(string) (driver.Stmt, error) { return nil, io.EOF }
func (c claimConn) Close() error                        { return nil }
func (c claimConn) Begin() (driver.Tx, error)           { return nil, io.EOF }
func (c claimConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.driver.mu.Lock()
	defer c.driver.mu.Unlock()
	c.driver.query = query
	c.driver.args = args
	return claimResult{rows: c.driver.rows}, nil
}

type claimResult struct{ rows int64 }

func (r claimResult) LastInsertId() (int64, error) { return 0, nil }
func (r claimResult) RowsAffected() (int64, error) { return r.rows, nil }

func TestClaimHandoffUsesOneConditionalUpdate(t *testing.T) {
	for _, rows := range []int64{0, 1} {
		recorder := &claimDriver{rows: rows}
		store := newMySQLChallengeStore(sql.OpenDB(recorder.Connector()))
		claimed, err := store.ClaimHandoff(context.Background(), "hash-1", time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC))
		if err != nil {
			t.Fatal(err)
		}
		if claimed != (rows == 1) {
			t.Fatalf("rows=%d claimed=%v", rows, claimed)
		}
		for _, condition := range []string{"`consumedAt` IS NULL", "`expiresAt` >= ?", "`type` = ?", "`id` = ?"} {
			if !strings.Contains(recorder.query, condition) {
				t.Fatalf("claim query missing %q: %s", condition, recorder.query)
			}
		}
		if recorder.args[1].Value != "hash-1" || recorder.args[2].Value != challengeTypeSSOHandoff {
			t.Fatalf("claim args = %+v", recorder.args)
		}
	}
}
