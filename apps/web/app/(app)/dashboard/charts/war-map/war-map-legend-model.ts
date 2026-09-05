/**
 * War Map legend 模型计算（FE-批4B：自 war-map-symbols.tsx 拆出）。
 *
 * quick legend 与完整 legend 的纯模型层：不依赖 React，不依赖 swatch
 * 组件；密度上限、transport 优先级与 AIS mode 分支在此收口。
 */
import type {
  OverlayDensity,
  WarMapTranslateFn,
  WarMapActivePointLayerLegendItem,
  WarMapLegendItem,
  WarMapLegendMatchablePoint,
  WarMapLegendSection,
  WarMapTransportLegendState,
  WarMapLegendAisMode,
  WarMapSymbolKey,
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

export function buildWarMapLegendSections({
  t,
  showMonitors,
  showFlights,
  showAis,
  effectiveAisMode,
  activePointLayers,
  transportState,
}: {
  t: WarMapTranslateFn;
  showMonitors: boolean;
  showFlights: boolean;
  showAis: boolean;
  effectiveAisMode: WarMapLegendAisMode;
  activePointLayers: WarMapActivePointLayerLegendItem[];
  transportState?: WarMapTransportLegendState;
}): WarMapLegendSection[] {
  const sections: WarMapLegendSection[] = [
    {
      key: "signals",
      title: t("dashboard.charts.warMap.legend.signalsTitle"),
      description: t("dashboard.charts.warMap.legend.signalsHint"),
      defaultExpanded: true,
      items: ["signal-high", "signal-medium", "signal-low"].map(
        (symbolKey) => ({
          key: symbolKey,
          symbolKey: symbolKey as WarMapSymbolKey,
          label: resolveWarMapLegendLabel(symbolKey as WarMapSymbolKey, t),
          matchSymbolKeys: [symbolKey as WarMapSymbolKey],
        }),
      ),
    },
    {
      key: "transport",
      title: t("dashboard.charts.warMap.legend.transportTitle"),
      description: t("dashboard.charts.warMap.legend.transportHint"),
      statusLabel: transportState?.sectionStatusLabel,
      statusTone: transportState?.sectionStatusTone,
      statusHint: transportState?.sectionStatusHint,
      defaultExpanded: true,
      items: [],
    },
    {
      key: "news",
      title: t("dashboard.charts.warMap.legend.newsTitle"),
      description: t("dashboard.charts.warMap.legend.newsHint"),
      defaultExpanded: true,
      items: [
        {
          key: "news-geocoded",
          symbolKey: "news-geocoded",
          label: resolveWarMapLegendLabel("news-geocoded", t),
          matchSymbolKeys: ["news-geocoded"],
        },
        {
          key: "news-fallback",
          symbolKey: "news-fallback",
          label: resolveWarMapLegendLabel("news-fallback", t),
          matchSymbolKeys: ["news-fallback"],
        },
        ...(showMonitors
          ? [
              {
                key: "monitor",
                symbolKey: "monitor" as const,
                label: resolveWarMapLegendLabel("monitor", t),
                matchSymbolKeys: ["monitor" as const],
              },
            ]
          : []),
      ],
    },
  ];

  const transportItems: WarMapLegendItem[] = [];

  if (showFlights) {
    transportItems.push({
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
      transportItems.push({
        key: "ais-density",
        symbolKey: "ais-density",
        label: resolveWarMapLegendLabel("ais-density", t),
        note: transportState?.aisPrimary?.note,
        countLabel: transportState?.aisPrimary?.countLabel,
        tone: transportState?.aisPrimary?.tone,
        matchSymbolKeys: ["ais-density"],
      });
    }

    transportItems.push(
      {
        key: "ais-disruption-high",
        symbolKey: "ais-disruption-high",
        label: resolveWarMapLegendLabel("ais-disruption-high", t),
        note: transportState?.aisDisruption?.note,
        countLabel: transportState?.aisDisruption?.countLabel,
        tone: transportState?.aisDisruption?.tone,
        matchSymbolKeys: ["ais-disruption-high"],
      },
      {
        key: "ais-disruption-medium",
        symbolKey: "ais-disruption-medium",
        label: resolveWarMapLegendLabel("ais-disruption-medium", t),
        matchSymbolKeys: ["ais-disruption-medium"],
      },
      {
        key: "ais-disruption-low",
        symbolKey: "ais-disruption-low",
        label: resolveWarMapLegendLabel("ais-disruption-low", t),
        matchSymbolKeys: ["ais-disruption-low"],
      },
    );

    if (effectiveAisMode !== "density") {
      transportItems.push(
        {
          key: "ais-vessel-military",
          symbolKey: "ais-vessel-military",
          label: resolveWarMapLegendLabel("ais-vessel-military", t),
          note:
            effectiveAisMode === "military"
              ? transportState?.aisPrimary?.note
              : undefined,
          countLabel:
            effectiveAisMode === "military"
              ? transportState?.aisPrimary?.countLabel
              : undefined,
          tone:
            effectiveAisMode === "military"
              ? transportState?.aisPrimary?.tone
              : undefined,
          matchSymbolKeys: ["ais-vessel-military"],
        },
        {
          key: "ais-vessel-fishing",
          symbolKey: "ais-vessel-fishing",
          label: resolveWarMapLegendLabel("ais-vessel-fishing", t),
          matchSymbolKeys: ["ais-vessel-fishing"],
        },
        {
          key: "ais-vessel-passenger",
          symbolKey: "ais-vessel-passenger",
          label: resolveWarMapLegendLabel("ais-vessel-passenger", t),
          matchSymbolKeys: ["ais-vessel-passenger"],
        },
        {
          key: "ais-vessel-cargo",
          symbolKey: "ais-vessel-cargo",
          label: resolveWarMapLegendLabel("ais-vessel-cargo", t),
          matchSymbolKeys: ["ais-vessel-cargo"],
        },
        {
          key: "ais-vessel-tanker",
          symbolKey: "ais-vessel-tanker",
          label: resolveWarMapLegendLabel("ais-vessel-tanker", t),
          matchSymbolKeys: ["ais-vessel-tanker"],
        },
        {
          key: "ais-vessel-other",
          symbolKey: "ais-vessel-other",
          label: resolveWarMapLegendLabel("ais-vessel-other", t),
          matchSymbolKeys: ["ais-vessel-other"],
        },
      );
    }
  }

  if (transportItems.length > 0) {
    const transportSection = sections.find(
      (section) => section.key === "transport",
    );
    if (transportSection) {
      transportSection.items = transportItems;
    }
  } else {
    const transportSectionIndex = sections.findIndex(
      (section) => section.key === "transport",
    );
    if (transportSectionIndex >= 0) {
      sections.splice(transportSectionIndex, 1);
    }
  }

  if (activePointLayers.length > 0) {
    sections.push({
      key: "other-point-layers",
      title: t("dashboard.charts.warMap.legend.otherLayersTitle"),
      description: t("dashboard.charts.warMap.legend.otherLayersHint"),
      defaultExpanded: false,
      items: activePointLayers.map((item) => ({
        key: item.key,
        symbolKey: "generic-point",
        accentColor: item.accentColor,
        label: item.label,
        matchLayerIds: [item.key],
      })),
    });
  }

  return sections;
}

export function buildWarMapInteractionLegendItems({
  t,
}: {
  t: WarMapTranslateFn;
}): WarMapLegendItem[] {
  return [
    {
      key: "hover",
      symbolKey: "signal-medium",
      state: "hover",
      label: t("dashboard.charts.warMap.legend.hoverState"),
      matchSymbolKeys: ["signal-medium"],
    },
    {
      key: "selected",
      symbolKey: "signal-medium",
      state: "selected",
      label: t("dashboard.charts.warMap.legend.selectedState"),
      matchSymbolKeys: ["signal-medium"],
    },
    {
      key: "cluster",
      symbolKey: "signal-medium",
      state: "cluster",
      countLabel: "12",
      label: t("dashboard.charts.warMap.legend.clusterState"),
      matchSymbolKeys: ["signal-medium"],
    },
  ];
}

export function formatWarMapClusterCountLabel(count: number): string {
  if (!Number.isFinite(count)) {
    return "";
  }
  const normalizedCount = Math.max(0, Math.round(count));
  if (normalizedCount === 0) {
    return "";
  }
  if (normalizedCount > 999) {
    return "999+";
  }
  return String(normalizedCount);
}
