export enum QueueErrorKind {
  Transient = "transient",
  Permanent = "permanent",
}

export interface SerializedQueueError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  status?: number;
  cause?: SerializedQueueError;
}

export interface ClassifiedQueueError {
  kind: QueueErrorKind;
  reason: string;
  error: SerializedQueueError;
}

export class QueuePermanentError extends Error {
  override name = "QueuePermanentError";
}

export class QueueTransientError extends Error {
  override name = "QueueTransientError";
}

const DEFAULT_ERROR_MESSAGE = "Unknown error";

const SYSTEM_TRANSIENT_ERROR_CODES = new Set<string>([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EADDRINUSE",
]);

const AXIOS_TRANSIENT_HTTP_STATUSES = new Set<number>([
  408, 409, 423, 425, 429, 500, 502, 503, 504,
]);

const PRISMA_TRANSIENT_CODES = new Set<string>([
  "P1000",
  "P1001",
  "P1002",
  "P1003",
  "P1008",
  "P1009",
  "P1010",
  "P1011",
  "P1012",
  "P1013",
]);

const PRISMA_PERMANENT_CODES = new Set<string>([
  "P2000",
  "P2001",
  "P2002",
  "P2003",
  "P2004",
  "P2005",
  "P2006",
  "P2007",
  "P2008",
  "P2009",
  "P2010",
  "P2011",
  "P2012",
  "P2013",
  "P2014",
  "P2015",
  "P2016",
  "P2017",
  "P2018",
  "P2019",
  "P2020",
  "P2021",
  "P2022",
  "P2023",
  "P2024",
  "P2025",
  "P2026",
  "P2027",
  "P2028",
  "P2029",
  "P2030",
]);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const getString = (value: unknown): string | undefined => {
  return typeof value === "string" ? value : undefined;
};

const getNumber = (value: unknown): number | undefined => {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const getErrorName = (error: unknown): string => {
  if (error instanceof Error) {
    return error.name || "Error";
  }
  if (isRecord(error)) {
    return getString(error.name) ?? "Error";
  }
  return "Error";
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message || DEFAULT_ERROR_MESSAGE;
  }
  if (isRecord(error)) {
    const message = getString(error.message);
    if (message && message.length > 0) {
      return message;
    }
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return DEFAULT_ERROR_MESSAGE;
};

const getErrorStack = (error: unknown): string | undefined => {
  if (error instanceof Error) {
    return error.stack;
  }
  if (isRecord(error)) {
    return getString(error.stack);
  }
  return undefined;
};

const getErrorCode = (error: unknown): string | undefined => {
  if (!isRecord(error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
};

const getAxiosStatus = (error: unknown): number | undefined => {
  if (!isRecord(error)) {
    return undefined;
  }
  if (error.isAxiosError !== true) {
    return undefined;
  }
  const response = error.response;
  if (!isRecord(response)) {
    return undefined;
  }
  return getNumber(response.status);
};

const getCrawl4aiStatus = (error: unknown): number | undefined => {
  if (!isRecord(error)) {
    return undefined;
  }
  if (getString(error.name) !== "Crawl4aiRequestException") {
    return undefined;
  }
  return getNumber(error.status);
};

const getPrismaCode = (error: unknown): string | undefined => {
  if (!isRecord(error)) {
    return undefined;
  }
  const code = getString(error.code);
  if (code) {
    return code;
  }
  return undefined;
};

const getCause = (error: unknown): unknown => {
  if (error instanceof Error) {
    return (error as Error & { cause?: unknown }).cause;
  }
  if (isRecord(error)) {
    return error.cause;
  }
  return undefined;
};

export const serializeQueueError = (
  error: unknown,
  depth = 0,
): SerializedQueueError => {
  const name = getErrorName(error);
  const message = getErrorMessage(error);
  const stack = getErrorStack(error);
  const code = getErrorCode(error);
  const status = getAxiosStatus(error) ?? getCrawl4aiStatus(error);

  if (depth >= 3) {
    return { name, message, stack, code, status };
  }

  const cause = getCause(error);
  return {
    name,
    message,
    stack,
    code,
    status,
    cause: cause ? serializeQueueError(cause, depth + 1) : undefined,
  };
};

export const classifyQueueError = (error: unknown): ClassifiedQueueError => {
  if (error instanceof QueuePermanentError) {
    return {
      kind: QueueErrorKind.Permanent,
      reason: "explicit-permanent",
      error: serializeQueueError(error),
    };
  }

  if (error instanceof QueueTransientError) {
    return {
      kind: QueueErrorKind.Transient,
      reason: "explicit-transient",
      error: serializeQueueError(error),
    };
  }

  const name = getErrorName(error);

  if (name === "UnrecoverableError") {
    const cause = getCause(error);
    const causeReason = cause ? classifyQueueError(cause).reason : undefined;
    return {
      kind: QueueErrorKind.Permanent,
      reason: causeReason ? `unrecoverable:${causeReason}` : "unrecoverable",
      error: serializeQueueError(error),
    };
  }

  if (name === "ZodError") {
    return {
      kind: QueueErrorKind.Permanent,
      reason: "validation",
      error: serializeQueueError(error),
    };
  }

  const crawl4aiStatus = getCrawl4aiStatus(error);
  if (typeof crawl4aiStatus === "number") {
    return {
      kind: crawl4aiStatus >= 500 ? QueueErrorKind.Transient : QueueErrorKind.Permanent,
      reason: "crawl4ai",
      error: serializeQueueError(error),
    };
  }

  const axiosStatus = getAxiosStatus(error);
  if (typeof axiosStatus === "number") {
    const kind =
      axiosStatus >= 500 || AXIOS_TRANSIENT_HTTP_STATUSES.has(axiosStatus)
        ? QueueErrorKind.Transient
        : QueueErrorKind.Permanent;
    return {
      kind,
      reason: "http",
      error: serializeQueueError(error),
    };
  }

  const prismaCode = getPrismaCode(error);
  if (prismaCode) {
    const kind = PRISMA_TRANSIENT_CODES.has(prismaCode)
      ? QueueErrorKind.Transient
      : PRISMA_PERMANENT_CODES.has(prismaCode)
        ? QueueErrorKind.Permanent
        : QueueErrorKind.Transient;
    return {
      kind,
      reason: "prisma",
      error: serializeQueueError(error),
    };
  }

  const code = getErrorCode(error);
  if (code && SYSTEM_TRANSIENT_ERROR_CODES.has(code)) {
    return {
      kind: QueueErrorKind.Transient,
      reason: "system",
      error: serializeQueueError(error),
    };
  }

  const message = getErrorMessage(error).toLowerCase();
  if (message.includes("throttled") || message.includes("rate limit")) {
    return {
      kind: QueueErrorKind.Transient,
      reason: "rate-limit",
      error: serializeQueueError(error),
    };
  }

  return {
    kind: QueueErrorKind.Transient,
    reason: "unknown",
    error: serializeQueueError(error),
  };
};
