import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";

import {
  createOtelInstrumentationConfig,
  createOtelSampler,
} from "./otel-config";

const otelEnabled = process.env.OTEL_ENABLED === "true" || process.env.OTEL_ENABLED === "1";

if (otelEnabled) {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  // Without an endpoint the SDK falls back to localhost:4318 and silently
  // ships traces nowhere (or fails). Only start exporting when configured.
  const traceExporter = endpoint
    ? new OTLPTraceExporter({
        url: endpoint.replace(/\/+$/, "") + "/v1/traces",
      })
    : undefined;

  if (!traceExporter) {
    console.warn(
      "[otel] OTEL_ENABLED=true but OTEL_EXPORTER_OTLP_ENDPOINT is not set; disabling the trace exporter",
    );
  }

  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "modular-api",
    traceExporter,
    sampler: createOtelSampler(),
    instrumentations: [
      getNodeAutoInstrumentations(createOtelInstrumentationConfig()),
    ],
  });

  sdk.start();

  process.once("beforeExit", () => {
    void sdk.shutdown().catch(() => undefined);
  });
}
