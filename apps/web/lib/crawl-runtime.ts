export type HeadedIssueKind = "display" | "timeout" | "unknown";

const DISPLAY_KEYWORDS = [
  "cannot open display",
  "missing x server",
  "display/xvfb",
  "$display"
];

const TIMEOUT_KEYWORDS = [
  "timed out",
  "timeout",
  "navigation timeout",
  "probe timed out",
  "aborterror",
  "etimedout"
];

function normalizeMessage(message?: string): string {
  return typeof message === "string" ? message.trim().toLowerCase() : "";
}

export function isDisplayDependencyError(message?: string): boolean {
  const normalized = normalizeMessage(message);
  if (!normalized) {
    return false;
  }

  if (DISPLAY_KEYWORDS.some((token) => normalized.includes(token))) {
    return true;
  }

  if (normalized.includes("display") && normalized.includes("not available")) {
    return true;
  }

  if (normalized.includes("display") && normalized.includes("failed")) {
    return true;
  }

  if (
    normalized.includes("xvfb") &&
    (normalized.includes("display") ||
      normalized.includes("x server") ||
      normalized.includes("not available") ||
      normalized.includes("failed to start"))
  ) {
    return true;
  }

  if (normalized.includes("x11") && normalized.includes("display")) {
    return true;
  }

  if (normalized.includes("headless=false") && normalized.includes("display")) {
    return true;
  }

  return false;
}

export function classifyHeadedIssue(message?: string): HeadedIssueKind {
  const normalized = normalizeMessage(message);
  if (!normalized) {
    return "unknown";
  }

  if (isDisplayDependencyError(normalized)) {
    return "display";
  }

  if (TIMEOUT_KEYWORDS.some((token) => normalized.includes(token))) {
    return "timeout";
  }

  return "unknown";
}
