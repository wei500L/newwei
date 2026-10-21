package classificationalert

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"io"
	"sync"
	"testing"
	"time"
)

// ---- stub MySQL driver ----

// stubState is the mutable result of the stubbed SystemSetting query.
type stubState struct {
	mu      sync.Mutex
	noRows  bool
	value   []byte
	queries int
}

// stubConnector builds a database/sql DB around stubState without touching a
// real MySQL server.
type stubConnector struct {
	state *stubState
}

// Connect implements driver.Connector.
func (c stubConnector) Connect(context.Context) (driver.Conn, error) {
	return stubConn{state: c.state}, nil
}

// Driver implements driver.Connector.
func (c stubConnector) Driver() driver.Driver { return stubDriver{} }

// stubDriver is the driver.Driver behind stubConnector.
type stubDriver struct{}

// Open implements driver.Driver.
func (stubDriver) Open(string) (driver.Conn, error) {
	return nil, io.ErrClosedPipe
}

// stubConn implements driver.Conn and driver.QueryerContext.
type stubConn struct {
	state *stubState
}

// Prepare implements driver.Conn.
func (c stubConn) Prepare(string) (driver.Stmt, error) {
	return nil, io.ErrClosedPipe
}

// Close implements driver.Conn.
func (c stubConn) Close() error { return nil }

// Begin implements driver.Conn.
func (c stubConn) Begin() (driver.Tx, error) { return nil, io.ErrClosedPipe }

// QueryContext returns the configured SystemSetting value or no rows.
func (c stubConn) QueryContext(context.Context, string, []driver.NamedValue) (driver.Rows, error) {
	c.state.mu.Lock()
	defer c.state.mu.Unlock()
	c.state.queries++
	if c.state.noRows {
		return &stubRows{}, nil
	}
	return &stubRows{value: append([]byte{}, c.state.value...)}, nil
}

// stubRows is a one-row result set.
type stubRows struct {
	value    []byte
	consumed bool
}

// Columns implements driver.Rows.
func (*stubRows) Columns() []string { return []string{"value"} }

// Close implements driver.Rows.
func (*stubRows) Close() error { return nil }

// Next implements driver.Rows.
func (r *stubRows) Next(destination []driver.Value) error {
	if r.consumed || len(r.value) == 0 {
		return io.EOF
	}
	r.consumed = true
	destination[0] = r.value
	return nil
}

// queryCount returns the number of executed stub queries.
func (s *stubState) queryCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.queries
}

// setValue replaces the stored JSON the stub returns.
func (s *stubState) setValue(raw string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.value = []byte(raw)
	s.noRows = false
}

// openStubDB builds a *sql.DB backed by the stub state.
func openStubDB(t *testing.T, state *stubState) *sql.DB {
	t.Helper()
	db := sql.OpenDB(stubConnector{state: state})
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// ---- parser tests ----

// TestParseClassificationQualityAlertConcurrency locks the stored-setting
// semantics of MultiTenantSchedulerSettingsService.getSettings: absent keys fall
// back to the default, a present value must coerce to an integer in 1..16, and
// any invalid concurrency field invalidates the whole record.
func TestParseClassificationQualityAlertConcurrency(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		want    int
		wantErr bool
	}{
		{name: "field stored", raw: `{"classificationQualityAlertOrgConcurrency":2}`, want: 2},
		{name: "field absent", raw: `{}`, want: defaultOrgConcurrency},
		{name: "other fields present", raw: `{"realtimeSignalsOrgConcurrency":2,"classificationQualityAlertOrgConcurrency":3}`, want: 3},
		{name: "integer bounds", raw: `{"classificationQualityAlertOrgConcurrency":16}`, want: 16},
		{name: "numeric string coerces", raw: `{"classificationQualityAlertOrgConcurrency":"5"}`, want: 5},
		{name: "integral float accepted", raw: `{"classificationQualityAlertOrgConcurrency":4.0}`, want: 4},
		{name: "single element array coerces", raw: `{"classificationQualityAlertOrgConcurrency":[6]}`, want: 6},
		{name: "zero invalid", raw: `{"classificationQualityAlertOrgConcurrency":0}`, wantErr: true},
		{name: "above bound invalid", raw: `{"classificationQualityAlertOrgConcurrency":17}`, wantErr: true},
		{name: "fraction invalid", raw: `{"classificationQualityAlertOrgConcurrency":1.5}`, wantErr: true},
		{name: "null invalid", raw: `{"classificationQualityAlertOrgConcurrency":null}`, wantErr: true},
		{name: "non numeric string invalid", raw: `{"classificationQualityAlertOrgConcurrency":"many"}`, wantErr: true},
		{name: "other invalid field invalidates", raw: `{"realtimeSignalsOrgConcurrency":99}`, wantErr: true},
		{name: "other null field invalidates", raw: `{"newsEventsTimelineOrgConcurrency":null}`, wantErr: true},
		{name: "json null invalid", raw: `null`, wantErr: true},
		{name: "json array invalid", raw: `[]`, wantErr: true},
		{name: "malformed json invalid", raw: `{`, wantErr: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			value, err := parseClassificationQualityAlertConcurrency([]byte(testCase.raw))
			if testCase.wantErr {
				if err == nil {
					t.Fatalf("parse(%s) = %d, want error", testCase.raw, value)
				}
				return
			}
			if err != nil {
				t.Fatalf("parse(%s): %v", testCase.raw, err)
			}
			if value != testCase.want {
				t.Fatalf("parse(%s) = %d, want %d", testCase.raw, value, testCase.want)
			}
		})
	}
}

