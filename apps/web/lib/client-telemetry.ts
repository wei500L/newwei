"use client";

type ClientTelemetryContext = {
  traceId?: string;
  tags?: Record<string, string>;
  extras?: Record<string, unknown>;
};

function normalizeError(message: string, error?: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  const errorMessage =
    typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
      ? error.message
      : error
        ? String(error)
        : message;

  const normalized = new Error(errorMessage);
  if (typeof error === "object" && error !== null) {
    try {
      (normalized as unknown as { cause?: unknown }).cause = error;
    } catch {
      // ignore
    }
  }
  return normalized;
}

export const captureClientError = (
  message: string,
  error?: unknown,
  context: ClientTelemetryContext = {},
) => {
  const sentry =
    typeof window !== "undefined" ? (window as { Sentry?: any }).Sentry : undefined;
  const normalizedError = normalizeError(message, error);

  if (sentry?.captureException) {
    sentry.captureException(normalizedError, {
      tags: { ...context.tags, traceId: context.traceId },
      extra: { ...context.extras, message },
    });
  }

  const prefix = context.traceId ? `[trace:${context.traceId}] ` : "";
  console.error(`${prefix}${message}`, normalizedError, context.extras);
};
