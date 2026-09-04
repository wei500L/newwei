import {
  formatRelativeTime,
  formatUpdatedAt,
  type SupportedLocale,
} from "@/lib/i18n";

/** 相对时间戳（短相对格式优先，退化到绝对更新时间）。 */
export function formatWarMapRelativeTimestamp(
  value: string | number | Date | undefined,
  locale: SupportedLocale,
  base: number,
): string | null {
  if (value === undefined) {
    return null;
  }
/** 相对时间戳（短相对格式优先，退化到绝对更新时间）。 */
export function formatWarMapRelativeTimestamp(
  value: string | number | Date | undefined,
  locale: SupportedLocale,
  base: number,
): string | null {
  if (value === undefined) {
    return null;
  }

  return (
    formatRelativeTime(value, locale, {
      base,
      style: "short",
    }) || formatUpdatedAt(value, locale)
  );
}

export function getErrorMessage(error: unknown): string | undefined {
  if (!error) {
    return undefined;
  }
  if (error instanceof Error) {
    const withResponse = error as Error & {
      response?: { data?: { message?: string; error?: { message?: string } } };
    };
    const data = withResponse.response?.data;
    return data?.error?.message ?? data?.message ?? withResponse.message;
  }
  return typeof error === "string" ? error : undefined;
}

interface WarMapUpdatedChainQueryLike {
  isFetching: boolean;
  error: unknown;
  data?: { updatedAt?: string };
  dataUpdatedAt: number;
}

