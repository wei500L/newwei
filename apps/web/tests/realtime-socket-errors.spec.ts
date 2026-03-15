import fs from "node:fs";
import path from "node:path";

import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import { formatRealtimeSocketError } from "../lib/realtime-socket-errors";

const webRoot = path.resolve(__dirname, "..");

const readLocale = (name: "en" | "zh") =>
  JSON.parse(
    fs.readFileSync(path.resolve(webRoot, `lib/locales/${name}.json`), "utf8"),
  ) as Record<string, unknown>;

const getDeepValue = (
  value: Record<string, unknown>,
  pathKey: string,
): unknown =>
  pathKey.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    return (current as Record<string, unknown>)[segment];
  }, value);

const interpolate = (template: string, options?: Record<string, unknown>) =>
  template.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_match, key) => {
    const value = options?.[key];
    return value === undefined || value === null ? "" : String(value);
  });

const createTranslator = (translations: Record<string, unknown>) =>
  ((key: string, options?: Record<string, unknown>) => {
    const raw = getDeepValue(translations, key);
    if (typeof raw === "string") {
      return interpolate(raw, options);
    }
    if (typeof options?.defaultValue === "string") {
      return interpolate(options.defaultValue, options);
    }
    return key;
  }) as TFunction;

const queueDefaults = {
  unauthorized: "Queue connection expired. Please sign in again.",
  tooManyConnections:
    "Queue connections are at capacity. Please try again later.",
  tooManyConnectionAttempts:
    "Too many queue connection attempts. Please try again later.",
  rateLimitExceeded:
    "Queue connection attempts are too frequent. Please try again later.",
  tooManyFailedAttempts:
    "Too many failed queue sign-in attempts. Please try again later.",
  timeout: "Connecting to the queue timed out. Please try again.",
  network:
    "Unable to connect to the queue. Please check the network and try again.",
  connect: "Unable to connect to the queue right now. Please try again later.",
  socket: "Queue connection is unstable. Please try again later.",
} as const;

describe("realtime socket errors", () => {
  const enTranslator = createTranslator(readLocale("en"));
  const zhTranslator = createTranslator(readLocale("zh"));

  it("formats stable queue websocket codes into zh-CN copy", () => {
    expect(
      formatRealtimeSocketError(
        {
          code: "RATE_LIMIT_EXCEEDED",
          message: "Rate limit exceeded",
          retryAfterMs: 60000,
        },
        zhTranslator,
        {
          keyPrefix: "dashboard.queue.connectionError",
          fallbackKind: "socket",
          defaults: queueDefaults,
        },
      ),
    ).toBe("队列连接请求过于频繁，请稍后再试。");
  });

  it("formats NewsNow auth failures into en-US copy", () => {
    expect(
      formatRealtimeSocketError(
        { code: "UNAUTHORIZED", message: "Unauthorized" },
        enTranslator,
        {
          keyPrefix: "newsnow.connectionError",
          fallbackKind: "socket",
          defaults: {
            unauthorized:
              "NewsNow realtime access expired. Please sign in again.",
            tooManyConnections:
              "NewsNow realtime connections are at capacity. Please try again later.",
            tooManyConnectionAttempts:
              "Too many NewsNow realtime connection attempts. Please try again later.",
            rateLimitExceeded:
              "NewsNow realtime connection attempts are too frequent. Please try again later.",
            tooManyFailedAttempts:
              "Too many failed NewsNow realtime sign-in attempts. Please try again later.",
            timeout:
              "Connecting to NewsNow realtime timed out. Please try again.",
            network:
              "Unable to connect to NewsNow realtime. Please check the network and try again.",
            connect:
              "Unable to connect to NewsNow realtime right now. Please try again later.",
            socket:
              "NewsNow realtime connection is unstable. Please try again later.",
          },
        },
      ),
    ).toBe("NewsNow realtime access expired. Please sign in again.");
  });

  it("maps network failures for situation monitor to localized copy", () => {
    expect(
      formatRealtimeSocketError({ message: "xhr poll error" }, zhTranslator, {
        keyPrefix: "situationMonitor.realtime.connectionError",
        fallbackKind: "connect",
        defaults: {
          unauthorized:
            "Situation monitor realtime access expired. Please sign in again.",
          tooManyConnections:
            "Situation monitor realtime connections are at capacity. Please try again later.",
          tooManyConnectionAttempts:
            "Too many situation monitor realtime connection attempts. Please try again later.",
          rateLimitExceeded:
            "Situation monitor realtime connection attempts are too frequent. Please try again later.",
          tooManyFailedAttempts:
            "Too many failed situation monitor realtime sign-in attempts. Please try again later.",
          timeout:
            "Connecting to situation monitor realtime timed out. Please try again.",
          network:
            "Unable to connect to situation monitor realtime. Please check the network and try again.",
          connect:
            "Unable to connect to situation monitor realtime right now. Please try again later.",
          socket:
            "Situation monitor realtime connection is unstable. Please try again later.",
        },
      }),
    ).toBe("当前无法连接态势监控实时服务，请检查网络后重试。");
  });
});
