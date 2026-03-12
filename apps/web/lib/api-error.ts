import axios from "axios";

export interface ApiErrorInfo {
  code?: string;
  message: string;
  detail?: string;
  sourceId?: string;
  requiredKeys?: string[];
}

export const NEWS_SOURCE_RUNTIME_SECRET_REQUIRED_CODE =
  'NEWS_SOURCE_RUNTIME_SECRET_REQUIRED';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const extractFromPayload = (payload: unknown): ApiErrorInfo | null => {
  if (!payload) {
    return null;
  }

  if (typeof payload === "string") {
    return { message: payload };
  }

  if (!isRecord(payload)) {
    return null;
  }

  const directCode = payload.code;
  const directMessage = payload.message;
  const directDetail = payload.detail;
  if (typeof directCode === "string" && directCode.trim()) {
    return {
      code: directCode,
      message: typeof directMessage === "string" && directMessage.trim() ? directMessage : "Request failed",
      detail: typeof directDetail === "string" && directDetail.trim() ? directDetail : undefined,
      sourceId: typeof payload.sourceId === 'string' && payload.sourceId.trim() ? payload.sourceId : undefined,
      requiredKeys: Array.isArray(payload.requiredKeys)
        ? payload.requiredKeys.filter((key): key is string => typeof key === 'string' && key.trim().length > 0)
        : undefined,
    };
  }

  if (isRecord(directMessage)) {
    const nestedCode = directMessage.code;
    const nestedMessage = directMessage.message;
    const nestedDetail = directMessage.detail;
    if (typeof nestedCode === "string" && nestedCode.trim()) {
      return {
        code: nestedCode,
        message:
          typeof nestedMessage === "string" && nestedMessage.trim()
            ? nestedMessage
            : typeof payload.error === "string" && payload.error.trim()
              ? payload.error
              : "Request failed",
        detail: typeof nestedDetail === "string" && nestedDetail.trim() ? nestedDetail : undefined,
        sourceId:
          typeof directMessage.sourceId === 'string' && directMessage.sourceId.trim()
            ? directMessage.sourceId
            : undefined,
        requiredKeys: Array.isArray(directMessage.requiredKeys)
          ? directMessage.requiredKeys.filter(
              (key): key is string => typeof key === 'string' && key.trim().length > 0,
            )
          : undefined,
      };
    }
  }

  if (Array.isArray(directMessage)) {
    const messages = directMessage.map((entry) => String(entry)).filter(Boolean);
    if (messages.length > 0) {
      return { message: messages.join("; ") };
    }
  }

  if (typeof directMessage === "string" && directMessage.trim()) {
    return {
      message: directMessage,
      detail: typeof directDetail === "string" && directDetail.trim() ? directDetail : undefined
    };
  }

  return null;
};

export const extractApiError = (error: unknown): ApiErrorInfo => {
  if (axios.isAxiosError(error)) {
    const payload = extractFromPayload(error.response?.data);
    if (payload) {
      return payload;
    }
    return { message: error.message || "Request failed" };
  }

  if (error instanceof Error) {
    return { message: error.message };
  }

  return { message: "Request failed" };
};

export const isRuntimeSecretRequiredApiError = (error: unknown): boolean =>
  extractApiError(error).code === NEWS_SOURCE_RUNTIME_SECRET_REQUIRED_CODE;
