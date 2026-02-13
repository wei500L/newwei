const DEEP_DISCOVERY_ERROR_CODE_PREFIX = "SEED_DEEP_";

export const DEEP_DISCOVERY_UNKNOWN_ERROR_CODE = `${DEEP_DISCOVERY_ERROR_CODE_PREFIX}UNKNOWN`;
export const DEEP_DISCOVERY_FAILURE_STATE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const DEEP_DISCOVERY_FAILURE_STATS_TTL_SECONDS = 24 * 60 * 60;

export interface DeepDiscoveryErrorInfo {
  code: string;
  message: string;
  detail?: string;
  rawMessage: string;
}

export interface DeepDiscoveryFailureState {
  streak: number;
  lastFailureAt: string;
  lastCode: string;
  lastMessage: string;
  lastDetail?: string;
  retryAt: string;
  nextRunAt: string;
  circuitOpenUntil?: string | null;
}

export interface DeepDiscoveryFailureStats24h {
  total: number;
  byCode: Record<string, number>;
  updatedAt: string;
}

const DETAIL_MARKERS = [/\s(?:Adjust|Refine|Tighten)\b/i, /\sdiscovered=/i];

const normalizeRawErrorMessage = (error: unknown) => {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^[A-Z][A-Za-z\s]+Exception:\s*/u, "").trim();
};

const splitDeepErrorBody = (body: string) => {
  const lines = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length > 1) {
    return {
      message: lines[0] ?? body,
      detail: lines.slice(1).join(" "),
    };
  }

  const firstMatch = DETAIL_MARKERS.reduce<number | null>((best, pattern) => {
    const next = body.search(pattern);
    if (next <= 0) {
      return best;
    }
    if (best === null || next < best) {
      return next;
    }
    return best;
  }, null);

  if (firstMatch === null) {
    return { message: body.trim(), detail: undefined };
  }

  return {
    message: body.slice(0, firstMatch).trim(),
    detail: body.slice(firstMatch).trim(),
  };
};

export const parseDeepDiscoveryError = (
  error: unknown,
): DeepDiscoveryErrorInfo | null => {
  const rawMessage = normalizeRawErrorMessage(error);
  if (!rawMessage) {
    return null;
  }

  const matched = /^\[([A-Z0-9_]+)\]\s*([\s\S]*)$/u.exec(rawMessage);
  if (!matched) {
    return null;
  }

  const code = matched[1] ?? "";
  if (!code.startsWith(DEEP_DISCOVERY_ERROR_CODE_PREFIX)) {
    return null;
  }

  const body = (matched[2] ?? "").trim();
  if (!body) {
    return {
      code,
      message: rawMessage,
      rawMessage,
    };
  }

  const split = splitDeepErrorBody(body);
  return {
    code,
    message: split.message.length > 0 ? split.message : body,
    detail: split.detail && split.detail.length > 0 ? split.detail : undefined,
    rawMessage,
  };
};

export const normalizeDeepDiscoveryError = (
  error: unknown,
): DeepDiscoveryErrorInfo => {
  const parsed = parseDeepDiscoveryError(error);
  if (parsed) {
    return parsed;
  }

  const rawMessage = normalizeRawErrorMessage(error);
  return {
    code: DEEP_DISCOVERY_UNKNOWN_ERROR_CODE,
    message: rawMessage || "Deep discovery failed with unknown error.",
    rawMessage: rawMessage || "Deep discovery failed with unknown error.",
  };
};

export const deepDiscoveryFailureStateCacheKey = (sourceId: string) =>
  `news-source:deep-failure:state:${sourceId}`;

export const deepDiscoveryFailureStatsCacheKey = (sourceId: string) =>
  `news-source:deep-failure:stats24h:${sourceId}`;
