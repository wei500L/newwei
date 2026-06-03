import type { InstrumentationConfigMap } from "@opentelemetry/auto-instrumentations-node";
import {
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type Sampler,
} from "@opentelemetry/sdk-trace-base";

const DEFAULT_TRACE_SAMPLE_RATE = 0.05;

export function resolveOtelTraceSampleRate(
  rawValue = process.env.OTEL_TRACE_SAMPLE_RATE,
): number {
  if (rawValue === undefined || rawValue === "") {
    return DEFAULT_TRACE_SAMPLE_RATE;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return DEFAULT_TRACE_SAMPLE_RATE;
  }

  return parsed;
}

export function createOtelSampler(
  sampleRate = resolveOtelTraceSampleRate(),
): Sampler {
  return new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(sampleRate),
  });
}

export function createOtelInstrumentationConfig(): InstrumentationConfigMap {
  return {
    "@opentelemetry/instrumentation-dns": { enabled: false },
    "@opentelemetry/instrumentation-fs": { enabled: false },
    "@opentelemetry/instrumentation-ioredis": { enabled: false },
    "@opentelemetry/instrumentation-mongodb": { enabled: false },
    "@opentelemetry/instrumentation-mongoose": { enabled: false },
    "@opentelemetry/instrumentation-mysql": { enabled: false },
    "@opentelemetry/instrumentation-mysql2": { enabled: false },
    "@opentelemetry/instrumentation-net": { enabled: false },
    "@opentelemetry/instrumentation-pg": { enabled: false },
    "@opentelemetry/instrumentation-redis": { enabled: false },
  };
}
