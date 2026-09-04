import type { AlertEventsQuery } from "@/graphql/generated";
import type { resolveLocale } from "@/lib/i18n";

import type { TranslateFn } from "./evidence-utils";

/**
 * Alert Center 列表/详情域共享的纯派生模型（FE-批3B）。
 *
 * buildThresholdSummary 从 alert-center.tsx 原样迁出：operator/threshold
 * → 展示摘要（跨详情页签与列表行共用，文案 key 不变）。
 */

export type AlertEventItem = AlertEventsQuery["alertEvents"][number];
export type LocaleCode = ReturnType<typeof resolveLocale>;
export type { TranslateFn };

export const buildThresholdSummary = (
  operator: string | null | undefined,
  thresholdValue: number | undefined,
  lower: number | undefined,
  upper: number | undefined,
  t: TranslateFn,
) => {
  if (!operator) {
    return t("common.notAvailable");
  }
  const operatorSymbolMap: Record<string, string> = {
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
    eq: "=",
  };
  if (operator === "outside_range" || operator === "within_range") {
    if (lower === undefined || upper === undefined) {
      return t("common.notAvailable");
    }
    const range = `${lower} - ${upper}`;
    return t(
      operator === "outside_range"
        ? "alerts.center.threshold.outside"
        : "alerts.center.threshold.within",
      {
        defaultValue: `${operator === "outside_range" ? "Outside" : "Within"} ${range}`,
        range,
      },
    );
  }
  if (operator === "change_up_pct" || operator === "change_down_pct") {
    if (thresholdValue === undefined) {
      return t("common.notAvailable");
    }
    const symbol = operator === "change_up_pct" ? ">=" : "<=";
    return t("alerts.center.threshold.changePct", {
      defaultValue: `Change ${symbol} ${thresholdValue}%`,
      symbol,
      value: thresholdValue,
    });
  }
  if (thresholdValue === undefined) {
    return t("common.notAvailable");
  }
  const symbol = operatorSymbolMap[operator] ?? operator;
  return `${symbol} ${thresholdValue}`;
};
