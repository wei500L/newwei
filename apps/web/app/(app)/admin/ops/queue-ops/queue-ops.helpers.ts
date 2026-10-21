import { formatDateTime, type SupportedLocale } from "@/lib/i18n";

/**
 * 队列运维的纯展示 helper（无 React / antd 依赖），便于直接单测：
 * 时间格式化、JSON 美化、预览截断。
 */

export const QUEUE_OPS_EMPTY_VALUE = "-";

export function formatQueueOpsTimestamp(
  value: number | null | undefined,
  locale: SupportedLocale,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return QUEUE_OPS_EMPTY_VALUE;
  }
  const formatted = formatDateTime(value, locale, {
    dateStyle: "short",
    timeStyle: "medium",
  });
  return formatted.trim().length > 0 ? formatted : QUEUE_OPS_EMPTY_VALUE;
}

/** `data` / `opts` / `returnvalue` 的 JSON 美化；字符串原样返回。 */
export function formatQueueOpsJson(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    const serialized = JSON.stringify(value, null, 2);
    return typeof serialized === "string" ? serialized : String(value);
  } catch {
    return String(value);
  }
}

/** 列表里的 dataPreview 截断（与详情的完整 JSON 区分）。 */
export function truncateQueueOpsPreview(
  value: string,
  maxLength = 120,
): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}…`;
}

export function formatQueueOpsJobName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : QUEUE_OPS_EMPTY_VALUE;
}

export function formatQueueOpsFailedReason(reason: string): string {
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : QUEUE_OPS_EMPTY_VALUE;
}
