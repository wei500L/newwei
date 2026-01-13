type HeadersRecord = Record<string, string>;

let cachedTraceId: string | undefined;

const randomHex = (bytes: number): string => {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    const array = new Uint8Array(bytes);
    globalThis.crypto.getRandomValues(array);
    return Array.from(array, (value) => value.toString(16).padStart(2, '0')).join('');
  }

  return Array.from({ length: bytes }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0'),
  ).join('');
};

const ensureTraceId = (incoming?: string | null): string => {
  const normalized = incoming?.trim().replace(/[^a-fA-F0-9]/g, '');
  if (normalized && normalized.length >= 16) {
    return normalized.slice(0, 32);
  }
  return randomHex(16);
};

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
  if (typeof window === 'undefined') {
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
  const traceId = ensureTraceId(normalized['x-trace-id'] ?? getClientTraceId());

  return {
    ...normalized,
    'x-trace-id': traceId,
    traceparent: normalized.traceparent ?? `00-${traceId}-0000000000000000-01`,
  };
};
