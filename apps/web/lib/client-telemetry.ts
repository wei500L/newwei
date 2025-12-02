"use client";

type ClientTelemetryContext = {
  traceId?: string;
  tags?: Record<string, string>;
  extras?: Record<string, unknown>;
};

export const captureClientError = (
  message: string,
  error?: unknown,
  context: ClientTelemetryContext = {},
) => {
  const sentry =
    typeof window !== "undefined" ? (window as { Sentry?: any }).Sentry : undefined;
  const normalizedError =
    error instanceof Error ? error : new Error(error ? String(error) : message);

  if (sentry?.captureException) {
    sentry.captureException(normalizedError, {
      tags: { ...context.tags, traceId: context.traceId },
      extra: { ...context.extras, message },
    });
  }

  const prefix = context.traceId ? `[trace:${context.traceId}] ` : "";
  console.error(`${prefix}${message}`, normalizedError, context.extras);
};
