/**
 * War Map quick legend 模型（FE-批4B 收口：自 war-map-legend-model.ts 拆出）。
 *
 * quick legend 显隐、密度数量上限、transport 必选项替换与快捷项构造：
 * 纯模型层，不依赖 React，不依赖 swatch/Controls/Overlay 组件。
 */
import { resolveWarMapLegendLabel } from "./war-map-legend-item-model";
import type {
  OverlayDensity,
  WarMapLegendAisMode,
  WarMapLegendItem,
  WarMapTransportLegendState,
  WarMapTranslateFn,
} from "./war-map-symbol-types";

const QUICK_LEGEND_DENSITIES = new Set<OverlayDensity>(["expanded", "compact"]);

export function getQuickLegendVisibility(density: OverlayDensity): boolean {
  return QUICK_LEGEND_DENSITIES.has(density);
}

function getQuickLegendMaxVisibleCount(density: OverlayDensity): number {
  if (density === "expanded") {
    return 7;
  }
  if (density === "compact") {
    return 6;
  }
  return 0;
}

export function selectVisibleQuickLegendItems({
  density,
  items,
}: {
  density: OverlayDensity;
  items: WarMapLegendItem[];
}): {
  visibleItems: WarMapLegendItem[];
  hiddenCount: number;
} {
  const maxVisibleCount = getQuickLegendMaxVisibleCount(density);
  if (maxVisibleCount <= 0 || items.length === 0) {
    return {
      visibleItems: [],
      hiddenCount: items.length,
    };
  }

  const visibleKeys = items.slice(0, maxVisibleCount).map((item) => item.key);
  const removablePriority = [
    "signal-low",
    "signal-medium",
    "monitor",
    "news-geocoded",
  ];
  const requiredKeys = [
    items.find((item) => item.key === "flight")?.key,
    items.find((item) =>
      ["ais-density", "ais-vessel-generic", "ais-vessel-military"].includes(
        item.key,
      ),
    )?.key,
  ].filter((value): value is string => Boolean(value));

  for (const requiredKey of requiredKeys) {
    if (visibleKeys.includes(requiredKey)) {
      continue;
    }

    const replacementKey = removablePriority.find((candidate) =>
      visibleKeys.includes(candidate),
    );
    const replacementIndex =
      replacementKey === undefined
        ? visibleKeys.length < maxVisibleCount
          ? visibleKeys.length
          : Math.max(visibleKeys.length - 1, 0)
        : visibleKeys.indexOf(replacementKey);

    visibleKeys[replacementIndex] = requiredKey;
  }

  const visibleKeySet = new Set(visibleKeys);
  const visibleItems = items
    .filter((item) => visibleKeySet.has(item.key))
    .slice(0, maxVisibleCount);

  return {
    visibleItems,
    hiddenCount: Math.max(0, items.length - visibleItems.length),
  };
}

