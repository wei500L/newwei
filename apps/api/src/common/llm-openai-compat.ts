export const OPENAI_PATH_SUFFIXES = [
  "/v1/chat/completions",
  "/chat/completions",
  "/v1/embeddings",
  "/embeddings",
  "/v1/models",
  "/models",
  "/v1/responses",
  "/responses",
] as const;

export type LlmApiSurface =
  | "chat_completions"
  | "embeddings"
  | "models"
  | "responses";

export type LlmCompatibilityErrorCode =
  | "UNSUPPORTED_METADATA"
  | "UNSUPPORTED_RESPONSE_FORMAT"
  | "UNSUPPORTED_JSON_SCHEMA"
  | "INVALID_MESSAGE_CONTENT"
  | "RESPONSES_API_UNSUPPORTED";

export interface LlmCompatibilityIssue {
  code: LlmCompatibilityErrorCode;
  incompatibleField: string;
  hint: string;
  upstreamMessage: string;
  status?: number;
}

export class LlmCompatibilityError extends Error {
  public readonly code: LlmCompatibilityErrorCode;
  public readonly incompatibleField: string;
  public readonly hint: string;
  public readonly upstreamMessage: string;
  public readonly status?: number;

  constructor(issue: LlmCompatibilityIssue, options?: { cause?: Error }) {
    const message = `LLM compatibility error [${issue.code}] on ${issue.incompatibleField}: ${issue.hint}`;
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "LlmCompatibilityError";
    this.code = issue.code;
    this.incompatibleField = issue.incompatibleField;
    this.hint = issue.hint;
    this.upstreamMessage = issue.upstreamMessage;
    this.status = issue.status;
  }
}

export interface LlmCompatibilityErrorInfo {
  code: LlmCompatibilityErrorCode;
  incompatibleField: string;
  hint: string;
  upstreamMessage: string;
  status?: number;
}

const SENSITIVE_BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._-]+/gi;
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9]{10,}\b/g;

function containsAny(input: string, candidates: readonly string[]): boolean {
  return candidates.some((entry) => input.includes(entry));
}

export function redactSensitiveText(raw: string): string {
  const bearerRedacted = raw.replace(
    SENSITIVE_BEARER_PATTERN,
    "Bearer [REDACTED]",
  );
  return bearerRedacted.replace(OPENAI_KEY_PATTERN, "sk-[REDACTED]");
}

export function sanitizeUpstreamErrorText(
  raw: unknown,
  options?: { maxLength?: number },
): string {
  if (typeof raw !== "string") {
    return "";
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }

  const maxLength = Math.max(64, options?.maxLength ?? 500);
  const redacted = redactSensitiveText(trimmed);
  if (redacted.length <= maxLength) {
    return redacted;
  }
  return `${redacted.slice(0, maxLength)}…`;
}

export function toLlmCompatibilityErrorInfo(
  error: LlmCompatibilityError,
): LlmCompatibilityErrorInfo {
  return {
    code: error.code,
    incompatibleField: error.incompatibleField,
    hint: error.hint,
    upstreamMessage: error.upstreamMessage,
    ...(typeof error.status === "number" ? { status: error.status } : {}),
  };
}

export function normalizeOpenAiApiBase(raw: string) {
  let base = raw.trim();
  if (base.length === 0) {
    return base;
  }

  base = base.replace(/\/+$/, "");

  const lower = base.toLowerCase();
  const matchedSuffix = OPENAI_PATH_SUFFIXES.find((suffix) =>
    lower.endsWith(suffix),
  );

  if (matchedSuffix) {
    base = base.slice(0, -matchedSuffix.length);
    base = base.replace(/\/+$/, "");
  }

  if (base.toLowerCase().endsWith("/v1")) {
    base = base.slice(0, -"/v1".length);
  }

  return base.replace(/\/+$/, "");
}

export function normalizeOpenAiApiKey(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.replace(/^bearer\s+/i, "").trim();
  return normalized ? normalized : undefined;
}

