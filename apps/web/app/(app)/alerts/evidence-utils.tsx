import { Typography } from "antd";
import type { ReactNode } from "react";

import { formatDateTime, type resolveLocale } from "@/lib/i18n";

/**
 * Alert Center 证据域共享格式化逻辑（FE-批3 拆分）。
 *
 * 从 alert-center.tsx 的组件体内提出（纯函数 + 无状态展示件），
 * 行为保持不变。evidence 各 provider 组件共用。
 */

export type TranslateFn = (key: string, options?: Record<string, unknown>) => string;
export type LocaleCode = ReturnType<typeof resolveLocale>;

export const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

export const toStringValue = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toString();
  }
  return undefined;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export const safeJsonStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

export const formatFixed = (value: unknown, digits = 4): string => {
  const numberValue = toNumber(value);
  return typeof numberValue === "number" ? numberValue.toFixed(digits) : "";
};

export const formatPercent = (value: unknown, digits = 1): string => {
  const numberValue = toNumber(value);
  return typeof numberValue === "number"
    ? `${(numberValue * 100).toFixed(digits)}%`
    : "";
};

export const formatMetricChange = (
  value: number | null | undefined,
  fallback: string,
): string => {
  if (typeof value !== "number") {
    return fallback;
  }
  return `${value.toFixed(2)}%`;
};

export const formatContextValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toString() : String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => formatContextValue(item))
      .filter(Boolean)
      .join(", ");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/** 详情页字段行（label + children 纵向排列）。 */
export function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <Typography.Text type="secondary">{label}</Typography.Text>
      <div>{children}</div>
    </div>
  );
}

/** 证据时间戳的统一格式（保留原 alert-center 的完整格式）。 */
export const formatEvidenceTimestamp = (
  value: string | number | undefined,
  locale: LocaleCode,
): string =>
  value
    ? formatDateTime(value, locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      })
    : "";