export function buildWarMapQuickLegendItems({
  t,
  showMonitors,
  showFlights,
  showAis,
  effectiveAisMode,
  transportState,
}: {
  t: WarMapTranslateFn;
  showMonitors: boolean;
  showFlights: boolean;
  showAis: boolean;
  effectiveAisMode: WarMapLegendAisMode;
  transportState?: WarMapTransportLegendState;
}): WarMapLegendItem[] {
  const items: WarMapLegendItem[] = [
    {
      key: "signal-high",
      symbolKey: "signal-high",
      label: resolveWarMapLegendLabel("signal-high", t),
      matchSymbolKeys: ["signal-high"],
    },
    {
      key: "signal-medium",
      symbolKey: "signal-medium",
      label: resolveWarMapLegendLabel("signal-medium", t),
      matchSymbolKeys: ["signal-medium"],
    },
    {
      key: "signal-low",
      symbolKey: "signal-low",
      label: resolveWarMapLegendLabel("signal-low", t),
      matchSymbolKeys: ["signal-low"],
    },
    {
      key: "news-geocoded",
      symbolKey: "news-geocoded",
      label: resolveWarMapLegendLabel("news-geocoded", t),
      matchSymbolKeys: ["news-geocoded"],
    },
  ];

  if (showMonitors) {
    items.push({
      key: "monitor",
      symbolKey: "monitor",
      label: resolveWarMapLegendLabel("monitor", t),
      matchSymbolKeys: ["monitor" as const],
    });
  }

  if (showFlights) {
    items.push({
      key: "flight",
      symbolKey: "flight",
      label: resolveWarMapLegendLabel("flight", t),
      note: transportState?.flights?.note,
      countLabel: transportState?.flights?.countLabel,
      tone: transportState?.flights?.tone,
      matchSymbolKeys: ["flight"],
    });
  }

  if (showAis) {
    if (effectiveAisMode === "density") {
      items.push(
        {
          key: "ais-density",
          symbolKey: "ais-density",
          label: resolveWarMapLegendLabel("ais-density", t),
          note: transportState?.aisPrimary?.note,
          countLabel: transportState?.aisPrimary?.countLabel,
          tone: transportState?.aisPrimary?.tone,
          matchSymbolKeys: ["ais-density"],
        },
        {
          key: "ais-disruption",
          symbolKey: "ais-disruption-high",
          label: t("dashboard.charts.warMap.legend.aisDisruptionQuick"),
          note: transportState?.aisDisruption?.note,
          countLabel: transportState?.aisDisruption?.countLabel,
          tone: transportState?.aisDisruption?.tone,
          matchSymbolKeys: [
            "ais-disruption-high",
            "ais-disruption-medium",
            "ais-disruption-low",
          ],
        },
      );
    } else if (effectiveAisMode === "all") {
      items.push(
        {
          key: "ais-vessel-generic",
          symbolKey: "ais-vessel-generic",
          label: resolveWarMapLegendLabel("ais-vessel-generic", t),
          note:
            transportState?.aisPrimary?.note ??
            t("dashboard.charts.warMap.legend.quickColorByCategory"),
          countLabel: transportState?.aisPrimary?.countLabel,
          tone: transportState?.aisPrimary?.tone,
          matchSymbolKeys: [
            "ais-vessel-military",
            "ais-vessel-fishing",
            "ais-vessel-passenger",
            "ais-vessel-cargo",
            "ais-vessel-tanker",
            "ais-vessel-other",
            "ais-vessel-generic",
          ],
        },
        {
          key: "ais-disruption",
          symbolKey: "ais-disruption-high",
          label: t("dashboard.charts.warMap.legend.aisDisruptionQuick"),
          note: transportState?.aisDisruption?.note,
          countLabel: transportState?.aisDisruption?.countLabel,
          tone: transportState?.aisDisruption?.tone,
          matchSymbolKeys: [
            "ais-disruption-high",
            "ais-disruption-medium",
            "ais-disruption-low",
          ],
        },
      );
    } else {
      items.push(
        {
          key: "ais-vessel-military",
          symbolKey: "ais-vessel-military",
          label: resolveWarMapLegendLabel("ais-vessel-military", t),
          note: transportState?.aisPrimary?.note,
          countLabel: transportState?.aisPrimary?.countLabel,
          tone: transportState?.aisPrimary?.tone,
          matchSymbolKeys: ["ais-vessel-military"],
        },
        {
          key: "ais-disruption",
          symbolKey: "ais-disruption-high",
          label: t("dashboard.charts.warMap.legend.aisDisruptionQuick"),
          note: transportState?.aisDisruption?.note,
          countLabel: transportState?.aisDisruption?.countLabel,
          tone: transportState?.aisDisruption?.tone,
          matchSymbolKeys: [
            "ais-disruption-high",
            "ais-disruption-medium",
            "ais-disruption-low",
          ],
        },
      );
    }
  }

  return items;
}
