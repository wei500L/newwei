import pino from "pino";

export interface CreateLoggerOptions {
  name?: string;
  level?: pino.LevelWithSilent;
  enabled?: boolean;
}

export const createLogger = ({
  name = "app",
  level = process.env.LOG_LEVEL as pino.LevelWithSilent | undefined,
  enabled = true
}: CreateLoggerOptions = {}) => {
  return pino({
    name,
    enabled,
    level: level ?? (process.env.NODE_ENV === "production" ? "info" : "debug"),
    transport:
      process.env.NODE_ENV !== "production"
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