// TestSystemSettingConcurrencyReaderQueryAndCache covers the SQL read, the
// missing-row default, the fail-closed invalid record and the 30 second runtime
// cache.
func TestSystemSettingConcurrencyReaderQueryAndCache(t *testing.T) {
	t.Run("stored value", func(t *testing.T) {
		state := &stubState{value: []byte(`{"classificationQualityAlertOrgConcurrency":2}`)}
		reader := newSystemSettingConcurrencyReader(openStubDB(t, state), fixedNow)
		value, err := reader.ReadClassificationQualityAlertOrgConcurrency(context.Background())
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if value != 2 {
			t.Fatalf("value = %d, want 2", value)
		}
		if queries := state.queryCount(); queries != 1 {
			t.Fatalf("queries = %d, want 1", queries)
		}
	})

	t.Run("missing row uses the default", func(t *testing.T) {
		state := &stubState{noRows: true}
		reader := newSystemSettingConcurrencyReader(openStubDB(t, state), fixedNow)
		value, err := reader.ReadClassificationQualityAlertOrgConcurrency(context.Background())
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if value != defaultOrgConcurrency {
			t.Fatalf("value = %d, want %d", value, defaultOrgConcurrency)
		}
	})

	t.Run("invalid record is not cached", func(t *testing.T) {
		state := &stubState{value: []byte(`{"classificationQualityAlertOrgConcurrency":99}`)}
		var clock time.Time = fixedNow()
		reader := newSystemSettingConcurrencyReader(openStubDB(t, state), func() time.Time { return clock })
		for attempt := 0; attempt < 2; attempt++ {
			if _, err := reader.ReadClassificationQualityAlertOrgConcurrency(context.Background()); err == nil {
				t.Fatalf("attempt %d: read returned no error", attempt)
			}
			clock = clock.Add(time.Second)
		}
		if queries := state.queryCount(); queries != 2 {
			t.Fatalf("queries = %d, want 2 (errors must not be cached)", queries)
		}
	})

	t.Run("runtime cache holds for 30 seconds", func(t *testing.T) {
		state := &stubState{value: []byte(`{"classificationQualityAlertOrgConcurrency":2}`)}
		var clock time.Time = fixedNow()
		reader := newSystemSettingConcurrencyReader(openStubDB(t, state), func() time.Time { return clock })

		value, err := reader.ReadClassificationQualityAlertOrgConcurrency(context.Background())
		if err != nil || value != 2 {
			t.Fatalf("first read = %d, %v", value, err)
		}
		state.setValue(`{"classificationQualityAlertOrgConcurrency":7}`)

		clock = clock.Add(10 * time.Second)
		value, err = reader.ReadClassificationQualityAlertOrgConcurrency(context.Background())
		if err != nil || value != 2 {
			t.Fatalf("cached read = %d, %v; want 2", value, err)
		}
		if queries := state.queryCount(); queries != 1 {
			t.Fatalf("queries = %d, want 1 during the cache window", queries)
		}

		clock = clock.Add(21 * time.Second)
		value, err = reader.ReadClassificationQualityAlertOrgConcurrency(context.Background())
		if err != nil || value != 7 {
			t.Fatalf("expired read = %d, %v; want 7", value, err)
		}
		if queries := state.queryCount(); queries != 2 {
			t.Fatalf("queries = %d, want 2 after the cache expired", queries)
		}
	})
}

// TestClampConcurrency pins the settleWithConcurrency bounds.
func TestClampConcurrency(t *testing.T) {
	cases := []struct {
		concurrency int
		itemCount   int
		want        int
	}{
		{concurrency: 0, itemCount: 4, want: 1},
		{concurrency: -1, itemCount: 4, want: 1},
		{concurrency: 2, itemCount: 4, want: 2},
		{concurrency: 99, itemCount: 4, want: 4},
		{concurrency: 1, itemCount: 1, want: 1},
	}
	for _, testCase := range cases {
		if got := clampConcurrency(testCase.concurrency, testCase.itemCount); got != testCase.want {
			t.Fatalf("clampConcurrency(%d, %d) = %d, want %d",
				testCase.concurrency, testCase.itemCount, got, testCase.want)
		}
	}
}
