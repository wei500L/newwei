// Package metrics is the Go implementation of the platform Prometheus metrics
// surface.
//
// # Scope
//
// It reproduces apps/api/src/modules/observability/prometheus-metrics.ts: the
// five custom metric families (name, type, help, label names, histogram
// buckets) and the text exposition format. The process metrics the Node client
// exposes as nodejs_* cannot exist in Go, so this package renders Go runtime and
// process values as go_*/process_* instead. The mapping is documented in
// processMetrics; dashboards and alerts that read nodejs_* must be updated.
//
// # No new dependency
//
// go.mod deliberately has no prometheus/client_golang. Only counter, gauge and
// histogram are needed, so the registry and the text encoder are implemented on
// the standard library. The encoder follows prom-client 15.1.3: HELP/TYPE lines,
// `\`/newline escaping in HELP, `\`/quote/newline escaping in label values, and
// histogram _bucket (including le="+Inf"), _sum and _count series.
//
// # Authorization
//
// GET /api/metrics is process-wide and cross-tenant. It requires the
// metrics.read permission and a platform administrator. A machine token is
// allowed only when its creator is a platform administrator *now*: the handler
// re-reads MachineAccessToken and GlobalRoleAssignment instead of trusting a
// claim (SEC-03, resolvePlatformMetricsAccess).
//
// # Reuse
//
// The package-level default registry and Record*/Set* functions mirror the
// module-level prom-client register, so another migrated unit (for example the
// scheduler that records scheduler_runs_total) can call
// metrics.RecordSchedulerRun without creating a second registry.
package metrics

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// MetricType is the Prometheus exposition type.
type MetricType string

const (
	// TypeCounter is a monotonically increasing value.
	TypeCounter MetricType = "counter"
	// TypeGauge is a value that can go up and down.
	TypeGauge MetricType = "gauge"
	// TypeHistogram is a bucketed observation distribution.
	TypeHistogram MetricType = "histogram"
)

// ContentType is Registry.PROMETHEUS_CONTENT_TYPE from prom-client 15.1.3.
const ContentType = "text/plain; version=0.0.4; charset=utf-8"

// Registry owns a set of metric families. It is safe for concurrent use.
type Registry struct {
	mu       sync.RWMutex
	families map[string]*family
}

// NewRegistry builds an empty registry.
func NewRegistry() *Registry {
	return &Registry{families: map[string]*family{}}
}

// Counter registers (or returns) one counter family.
func (r *Registry) Counter(name, help string, labelNames ...string) *Counter {
	return &Counter{family: r.register(name, help, TypeCounter, labelNames, nil)}
}

// Gauge registers (or returns) one gauge family.
func (r *Registry) Gauge(name, help string, labelNames ...string) *Gauge {
	return &Gauge{family: r.register(name, help, TypeGauge, labelNames, nil)}
}

// Histogram registers (or returns) one histogram family.
func (r *Registry) Histogram(name, help string, buckets []float64, labelNames ...string) *Histogram {
	return &Histogram{family: r.register(name, help, TypeHistogram, labelNames, buckets)}
}

// register is idempotent per name, like register.getSingleMetric(name) ??
// new Counter(...) in prometheus-metrics.ts.
func (r *Registry) register(name, help string, kind MetricType, labelNames []string, buckets []float64) *family {
	r.mu.Lock()
	defer r.mu.Unlock()
	if existing, ok := r.families[name]; ok {
		return existing
	}
	family := &family{
		name:       name,
		help:       help,
		kind:       kind,
		labelNames: append([]string{}, labelNames...),
		buckets:    append([]float64{}, buckets...),
		series:     map[string]*series{},
	}
	r.families[name] = family
	return family
}

// family is one metric family.
type family struct {
	name       string
	help       string
	kind       MetricType
	labelNames []string
	buckets    []float64

	mu     sync.Mutex
	series map[string]*series
}

// series is one label-value combination.
type series struct {
	labelValues []string
	// value is used by counters and gauges.
	value float64
	// bucketCounts is non-cumulative for histograms: index i counts the
	// observations that fell into bucket i.
	bucketCounts []uint64
	// sum and count are the histogram aggregates.
	sum   float64
	count uint64
}

// Counter is a handle to one counter family.
type Counter struct{ family *family }

