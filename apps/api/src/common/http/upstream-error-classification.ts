export type UpstreamRequestErrorCode =
  | "dns_resolution_failed"
  | "request_timeout"
  | "network_error"
  | "upstream_auth_failed"
  | "upstream_rate_limited"
  | "upstream_server_error"
  | "fetch_error";

export function readHttpStatus(error: unknown) {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const status = Number((error as { status?: unknown }).status);
  return Number.isFinite(status) ? status : undefined;
}

export function readNestedErrorCode(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== "object" || depth > 4) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code.trim().length > 0) {
    return code.trim();
  }
  return readNestedErrorCode((error as { cause?: unknown }).cause, depth + 1);
}

export function classifyUpstreamRequestError(
  error: unknown,
): UpstreamRequestErrorCode {
  const status = readHttpStatus(error);
  if (status === 401 || status === 403) {
    return "upstream_auth_failed";
  }
  if (status === 429) {
    return "upstream_rate_limited";
  }
  if (typeof status === "number" && status >= 500) {
    return "upstream_server_error";
  }

  const code = readNestedErrorCode(error)?.toUpperCase();
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "dns_resolution_failed";
  }
  if (
    code === "ETIMEDOUT" ||
    code === "ECONNABORTED" ||
    code === "ABORT_ERR" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  ) {
    return "request_timeout";
  }
  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE" ||
    code === "ENETUNREACH" ||
    code === "EHOSTUNREACH" ||
    code === "ERR_NETWORK"
  ) {
    return "network_error";
  }

  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return "request_timeout";
    }
    const message = error.message.toLowerCase();
    if (
      message.includes("enotfound") ||
      message.includes("eai_again") ||
      message.includes("getaddrinfo") ||
      message.includes("name or service not known")
    ) {
      return "dns_resolution_failed";
    }
    if (
      message.includes("timeout") ||
      message.includes("timed out") ||
      message.includes("aborterror") ||
      message.includes("aborted")
    ) {
      return "request_timeout";
    }
    if (
      message.includes("fetch failed") ||
      message.includes("network") ||
      message.includes("socket hang up") ||
      message.includes("econnreset") ||
      message.includes("econnrefused")
    ) {
      return "network_error";
    }
  }

  return "fetch_error";
}
