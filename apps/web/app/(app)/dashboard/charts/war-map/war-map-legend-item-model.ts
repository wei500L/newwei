/**
 * War Map legend 公共匹配与 label 解析（FE-批4B 收口：自 war-map-legend-model.ts 拆出）。
 *
 * quick 与 full legend 共用的 item 匹配语义与 symbolKey→i18n label
 * 解析：纯模型层，不依赖 React，不依赖 swatch 组件。
 */
import type {
  WarMapLegendItem,
  WarMapLegendMatchablePoint,
  WarMapSymbolKey,
  WarMapTranslateFn,
} from "./war-map-symbol-types";

export function matchesWarMapLegendItem(
  item: Pick<
    WarMapLegendItem,
    "symbolKey" | "matchSymbolKeys" | "matchLayerIds"
  >,
  point: WarMapLegendMatchablePoint,
): boolean {
  if (
    point.layerId &&
    Array.isArray(item.matchLayerIds) &&
    item.matchLayerIds.includes(point.layerId)
  ) {
    return true;
  }

  const matchSymbolKeys = item.matchSymbolKeys ?? [item.symbolKey];
  return matchSymbolKeys.includes(point.symbolKey);
}

export function resolveWarMapLegendLabel(
  symbolKey: WarMapSymbolKey,
  t: WarMapTranslateFn,
): string {
  switch (symbolKey) {
    case "signal-high":
      return t("dashboard.charts.warMap.legend.signalHigh");
    case "signal-medium":
      return t("dashboard.charts.warMap.legend.signalMedium");
    case "signal-low":
      return t("dashboard.charts.warMap.legend.signalLow");
    case "news-geocoded":
      return t("dashboard.charts.warMap.legend.newsGeocoded");
    case "news-fallback":
      return t("dashboard.charts.warMap.legend.newsFallback");
    case "monitor":
      return t("dashboard.charts.warMap.legend.monitor");
    case "flight":
      return t("dashboard.charts.warMap.legend.flight");
    case "ais-vessel-military":
      return t("dashboard.charts.warMap.legend.aisMilitary");
    case "ais-vessel-fishing":
      return t("dashboard.charts.warMap.legend.aisFishing");
    case "ais-vessel-passenger":
      return t("dashboard.charts.warMap.legend.aisPassenger");
    case "ais-vessel-cargo":
      return t("dashboard.charts.warMap.legend.aisCargo");
    case "ais-vessel-tanker":
      return t("dashboard.charts.warMap.legend.aisTanker");
    case "ais-vessel-other":
      return t("dashboard.charts.warMap.legend.aisOther");
    case "ais-vessel-generic":
      return t("dashboard.charts.warMap.legend.aisAllVesselsQuick");
    case "ais-density":
      return t("dashboard.charts.warMap.legend.aisDensity");
    case "ais-disruption-high":
      return t("dashboard.charts.warMap.legend.aisDisruptionHigh");
    case "ais-disruption-medium":
      return t("dashboard.charts.warMap.legend.aisDisruptionMedium");
    case "ais-disruption-low":
      return t("dashboard.charts.warMap.legend.aisDisruptionLow");
    case "generic-point":
    default:
      return t("dashboard.charts.warMap.legend.otherPointLayer");
  }
}
