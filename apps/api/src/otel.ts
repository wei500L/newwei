import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";

const otelEnabled = process.env.OTEL_ENABLED === "true" || process.env.OTEL_ENABLED === "1";

if (otelEnabled) {
  const traceExporter = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? new OTLPTraceExporter({
        url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/+$/, "") + "/v1/traces",
      })
    : undefined;

  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "modular-api",
    traceExporter,
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();

  process.once("beforeExit", () => {
    void sdk.shutdown().catch(() => undefined);
  });
}
