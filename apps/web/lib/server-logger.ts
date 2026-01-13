export interface ServerLogContext {
  traceId?: string;
  meta?: Record<string, unknown>;
}

const serializeError = (error: unknown): unknown => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return error;
};

export const logServerError = (
  message: string,
  error: unknown,
  context: ServerLogContext = {},
) => {
  console.error(message, {
    err: serializeError(error),
    traceId: context.traceId,
    meta: context.meta,
  });
};
