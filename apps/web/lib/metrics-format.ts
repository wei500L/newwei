import type { SupportedLocale } from "@/lib/i18n";

export interface RatioPercentFormatOptions {
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
}

export function formatRatioAsPercent(
  value: number | null | undefined,
  locale: SupportedLocale,
  options?: RatioPercentFormatOptions
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const formatter = new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: options?.minimumFractionDigits ?? 0,
    maximumFractionDigits: options?.maximumFractionDigits ?? 0
  });

  return formatter.format(value);
}

