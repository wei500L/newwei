import { createLogger } from "@modular/utils";

export type ServerLogContext = {
  traceId?: string;
  meta?: Record<string, unknown>;
};

const logger = createLogger({ name: "web" });

export const logServerError = (
  message: string,
  error: unknown,
  context: ServerLogContext = {},
) => {
  logger.error(
    {
      err: error,
      traceId: context.traceId,
      meta: context.meta,
    },
    message,
  );
};
