import {
  createOtelInstrumentationConfig,
  createOtelSampler,
  resolveOtelTraceSampleRate,
} from "./otel-config";

describe("otel config", () => {
  it("defaults to conservative trace sampling", () => {
    const original = process.env.OTEL_TRACE_SAMPLE_RATE;
    delete process.env.OTEL_TRACE_SAMPLE_RATE;
    try {
      expect(resolveOtelTraceSampleRate()).toBe(0.05);
      expect(createOtelSampler().toString()).toContain(
        "TraceIdRatioBased{0.05}",
      );
    } finally {
      if (original === undefined) {
        delete process.env.OTEL_TRACE_SAMPLE_RATE;
      } else {
        process.env.OTEL_TRACE_SAMPLE_RATE = original;
      }
    }
  });

  it("accepts valid sample rates and falls back for invalid values", () => {
    expect(resolveOtelTraceSampleRate("0")).toBe(0);
    expect(resolveOtelTraceSampleRate("0.25")).toBe(0.25);
    expect(resolveOtelTraceSampleRate("1")).toBe(1);
    expect(resolveOtelTraceSampleRate("-0.1")).toBe(0.05);
    expect(resolveOtelTraceSampleRate("1.1")).toBe(0.05);
    expect(resolveOtelTraceSampleRate("not-a-number")).toBe(0.05);
  });

  it("disables low-level hot-path instrumentations", () => {
    const config = createOtelInstrumentationConfig();

    for (const name of [
      "@opentelemetry/instrumentation-dns",
      "@opentelemetry/instrumentation-fs",
      "@opentelemetry/instrumentation-ioredis",
      "@opentelemetry/instrumentation-mongodb",
      "@opentelemetry/instrumentation-mongoose",
      "@opentelemetry/instrumentation-mysql",
      "@opentelemetry/instrumentation-mysql2",
      "@opentelemetry/instrumentation-net",
      "@opentelemetry/instrumentation-pg",
      "@opentelemetry/instrumentation-redis",
    ] as const) {
      expect(config[name]).toEqual({ enabled: false });
    }
  });
});
