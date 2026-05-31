import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  register,
} from "prom-client";

let defaultMetricsStarted = false;

function ensureDefaultMetrics() {
  if (defaultMetricsStarted) {
    return;
  }
  collectDefaultMetrics({ register });
  defaultMetricsStarted = true;
}

function getOrCreateCounter(
  name: string,
  help: string,
  labelNames: string[],
): Counter<string> {
  return (
    register.getSingleMetric(name) as Counter<string> | undefined
  ) ?? new Counter({ name, help, labelNames, registers: [register] });
}

function getOrCreateGauge(
  name: string,
  help: string,
  labelNames: string[],
): Gauge<string> {
  return (
    register.getSingleMetric(name) as Gauge<string> | undefined
  ) ?? new Gauge({ name, help, labelNames, registers: [register] });
}

function getOrCreateHistogram(
  name: string,
  help: string,
  labelNames: string[],
  buckets: number[],
): Histogram<string> {
  return (
    register.getSingleMetric(name) as Histogram<string> | undefined
  ) ?? new Histogram({ name, help, labelNames, buckets, registers: [register] });
}

ensureDefaultMetrics();

const httpRequestDuration = getOrCreateHistogram(
  "http_request_duration_seconds",
  "HTTP request duration in seconds.",
  ["method", "route", "status_code"],
  [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
);

const jobDuration = getOrCreateHistogram(
  "background_job_duration_seconds",
  "Background job duration in seconds.",
  ["queue", "job", "status"],
  [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
);

const integrationEvents = getOrCreateCounter(
  "integration_events_total",
  "External integration event counts.",
  ["integration", "operation", "status"],
);

const schedulerRuns = getOrCreateCounter(
  "scheduler_runs_total",
  "Scheduled task run counts.",
  ["scheduler", "status"],
);

const pipelineMetrics = getOrCreateGauge(
  "pipeline_metric_value",
  "Latest pipeline metric value by slug.",
  ["org_id", "metric"],
);

export function recordHttpRequestMetric(input: {
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
}) {
  httpRequestDuration
    .labels(input.method, input.route, String(input.statusCode))
    .observe(Math.max(0, input.durationMs) / 1000);
}

export function recordJobDurationMetric(input: {
  queue: string;
  job: string;
  status: string;
  durationMs: number;
}) {
  jobDuration
    .labels(input.queue, input.job, input.status)
    .observe(Math.max(0, input.durationMs) / 1000);
}

export function recordIntegrationEvent(input: {
  integration: string;
  operation: string;
  status: string;
}) {
  integrationEvents
    .labels(input.integration, input.operation, input.status)
    .inc();
}

export function recordSchedulerRun(scheduler: string, status: "success" | "failure") {
  schedulerRuns.labels(scheduler, status).inc();
}

export function setPipelineMetric(orgId: string, metric: string, value: number) {
  if (!Number.isFinite(value)) {
    return;
  }
  pipelineMetrics.labels(orgId, metric).set(value);
}

export async function renderPrometheusMetrics(): Promise<string> {
  ensureDefaultMetrics();
  return register.metrics();
}

export function prometheusContentType(): string {
  return register.contentType;
}
