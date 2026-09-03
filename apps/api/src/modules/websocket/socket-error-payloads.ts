import {
  type NotificationSocketErrorPayload,
  RealtimeSocketErrorCode,
  type RealtimeSocketErrorPayload,
} from "@modular/utils";

const NON_AUTH_BACKOFF_ERROR_MESSAGES = new Set([
  "Rate limit exceeded",
  "Too many failed attempts",
  "Too many connections",
  "Too many connection attempts",
]);

export const buildRealtimeSocketErrorPayload = (
  errorMessage: string,
  retryAfterMs?: number,
): RealtimeSocketErrorPayload => {
  switch (errorMessage) {
    case "Rate limit exceeded":
      return {
        code: RealtimeSocketErrorCode.RateLimitExceeded,
        message: "Rate limit exceeded",
        retryAfterMs,
      };
    case "Too many failed attempts":
      return {
        code: RealtimeSocketErrorCode.TooManyFailedAttempts,
        message: "Too many failed attempts",
        retryAfterMs,
      };
    case "Too many connections":
      return {
        code: RealtimeSocketErrorCode.TooManyConnections,
        message: "Too many connections",
      };
    case "Too many connection attempts":
      return {
        code: RealtimeSocketErrorCode.TooManyConnectionAttempts,
        message: "Too many connection attempts",
        retryAfterMs,
      };
    default:
      return {
        code: RealtimeSocketErrorCode.Unauthorized,
        message: "Unauthorized",
      };
  }
};

export const buildNotificationSocketErrorPayload = (
  errorMessage: string,
  retryAfterMs?: number,
): NotificationSocketErrorPayload =>
  buildRealtimeSocketErrorPayload(
    errorMessage,
    retryAfterMs,
  ) as NotificationSocketErrorPayload;

export const shouldRecordFailedSocketAuth = (errorMessage: string): boolean =>
  !NON_AUTH_BACKOFF_ERROR_MESSAGES.has(errorMessage);
