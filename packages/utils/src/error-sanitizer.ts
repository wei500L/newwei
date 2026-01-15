/**
 * Error sanitization utility for production-safe error handling.
 * Removes stack traces in production and redacts sensitive field patterns.
 */

/**
 * Patterns that indicate sensitive data in error messages
 */
const SENSITIVE_PATTERNS = [
  /password\s*[=:]\s*['"]?[^'"\s,}]+['"]?/gi,
  /token\s*[=:]\s*['"]?[^'"\s,}]+['"]?/gi,
  /apiKey\s*[=:]\s*['"]?[^'"\s,}]+['"]?/gi,
  /api_key\s*[=:]\s*['"]?[^'"\s,}]+['"]?/gi,
  /secret\s*[=:]\s*['"]?[^'"\s,}]+['"]?/gi,
  /credential\s*[=:]\s*['"]?[^'"\s,}]+['"]?/gi,
  /auth\s*[=:]\s*['"]?[^'"\s,}]+['"]?/gi,
  /bearer\s+[a-zA-Z0-9._-]+/gi,
  /basic\s+[a-zA-Z0-9+/=]+/gi,
];

/**
 * Replacement text for redacted sensitive values
 */
const REDACTED = "[REDACTED]";

export interface SanitizeErrorOptions {
  /**
   * Force production mode behavior (remove stack traces)
   * If not specified, uses NODE_ENV environment variable
   */
  forceProduction?: boolean;

  /**
   * Include stack trace even in production (for debugging)
   * Default: false
   */
  includeStack?: boolean;

  /**
   * Redact sensitive patterns from error message
   * Default: true
   */
  redactSensitive?: boolean;
}

export interface SanitizedError {
  message: string;
  name?: string;
  stack?: string;
  status?: number;
}

/**
 * Check if running in production environment
 */
function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Redact sensitive field patterns from a string
 */
export function redactSensitiveFields(input: string): string {
  if (!input || typeof input !== "string") {
    return input;
  }

  let result = input;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, (match) => {
      const separatorMatch = match.match(/[=:]/);
      if (separatorMatch) {
        const separator = separatorMatch[0];
        const keyPart = match.substring(0, match.indexOf(separator) + 1);
        return `${keyPart}${REDACTED}`;
      }
      // For bearer/basic auth patterns
      if (match.toLowerCase().startsWith("bearer")) {
        return `Bearer ${REDACTED}`;
      }
      if (match.toLowerCase().startsWith("basic")) {
        return `Basic ${REDACTED}`;
      }
      return REDACTED;
    });
  }

  return result;
}

/**
 * Sanitize an error for safe logging/storage.
 *
 * In production mode:
 * - Removes stack traces (unless includeStack is true)
 * - Redacts sensitive field patterns from messages
 *
 * In development mode:
 * - Preserves full stack traces
 * - Still redacts sensitive patterns by default
 *
 * @param error - The error to sanitize (Error object or unknown value)
 * @param options - Sanitization options
 * @returns Sanitized error object safe for logging
 */
export function sanitizeError(
  error: unknown,
  options: SanitizeErrorOptions = {}
): SanitizedError {
  const {
    forceProduction,
    includeStack = false,
    redactSensitive = true,
  } = options;

  const productionMode = forceProduction ?? isProduction();

  // Handle non-Error inputs
  if (!(error instanceof Error)) {
    const message = error === null || error === undefined
      ? "Unknown error"
      : String(error);

    return {
      message: redactSensitive ? redactSensitiveFields(message) : message,
    };
  }

  // Handle Error instances
  let message = error.message || "Unknown error";
  if (redactSensitive) {
    message = redactSensitiveFields(message);
  }

  const result: SanitizedError = {
    message,
    name: error.name,
  };

  // Include stack trace based on environment and options
  if (!productionMode || includeStack) {
    result.stack = error.stack;
  }

  // Preserve status code if present (e.g., from HTTP errors)
  if ("status" in error && typeof (error as { status?: unknown }).status === "number") {
    result.status = (error as { status: number }).status;
  }

  return result;
}
