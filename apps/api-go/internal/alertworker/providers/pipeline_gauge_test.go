package providers

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"io"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/metrics"
)

// pipelineGaugeValue returns the pipeline_metric_value series value for one
// tenant/slug pair, or (0, false) when the series is absent.
func pipelineGaugeValue(t *testing.T, orgID, metric string) (float64, bool) {
	t.Helper()
	for _, line := range strings.Split(metrics.Render(), "\n") {
		if !strings.HasPrefix(line, "pipeline_metric_value{") {
			continue
		}
		if !strings.Contains(line, `org_id="`+orgID+`"`) || !strings.Contains(line, `metric="`+metric+`"`) {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 {
			t.Fatalf("unexpected exposition line %q", line)
		}
		value, err := strconv.ParseFloat(fields[1], 64)
		if err != nil {
			t.Fatalf("parse %q: %v", line, err)
		}
		return value, true
	}
	return 0, false
}

// fakeMySQLDriver is a stdlib database/sql driver that answers the provider's two
// query shapes with fixed values. It stands in for the MySQL boundary the provider
// actually crosses, so the test exercises the real Fetch code (window arithmetic,
// context building, gauge export) rather than a reimplementation of it.
type fakeMySQLDriver struct {
	// counts are returned in order for each `SELECT COUNT(*)` query.
	counts []int64
	// durations are the completed/started pairs the ingestion query returns.
	durations []time.Duration
	// queried records every statement, so a test can assert the tenant filter.
	queried []string
	next    int
}

func (d *fakeMySQLDriver) Open(string) (driver.Conn, error) { return &fakeConn{driver: d}, nil }

type fakeConn struct{ driver *fakeMySQLDriver }

func (c *fakeConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (c *fakeConn) Close() error                        { return nil }
func (c *fakeConn) Begin() (driver.Tx, error)           { return nil, driver.ErrSkip }

func (c *fakeConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	c.driver.queried = append(c.driver.queried, query)
	if strings.Contains(query, "startedAt, completedAt") {
		rows := &durationRows{durations: c.driver.durations}
		return rows, nil
	}
	if strings.Contains(query, "COUNT(*)") {
		index := c.driver.next
		c.driver.next++
		var value int64
		if index < len(c.driver.counts) {
			value = c.driver.counts[index]
		}
		return &singleValueRows{value: value}, nil
	}
	return nil, fmt.Errorf("fake mysql: unexpected query %q", query)
}

// singleValueRows is a one-column, one-row result.
type singleValueRows struct {
	value int64
	done  bool
}

func (r *singleValueRows) Columns() []string { return []string{"count"} }
func (r *singleValueRows) Close() error      { return nil }

func (r *singleValueRows) Next(dest []driver.Value) error {
	if r.done {
		return io.EOF
	}
	r.done = true
	dest[0] = r.value
	return nil
}

// durationRows is the startedAt/completedAt pair result.
type durationRows struct {
	durations []time.Duration
	index     int
}

func (r *durationRows) Columns() []string { return []string{"startedAt", "completedAt"} }
func (r *durationRows) Close() error      { return nil }

func (r *durationRows) Next(dest []driver.Value) error {
	if r.index >= len(r.durations) {
		return io.EOF
	}
	started := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC).Add(time.Duration(r.index) * time.Minute)
	dest[0] = started
	dest[1] = started.Add(r.durations[r.index])
	r.index++
	return nil
}

// openFakeDB opens a *sql.DB backed by the fake driver.
func openFakeDB(t *testing.T, fake *fakeMySQLDriver) *sql.DB {
	t.Helper()
	name := "fake-mysql-" + t.Name()
	sql.Register(name, fake)
	db, err := sql.Open(name, "dsn")
	if err != nil {
		t.Fatalf("open fake mysql: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// TestPipelineRateMetricExportsTheGauge proves the success_rate branch publishes the
// gauge with the rule's organization and slug, which is what the NestJS provider does
// before it returns.
func TestPipelineRateMetricExportsTheGauge(t *testing.T) {
	for _, slug := range []string{"pipeline.success_rate", "pipeline.failure_rate"} {
		t.Run(slug, func(t *testing.T) {
			fake := &fakeMySQLDriver{counts: []int64{10, 7, 3}}
			provider := &pipelineProvider{deps: Dependencies{DB: openFakeDB(t, fake), Now: time.Now}}
			orgID := "org-" + strings.ReplaceAll(slug, ".", "-")
			evaluation, err := provider.Fetch(context.Background(), Rule{
				OrgID:      orgID,
				MetricSlug: slug,
			})
			if err != nil {
				t.Fatalf("Fetch: %v", err)
			}
			if evaluation.Latest == nil {
				t.Fatalf("no latest value")
			}
			want := 0.7
			if slug == "pipeline.failure_rate" {
				want = 0.3
			}
			if got := *evaluation.Latest; got != want {
				t.Fatalf("latest = %v, want %v", got, want)
			}
			exported, ok := pipelineGaugeValue(t, orgID, slug)
			if !ok {
				t.Fatalf("no pipeline_metric_value series for %s/%s", orgID, slug)
			}
			if exported != want {
				t.Fatalf("gauge = %v, want %v", exported, want)
			}
			// Every count query must carry the tenant filter.
			for _, query := range fake.queried {
				if !strings.Contains(query, "orgId = ?") {
					t.Fatalf("query without a tenant filter: %q", query)
				}
			}
		})
	}
}

// TestPipelineRateMetricExportsZeroForAnEmptyWindow proves a window with no jobs still
// publishes 0 instead of leaving the previous sample: NestJS's `total > 0 ? … : 0`
// then setPipelineMetric exports the zero.
func TestPipelineRateMetricExportsZeroForAnEmptyWindow(t *testing.T) {
	fake := &fakeMySQLDriver{counts: []int64{0, 0, 0}}
	provider := &pipelineProvider{deps: Dependencies{DB: openFakeDB(t, fake), Now: time.Now}}
	evaluation, err := provider.Fetch(context.Background(), Rule{
		OrgID:      "org-empty-window",
		MetricSlug: "pipeline.success_rate",
	})
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if evaluation.Latest == nil || *evaluation.Latest != 0 {
		t.Fatalf("latest = %v, want 0", evaluation.Latest)
	}
	exported, ok := pipelineGaugeValue(t, "org-empty-window", "pipeline.success_rate")
	if !ok {
		t.Fatal("no gauge series for an empty window")
	}
	if exported != 0 {
		t.Fatalf("gauge = %v, want 0", exported)
	}
}

// TestPipelineIngestionMetricExportsBothPercentiles proves the p90 and p99 branches
// each publish their own slug.
func TestPipelineIngestionMetricExportsBothPercentiles(t *testing.T) {
	durations := make([]time.Duration, 10)
	for index := range durations {
		durations[index] = time.Duration(index+1) * time.Millisecond
	}
	for _, slug := range []string{"pipeline.ingestion_p90_ms", "pipeline.ingestion_p99_ms"} {
		t.Run(slug, func(t *testing.T) {
			fake := &fakeMySQLDriver{durations: durations}
			provider := &pipelineProvider{deps: Dependencies{DB: openFakeDB(t, fake), Now: time.Now}}
			orgID := "org-" + slug
			evaluation, err := provider.Fetch(context.Background(), Rule{OrgID: orgID, MetricSlug: slug})
			if err != nil {
				t.Fatalf("Fetch: %v", err)
			}
			if evaluation.Latest == nil {
				t.Fatalf("no latest value")
			}
			exported, ok := pipelineGaugeValue(t, orgID, slug)
			if !ok {
				t.Fatalf("no gauge series for %s/%s", orgID, slug)
			}
			if exported != *evaluation.Latest {
				t.Fatalf("gauge %v != latest %v", exported, *evaluation.Latest)
			}
		})
	}
}