export function detectOpenAiCompatibilityIssue(options: {
  status?: number;
  errorText: string;
  apiSurface?: LlmApiSurface;
}): LlmCompatibilityIssue | null {
  const sanitizedText = sanitizeUpstreamErrorText(options.errorText, {
    maxLength: 500,
  });
  if (!sanitizedText) {
    return null;
  }

  const status = options.status;
  const lower = sanitizedText.toLowerCase();

  const hasUnsupportedCue = containsAny(lower, [
    "unsupported",
    "not supported",
    "not allowed",
    "not permitted",
    "unrecognized",
    "unknown",
    "extra fields",
    "additional properties",
    "unexpected field",
    "unexpected parameter",
  ]);

  const hasInvalidArgumentCue = containsAny(lower, [
    "invalid request argument",
    "invalid argument",
    "invalid parameter",
  ]);

  const hasResponsesEndpointReference = containsAny(lower, [
    "/v1/responses",
    "/responses",
    "responses api",
    "responses endpoint",
  ]);
  const hasResponsesRouteUnsupportedCue =
    status === 501 ||
    containsAny(lower, [
      "method not allowed",
      "not implemented",
      "does not support responses",
      "responses is not supported",
      "route not found",
      "unknown route",
      "unknown path",
      "no route",
      "endpoint not found",
      "not found",
    ]);

  if (
    [400, 404, 405, 501].includes(status ?? 0) &&
    options.apiSurface === "responses" &&
    hasResponsesEndpointReference &&
    hasResponsesRouteUnsupportedCue
  ) {
    return {
      code: "RESPONSES_API_UNSUPPORTED",
      incompatibleField: "apiSurface",
      hint: "Upstream gateway does not support Responses API. Use chat/completions for this profile.",
      upstreamMessage: sanitizedText,
      ...(status ? { status } : {}),
    };
  }

  if (status && ![400, 404, 405, 422, 501].includes(status)) {
    return null;
  }

  if (
    lower.includes("metadata") &&
    (hasUnsupportedCue || hasInvalidArgumentCue)
  ) {
    return {
      code: "UNSUPPORTED_METADATA",
      incompatibleField: "metadata",
      hint: "Remove metadata from request or switch to a gateway/provider that supports metadata forwarding.",
      upstreamMessage: sanitizedText,
      ...(status ? { status } : {}),
    };
  }

  if (
    (lower.includes("json_schema") ||
      lower.includes("json schema") ||
      lower.includes("structured output")) &&
    (hasUnsupportedCue || hasInvalidArgumentCue)
  ) {
    return {
      code: "UNSUPPORTED_JSON_SCHEMA",
      incompatibleField: "response_format.json_schema",
      hint: "This gateway does not support JSON schema structured outputs. Use json_object or plain text.",
      upstreamMessage: sanitizedText,
      ...(status ? { status } : {}),
    };
  }

  if (
    (lower.includes("response_format") || lower.includes("response format")) &&
    (hasUnsupportedCue || hasInvalidArgumentCue)
  ) {
    return {
      code: "UNSUPPORTED_RESPONSE_FORMAT",
      incompatibleField: "response_format",
      hint: "This gateway does not support response_format on this endpoint/model.",
      upstreamMessage: sanitizedText,
      ...(status ? { status } : {}),
    };
  }

  if (
    (lower.includes("messages") || lower.includes("message")) &&
    lower.includes("content") &&
    (hasUnsupportedCue ||
      hasInvalidArgumentCue ||
      lower.includes("invalid") ||
      lower.includes("must be"))
  ) {
    return {
      code: "INVALID_MESSAGE_CONTENT",
      incompatibleField: "messages[].content",
      hint: "Normalize message content to the OpenAI-compatible text format required by the upstream gateway.",
      upstreamMessage: sanitizedText,
      ...(status ? { status } : {}),
    };
  }

  return null;
}
