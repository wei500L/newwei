import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";

export interface FetchWithIpv4FallbackOptions {
  timeoutMs?: number;
  ipv4FallbackHosts?: readonly string[];
}

const DEFAULT_IPV4_FALLBACK_HOSTS = ["api.gdeltproject.org"] as const;

export async function fetchWithIpv4Fallback(
  url: string,
  init: RequestInit = {},
  options: FetchWithIpv4FallbackOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 12_000;
  const primarySignal = createTimedSignal(init.signal, timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: primarySignal.signal,
    });
  } catch (error) {
    const normalizedError = normalizeFetchTimeoutError(
      error,
      primarySignal.didTimeout(),
      timeoutMs,
    );
    if (
      !shouldRetryWithIpv4(
        url,
        normalizedError,
        init.signal,
        options.ipv4FallbackHosts,
      )
    ) {
      throw normalizedError;
    }
  } finally {
    primarySignal.cleanup();
  }

  return await performIpv4Request(url, init, timeoutMs);
}

function shouldRetryWithIpv4(
  url: string,
  error: unknown,
  callerSignal?: AbortSignal | null,
  hosts: readonly string[] = DEFAULT_IPV4_FALLBACK_HOSTS,
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const target = new URL(url);
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return false;
  }

  const matchesConfiguredHost = hosts.some(
    (host) => target.hostname === host || target.hostname.endsWith(`.${host}`),
  );
  if (!matchesConfiguredHost) {
    return false;
  }

  if (error.name === "AbortError") {
    return callerSignal?.aborted !== true;
  }

  const directCode = (error as Error & { code?: string }).code;
  if (directCode === "ETIMEDOUT") {
    return true;
  }

  if (error.message.includes("fetch failed")) {
    return true;
  }

  const cause = error as Error & {
    cause?: { code?: string; message?: string } | undefined;
  };
  const code = cause.cause?.code;
  return code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT";
}

async function performIpv4Request(
  url: string,
  init: RequestInit,
  timeoutMs = 12_000,
): Promise<Response> {
  const target = new URL(url);
  const requestImpl = target.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = new Headers(init.headers ?? {});
  const headerEntries: Record<string, string> = {};
  headers.forEach((value, key) => {
    headerEntries[key] = value;
  });
  const body = normalizeBody(init.body);
  const timedSignal = createTimedSignal(init.signal, timeoutMs);

  return await new Promise<Response>((resolve, reject) => {
    if (timedSignal.signal.aborted) {
      timedSignal.cleanup();
      reject(
        getAbortSignalError(
          timedSignal.signal,
          timeoutMs,
          timedSignal.didTimeout(),
        ),
      );
      return;
    }

    const request = requestImpl(
      target,
      {
        family: 4,
        headers: headerEntries,
        method: init.method ?? "GET",
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              headers: flattenHeaders(response.headers),
              status: response.statusCode ?? 500,
              statusText: response.statusMessage ?? "",
            }),
          );
        });
      },
    );

    const handleAbort = () =>
      request.destroy(
        getAbortSignalError(
          timedSignal.signal,
          timeoutMs,
          timedSignal.didTimeout(),
        ),
      );
    timedSignal.signal.addEventListener("abort", handleAbort, { once: true });

    request.on("error", reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(createTimeoutError(timeoutMs));
    });

    if (body !== undefined) {
      request.write(body);
    }

    request.end();

    request.on("close", () => {
      timedSignal.signal.removeEventListener("abort", handleAbort);
      timedSignal.cleanup();
    });
  });
}

function createTimedSignal(signal: AbortSignal | null | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(createTimeoutError(timeoutMs));
  }, timeoutMs);
  const handleAbort = () =>
    controller.abort(normalizeAbortReason(signal?.reason));
  signal?.addEventListener("abort", handleAbort, { once: true });

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", handleAbort);
    },
  };
}

function getAbortSignalError(
  signal: AbortSignal,
  timeoutMs: number,
  didTimeout = false,
): Error {
  if (didTimeout) {
    return createTimeoutError(timeoutMs);
  }
  return normalizeAbortReason(signal.reason);
}

function normalizeAbortReason(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }

  if (
    reason &&
    typeof reason === "object" &&
    "message" in reason &&
    typeof reason.message === "string" &&
    reason.message.trim()
  ) {
    const error = new Error(reason.message.trim());
    error.name =
      "name" in reason && typeof reason.name === "string"
        ? reason.name
        : "AbortError";
    if (
      "code" in reason &&
      typeof reason.code === "string" &&
      reason.code.trim()
    ) {
      Object.assign(error, { code: reason.code.trim() });
    }
    return error;
  }

  if (typeof reason === "string" && reason.trim()) {
    const error = new Error(reason.trim());
    error.name = "AbortError";
    return error;
  }

  return createAbortError();
}

function normalizeFetchTimeoutError(
  error: unknown,
  didTimeout: boolean,
  timeoutMs: number,
): Error {
  if (didTimeout) {
    return createTimeoutError(timeoutMs);
  }

  return error instanceof Error ? error : createAbortError();
}

function normalizeBody(
  value: BodyInit | null | undefined,
): string | Uint8Array | Buffer | undefined {
  if (value == null) {
    return undefined;
  }
  if (
    typeof value === "string" ||
    value instanceof Uint8Array ||
    Buffer.isBuffer(value)
  ) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof URLSearchParams) {
    return value.toString();
  }

  throw new TypeError("Unsupported request body for IPv4 fallback request");
}

function flattenHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const flattened: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      flattened[key] = value.join(", ");
      continue;
    }
    if (typeof value === "string") {
      flattened[key] = value;
    }
  }

  return flattened;
}

function createTimeoutError(timeoutMs: number): Error {
  const error = new Error(`Network request timed out after ${timeoutMs}ms`);
  Object.assign(error, { code: "ETIMEDOUT" });
  return error;
}

function createAbortError(): Error {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}