// Inc adds one to the series selected by labelValues.
func (c *Counter) Inc(labelValues ...string) { c.Add(1, labelValues...) }

// Add adds delta to the series selected by labelValues.
func (c *Counter) Add(delta float64, labelValues ...string) {
	if c == nil || c.family == nil || math.IsNaN(delta) {
		return
	}
	entry := c.family.entry(labelValues)
	if entry == nil {
		return
	}
	c.family.mu.Lock()
	entry.value += delta
	c.family.mu.Unlock()
}

// Gauge is a handle to one gauge family.
type Gauge struct{ family *family }

// Set replaces the series value.
func (g *Gauge) Set(value float64, labelValues ...string) {
	if g == nil || g.family == nil || math.IsNaN(value) {
		return
	}
	entry := g.family.entry(labelValues)
	if entry == nil {
		return
	}
	g.family.mu.Lock()
	entry.value = value
	g.family.mu.Unlock()
}

// Histogram is a handle to one histogram family.
type Histogram struct{ family *family }

// Observe records one value in the series selected by labelValues.
func (h *Histogram) Observe(value float64, labelValues ...string) {
	if h == nil || h.family == nil || math.IsNaN(value) {
		return
	}
	entry := h.family.entry(labelValues)
	if entry == nil {
		return
	}
	h.family.mu.Lock()
	entry.observe(value, h.family.buckets)
	h.family.mu.Unlock()
}

// entry returns the series for one label tuple, creating it when needed. A
// wrong label count is ignored: prom-client throws, but a background recorder
// must never crash the process.
func (f *family) entry(labelValues []string) *series {
	if len(labelValues) != len(f.labelNames) {
		return nil
	}
	key := strings.Join(labelValues, "\x00")
	f.mu.Lock()
	defer f.mu.Unlock()
	if existing, ok := f.series[key]; ok {
		return existing
	}
	entry := &series{
		labelValues: append([]string{}, labelValues...),
	}
	if f.kind == TypeHistogram {
		entry.bucketCounts = make([]uint64, len(f.buckets))
	}
	f.series[key] = entry
	return entry
}

// observe increments the matching non-cumulative bucket plus the aggregates.
func (s *series) observe(value float64, buckets []float64) {
	for index, bound := range buckets {
		if value <= bound {
			s.bucketCounts[index]++
			break
		}
	}
	s.sum += value
	s.count++
}

// snapshot is one immutable render input.
type snapshot struct {
	name       string
	help       string
	kind       MetricType
	labelNames []string
	buckets    []float64
	series     []seriesSnapshot
}

// seriesSnapshot is one immutable series.
type seriesSnapshot struct {
	labelValues  []string
	value        float64
	bucketCounts []uint64
	sum          float64
	count        uint64
}

