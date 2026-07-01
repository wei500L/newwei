import { RealtimeSocketErrorCode } from "@modular/utils";

import {
  buildRealtimeSocketErrorPayload,
  shouldRecordFailedSocketAuth,
} from "./socket-error-payloads";

describe("socket-error-payloads", () => {
  it("maps retry-aware realtime socket errors to stable codes", () => {
    expect(buildRealtimeSocketErrorPayload("Rate limit exceeded", 60000)).toEqual(
      {
        code: RealtimeSocketErrorCode.RateLimitExceeded,
        message: "Rate limit exceeded",
        retryAfterMs: 60000,
      },
    );
    expect(
      buildRealtimeSocketErrorPayload("Too many failed attempts", 8000),
    ).toEqual({
      code: RealtimeSocketErrorCode.TooManyFailedAttempts,
      message: "Too many failed attempts",
      retryAfterMs: 8000,
    });
    expect(
      buildRealtimeSocketErrorPayload("Too many connection attempts", 45000),
    ).toEqual({
      code: RealtimeSocketErrorCode.TooManyConnectionAttempts,
      message: "Too many connection attempts",
      retryAfterMs: 45000,
    });
  });

  it("maps capacity and auth failures to stable realtime socket codes", () => {
    expect(buildRealtimeSocketErrorPayload("Too many connections")).toEqual({
      code: RealtimeSocketErrorCode.TooManyConnections,
      message: "Too many connections",
    });
    expect(buildRealtimeSocketErrorPayload("Insufficient permissions")).toEqual({
      code: RealtimeSocketErrorCode.Unauthorized,
      message: "Unauthorized",
    });
  });

  it("records backoff only for actual auth failures", () => {
    expect(shouldRecordFailedSocketAuth("Invalid token")).toBe(true);
    expect(shouldRecordFailedSocketAuth("jwt malformed")).toBe(true);
    expect(shouldRecordFailedSocketAuth("Origin not allowed")).toBe(true);
    expect(shouldRecordFailedSocketAuth("Insufficient permissions")).toBe(true);
    expect(shouldRecordFailedSocketAuth("User not found")).toBe(true);
    expect(shouldRecordFailedSocketAuth("Too many connections")).toBe(false);
    expect(shouldRecordFailedSocketAuth("Rate limit exceeded")).toBe(false);
    expect(shouldRecordFailedSocketAuth("Too many failed attempts")).toBe(
      false,
    );
  });
});
