interface TraceContext {
  traceId: string;
}

const randomHex = (bytes: number): string => {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.getRandomValues) {
    const array = new Uint8Array(bytes);
    globalThis.crypto.getRandomValues(array);
    return Array.from(array, (value) => value.toString(16).padStart(2, "0")).join("");
  }

  return Array.from({ length: bytes }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0"),
  ).join("");
};

const createAsyncLocalStorage = () => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires,@typescript-eslint/no-require-imports,@typescript-eslint/consistent-type-imports
    const { AsyncLocalStorage } = require("node:async_hooks") as typeof import("node:async_hooks");
    return new AsyncLocalStorage<TraceContext>();
  } catch {
    return undefined;
  }
};

const traceStorage = createAsyncLocalStorage();

export const getCurrentTraceId = (): string | undefined => {
  return traceStorage?.getStore()?.traceId;
};

export const ensureTraceId = (incoming?: string | null): string => {
  const normalized = incoming?.trim().replace(/[^a-fA-F0-9]/g, "");
  if (normalized && normalized.length >= 16) {
    return normalized.slice(0, 32);
  }
  return randomHex(16);
};

export const runWithTraceId = <T>(traceId: string, callback: () => T): T => {
  if (!traceStorage) {
    return callback();
  }
  return traceStorage.run({ traceId }, callback);
};

export const bindTraceId = <TArgs extends unknown[], TResult>(
  traceId: string,
  fn: (...args: TArgs) => TResult,
): ((...args: TArgs) => TResult) => {
  if (!traceStorage) {
    return (...args: TArgs): TResult => fn(...args);
  }
  return (...args: TArgs): TResult =>
    traceStorage.run({ traceId }, () => fn(...args));
};
