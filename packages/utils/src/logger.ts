import pino from "pino";

import { getCurrentTraceId } from "./tracing";

export interface CreateLoggerOptions {
  name?: string;
  level?: pino.LevelWithSilent;
  enabled?: boolean;
}

export const createLogger = ({
  name = "app",
  level,
  enabled = true
}: CreateLoggerOptions = {}) => {
  const isNodeRuntime =
    typeof process !== "undefined" &&
    typeof process.stdout !== "undefined" &&
    typeof process.versions?.node !== "undefined";

  if (!isNodeRuntime) {
    const prefix = `[${name}]`;
    const log =
      (method: "error" | "warn" | "info" | "debug") =>
      (...args: unknown[]) => {
        if (!enabled) return;
        // eslint-disable-next-line no-console
        console[method](prefix, ...args);
      };
    const consoleLogger = {
      fatal: log("error"),
      error: log("error"),
      warn: log("warn"),
      info: log("info"),
      debug: log("debug"),
      trace: log("debug"),
      child: () => consoleLogger
    } as unknown as pino.Logger;

    return consoleLogger;
  }

  const nodeEnv = typeof process !== "undefined" ? process.env?.NODE_ENV : undefined;
  const envLogLevel = typeof process !== "undefined" ? (process.env?.LOG_LEVEL as pino.LevelWithSilent | undefined) : undefined;
  const resolvedLevel = level ?? envLogLevel ?? (nodeEnv === "production" ? "info" : "debug");
  const stdoutIsTTY =
    typeof process !== "undefined" && typeof process.stdout !== "undefined" && typeof process.stdout.isTTY !== "undefined"
      ? Boolean(process.stdout.isTTY)
      : false;
  const usePrettyTransport = nodeEnv !== "production" && stdoutIsTTY;
  return pino({
    name,
    enabled,
    level: resolvedLevel,
    mixin: () => {
      const traceId = getCurrentTraceId();
      return traceId ? { traceId } : {};
    },
    transport: usePrettyTransport
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard"
          }
        }
      : undefined
  });
};

export type Logger = ReturnType<typeof createLogger>;