// snapshot copies the registry state so rendering never holds the locks while
// encoding.
func (r *Registry) snapshot() []snapshot {
	r.mu.RLock()
	families := make([]*family, 0, len(r.families))
	for _, item := range r.families {
		families = append(families, item)
	}
	r.mu.RUnlock()

	out := make([]snapshot, 0, len(families))
	for _, item := range families {
		item.mu.Lock()
		entry := snapshot{
			name:       item.name,
			help:       item.help,
			kind:       item.kind,
			labelNames: append([]string{}, item.labelNames...),
			buckets:    append([]float64{}, item.buckets...),
			series:     make([]seriesSnapshot, 0, len(item.series)),
		}
		for _, value := range item.series {
			entry.series = append(entry.series, seriesSnapshot{
				labelValues:  append([]string{}, value.labelValues...),
				value:        value.value,
				bucketCounts: append([]uint64{}, value.bucketCounts...),
				sum:          value.sum,
				count:        value.count,
			})
		}
		item.mu.Unlock()
		sort.Slice(entry.series, func(i, j int) bool {
			return strings.Join(entry.series[i].labelValues, "\x00") <
				strings.Join(entry.series[j].labelValues, "\x00")
		})
		out = append(out, entry)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

// render encodes one family in the Prometheus text format.
func render(snapshot snapshot) string {
	var builder strings.Builder
	builder.WriteString("# HELP ")
	builder.WriteString(snapshot.name)
	builder.WriteString(" ")
	builder.WriteString(escapeString(snapshot.help))
	builder.WriteString("\n# TYPE ")
	builder.WriteString(snapshot.name)
	builder.WriteString(" ")
	builder.WriteString(string(snapshot.kind))
	builder.WriteString("\n")

	for _, entry := range snapshot.series {
		switch snapshot.kind {
		case TypeHistogram:
			cumulative := uint64(0)
			for index, bound := range snapshot.buckets {
				cumulative += entry.bucketCounts[index]
				builder.WriteString(snapshot.name)
				builder.WriteString("_bucket")
				builder.WriteString(labelsString(
					append([]string{"le"}, snapshot.labelNames...),
					append([]string{formatNumber(bound)}, entry.labelValues...),
				))
				builder.WriteString(" ")
				builder.WriteString(formatNumber(float64(cumulative)))
				builder.WriteString("\n")
			}
			builder.WriteString(snapshot.name)
			builder.WriteString("_bucket")
			builder.WriteString(labelsString(
				append([]string{"le"}, snapshot.labelNames...),
				append([]string{"+Inf"}, entry.labelValues...),
			))
			builder.WriteString(" ")
			builder.WriteString(formatNumber(float64(entry.count)))
			builder.WriteString("\n")
			builder.WriteString(snapshot.name)
			builder.WriteString("_sum")
			builder.WriteString(labelsString(snapshot.labelNames, entry.labelValues))
			builder.WriteString(" ")
			builder.WriteString(formatNumber(entry.sum))
			builder.WriteString("\n")
			builder.WriteString(snapshot.name)
			builder.WriteString("_count")
			builder.WriteString(labelsString(snapshot.labelNames, entry.labelValues))
			builder.WriteString(" ")
			builder.WriteString(formatNumber(float64(entry.count)))
			builder.WriteString("\n")
		default:
			builder.WriteString(snapshot.name)
			builder.WriteString(labelsString(snapshot.labelNames, entry.labelValues))
			builder.WriteString(" ")
			builder.WriteString(formatNumber(entry.value))
			builder.WriteString("\n")
		}
	}
	return builder.String()
}

// labelsString renders `{name="value",...}` in declaration order. A family with
// no labels renders nothing.
func labelsString(names, values []string) string {
	if len(names) == 0 {
		return ""
	}
	var builder strings.Builder
	builder.WriteString("{")
	for index, name := range names {
		if index > 0 {
			builder.WriteString(",")
		}
		builder.WriteString(name)
		builder.WriteString("=\"")
		builder.WriteString(escapeLabelValue(values[index]))
		builder.WriteString("\"")
	}
	builder.WriteString("}")
	return builder.String()
}

// escapeString mirrors prom-client escapeString: backslash then newline.
func escapeString(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, `\`, `\\`), "\n", `\n`)
}

// escapeLabelValue adds the quote escape on top of escapeString.
func escapeLabelValue(value string) string {
	return strings.ReplaceAll(escapeString(value), `"`, `\"`)
}

// formatNumber mirrors JavaScript `${value}` for the values these families
// carry: NaN/Inf spellings, decimal notation in [-1e-6, 1e21), and a
// JavaScript-style exponent otherwise.
func formatNumber(value float64) string {
	switch {
	case math.IsNaN(value):
		return "Nan"
	case math.IsInf(value, 1):
		return "+Inf"
	case math.IsInf(value, -1):
		return "-Inf"
	case value == 0:
		return "0"
	}
	absolute := math.Abs(value)
	if absolute >= 1e-6 && absolute < 1e21 {
		return strconv.FormatFloat(value, 'f', -1, 64)
	}
	return normalizeExponent(strconv.FormatFloat(value, 'e', -1, 64))
}

// normalizeExponent drops the exponent zero padding Go adds (1e-07 -> 1e-7).
func normalizeExponent(value string) string {
	index := strings.IndexAny(value, "eE")
	if index < 0 {
		return value
	}
	mantissa := value[:index]
	exponent := value[index+1:]
	sign := ""
	if strings.HasPrefix(exponent, "+") || strings.HasPrefix(exponent, "-") {
		sign = exponent[:1]
		exponent = exponent[1:]
	}
	exponent = strings.TrimLeft(exponent, "0")
	if exponent == "" {
		exponent = "0"
	}
	return fmt.Sprintf("%se%s%s", mantissa, sign, exponent)
}
