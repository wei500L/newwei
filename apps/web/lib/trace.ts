import { ensureTraceId } from "@modular/utils";

type HeadersRecord = Record<string, string>;

let cachedTraceId: string | undefined;

const normalizeHeaders = (headers?: HeadersInit): HeadersRecord => {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    const normalized: HeadersRecord = {};
    headers.forEach((value, key) => {
      normalized[key.toLowerCase()] = value;
    });
    return normalized;
  }

  if (Array.isArray(headers)) {
    return headers.reduce<HeadersRecord>((acc, [key, value]) => {
      acc[String(key).toLowerCase()] = String(value);
      return acc;
    }, {});
  }

  return Object.entries(headers).reduce<HeadersRecord>((acc, [key, value]) => {
    acc[key.toLowerCase()] = String(value);
    return acc;
  }, {});
};

export const getClientTraceId = (): string => {
  if (typeof window === "undefined") {
    return ensureTraceId();
  }
  if (!cachedTraceId) {
    cachedTraceId = ensureTraceId((window as { __traceId?: string }).__traceId);
    (window as { __traceId?: string }).__traceId = cachedTraceId;
  }
  return cachedTraceId;
};

export const createTraceHeaders = (headers?: HeadersInit): HeadersRecord => {
  const normalized = normalizeHeaders(headers);
  const traceId = ensureTraceId(normalized["x-trace-id"] ?? getClientTraceId());

  return {
    ...normalized,
    "x-trace-id": traceId,
    traceparent: normalized.traceparent ?? `00-${traceId}-0000000000000000-01`,
  };
};
