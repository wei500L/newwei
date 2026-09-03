interface TraceContext {
  traceId: string;
}

// Minimal structural stand-in for node:async_hooks.AsyncLocalStorage: the
// real module must stay a dynamic builtin load (see createAsyncLocalStorage),
// so we cannot reference its types via a static import either.
interface TraceStorage {
  getStore(): TraceContext | undefined;
  run<T>(store: TraceContext, callback: () => T): T;
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
  if (typeof window !== "undefined") {
    return undefined;
  }
  if (typeof process === "undefined" || !process.versions?.node) {
    return undefined;
  }

  try {
    // process.getBuiltinModule (Node >= 20.16) loads builtins without letting
    // bundlers statically resolve them. The previous eval("require") trick
    // broke the web build: webpack refuses any dynamic code evaluation in the
    // Edge runtime bundle (middleware.ts pulls this module in via lib/auth.ts).
    const getBuiltinModule = (process as { getBuiltinModule?: (id: string) => unknown })
      .getBuiltinModule;
    const asyncHooks = getBuiltinModule?.call(process, "node:async_hooks") as
      | { AsyncLocalStorage: new () => TraceStorage }
      | undefined;
    if (asyncHooks?.AsyncLocalStorage) {
      return new asyncHooks.AsyncLocalStorage();
    }
    return undefined;
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
