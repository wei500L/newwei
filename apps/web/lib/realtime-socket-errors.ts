export interface RealtimeSocketErrorPayload {
  code?: string;
  message?: string;
  retryAfterMs?: number;
}

export interface RealtimeSocketErrorDefaults {
  unauthorized: string;
  tooManyConnections: string;
  tooManyConnectionAttempts: string;
  rateLimitExceeded: string;
  tooManyFailedAttempts: string;
  timeout: string;
  network: string;
  connect: string;
  socket: string;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

const RealtimeSocketErrorCode = {
  Unauthorized: "UNAUTHORIZED",
  TooManyConnections: "TOO_MANY_CONNECTIONS",
  TooManyConnectionAttempts: "TOO_MANY_CONNECTION_ATTEMPTS",
  RateLimitExceeded: "RATE_LIMIT_EXCEEDED",
  TooManyFailedAttempts: "TOO_MANY_FAILED_ATTEMPTS",
} as const;

const toStringValue = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const looksLikeCjk = (value: string | undefined): boolean =>
  typeof value === "string" && /[\u3400-\u9fff]/u.test(value);

const toRetryAfterSeconds = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.max(1, Math.ceil(value / 1000));
};

export const formatRealtimeSocketError = (
  error: RealtimeSocketErrorPayload | undefined,
  t: Translate,
  options: {
    keyPrefix: string;
    fallbackKind?: "socket" | "connect";
    defaults: RealtimeSocketErrorDefaults;
  },
): string => {
  const code = toStringValue(error?.code);
  const message = toStringValue(error?.message);
  const lowered = message?.toLowerCase() ?? "";
  const retryAfterSeconds = toRetryAfterSeconds(error?.retryAfterMs);
  const fallbackKind = options.fallbackKind ?? "socket";

  switch (code) {
    case RealtimeSocketErrorCode.Unauthorized:
      return t(`${options.keyPrefix}.unauthorized`, {
        defaultValue: options.defaults.unauthorized,
      });
    case RealtimeSocketErrorCode.TooManyConnections:
      return t(`${options.keyPrefix}.tooManyConnections`, {
        defaultValue: options.defaults.tooManyConnections,
      });
    case RealtimeSocketErrorCode.TooManyConnectionAttempts:
      return t(`${options.keyPrefix}.tooManyConnectionAttempts`, {
        defaultValue: options.defaults.tooManyConnectionAttempts,
      });
    case RealtimeSocketErrorCode.RateLimitExceeded:
      return t(`${options.keyPrefix}.rateLimitExceeded`, {
        defaultValue: options.defaults.rateLimitExceeded,
        seconds: retryAfterSeconds,
      });
    case RealtimeSocketErrorCode.TooManyFailedAttempts:
      return t(`${options.keyPrefix}.tooManyFailedAttempts`, {
        defaultValue: options.defaults.tooManyFailedAttempts,
        seconds: retryAfterSeconds,
      });
    default:
      break;
  }

  if (message === "Unauthorized") {
    return t(`${options.keyPrefix}.unauthorized`, {
      defaultValue: options.defaults.unauthorized,
    });
  }
  if (message === "Too many connections") {
    return t(`${options.keyPrefix}.tooManyConnections`, {
      defaultValue: options.defaults.tooManyConnections,
    });
  }
  if (message === "Too many connection attempts") {
    return t(`${options.keyPrefix}.tooManyConnectionAttempts`, {
      defaultValue: options.defaults.tooManyConnectionAttempts,
    });
  }
  if (message === "Rate limit exceeded") {
    return t(`${options.keyPrefix}.rateLimitExceeded`, {
      defaultValue: options.defaults.rateLimitExceeded,
      seconds: retryAfterSeconds,
    });
  }
  if (message === "Too many failed attempts") {
    return t(`${options.keyPrefix}.tooManyFailedAttempts`, {
      defaultValue: options.defaults.tooManyFailedAttempts,
      seconds: retryAfterSeconds,
    });
  }
  if (lowered.includes("timeout") || lowered.includes("timed out")) {
    return t(`${options.keyPrefix}.timeout`, {
      defaultValue: options.defaults.timeout,
    });
  }
  if (
    lowered.includes("network") ||
    lowered.includes("failed to fetch") ||
    lowered.includes("offline") ||
    lowered.includes("xhr poll error")
  ) {
    return t(`${options.keyPrefix}.network`, {
      defaultValue: options.defaults.network,
    });
  }
  if (looksLikeCjk(message)) {
    return message as string;
  }

  return fallbackKind === "connect"
    ? t(`${options.keyPrefix}.connect`, {
        defaultValue: options.defaults.connect,
      })
    : t(`${options.keyPrefix}.socket`, {
        defaultValue: options.defaults.socket,
      });
};
