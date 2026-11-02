package metrics

import (
	"math"
	"sort"
	"strconv"
	"strings"
)

// HTTP request duration buckets, copied from prometheus-metrics.ts.
var httpRequestDurationBuckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}

// Background job duration buckets, copied from prometheus-metrics.ts.
var jobDurationBuckets = []float64{0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300}

// Scheduler run statuses accepted by recordSchedulerRun.
const (
	// SchedulerStatusSuccess is the "success" label value.
	SchedulerStatusSuccess = "success"
	// SchedulerStatusFailure is the "failure" label value.
	SchedulerStatusFailure = "failure"
)

// defaultRegistry is the process-wide registry, the Go equivalent of the
// prom-client module-level `register`.
var defaultRegistry = NewRegistry()

var (
	httpRequestDuration = defaultRegistry.Histogram(
		"http_request_duration_seconds",
		"HTTP request duration in seconds.",
		httpRequestDurationBuckets,
		"method", "route", "status_code",
	)
	jobDuration = defaultRegistry.Histogram(
		"background_job_duration_seconds",
		"Background job duration in seconds.",
		jobDurationBuckets,
		"queue", "job", "status",
	)
	integrationEvents = defaultRegistry.Counter(
		"integration_events_total",
		"External integration event counts.",
		"integration", "operation", "status",
	)
	schedulerRuns = defaultRegistry.Counter(
		"scheduler_runs_total",
		"Scheduled task run counts.",
		"scheduler", "status",
	)
	pipelineMetrics = defaultRegistry.Gauge(
		"pipeline_metric_value",
		"Latest pipeline metric value by slug.",
		"org_id", "metric",
	)
)

// Default returns the process-wide registry.
func Default() *Registry { return defaultRegistry }

// HTTPRequestInput is one observed HTTP request.
type HTTPRequestInput struct {
	Method     string
	Route      string
	StatusCode int
	DurationMS float64
}

// JobDurationInput is one observed background job.
type JobDurationInput struct {
	Queue      string
	Job        string
	Status     string
	DurationMS float64
}

// IntegrationEventInput is one observed external integration event.
type IntegrationEventInput struct {
	Integration string
	Operation   string
	Status      string
}

// RecordHTTPRequestMetric mirrors recordHttpRequestMetric: negative durations
// are clamped to zero and converted to seconds.
func RecordHTTPRequestMetric(input HTTPRequestInput) {
	httpRequestDuration.Observe(math.Max(0, input.DurationMS)/1000,
		input.Method, input.Route, strconv.Itoa(input.StatusCode))
}

// RecordJobDurationMetric mirrors recordJobDurationMetric.
func RecordJobDurationMetric(input JobDurationInput) {
	jobDuration.Observe(math.Max(0, input.DurationMS)/1000,
		input.Queue, input.Job, input.Status)
}

// RecordIntegrationEvent mirrors recordIntegrationEvent.
func RecordIntegrationEvent(input IntegrationEventInput) {
	integrationEvents.Inc(input.Integration, input.Operation, input.Status)
}

// RecordSchedulerRun mirrors recordSchedulerRun. It is the reuse point for the
// scheduler migrated by another unit (for example the classification quality
// alert scheduler).
func RecordSchedulerRun(scheduler, status string) {
	schedulerRuns.Inc(scheduler, status)
}

// SetPipelineMetric mirrors setPipelineMetric: non-finite values are ignored.
func SetPipelineMetric(orgID, metric string, value float64) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return
	}
	pipelineMetrics.Set(value, orgID, metric)
}

// Render encodes the default registry including the Go runtime/process series.
func Render() string { return defaultRegistry.Render() }

// Render encodes every registered family plus the Go runtime/process series.
func (r *Registry) Render() string {
	if r == nil {
		return ""
	}
	families := r.snapshot()
	families = append(families, runtimeFamilies()...)
	sort.Slice(families, func(i, j int) bool { return families[i].name < families[j].name })
	parts := make([]string, 0, len(families))
	for _, family := range families {
		parts = append(parts, render(family))
	}
	// Each rendered family ends with "\n"; one extra newline keeps the blank
	// line prom-client puts between families, and the last family keeps the
	// trailing newline.
	return strings.Join(parts, "\n")
}
