/**
 * War Map 完整 legend 模型（FE-批4B 收口：自 war-map-legend-model.ts 拆出）。
 *
 * 完整 legend sections 构造（transport 节插入/整体移除）、interaction
 * legend 项与 cluster count label：纯模型层，不依赖 React，不依赖
 * swatch/Controls/Overlay 组件。
 */
import { resolveWarMapLegendLabel } from "./war-map-legend-item-model";
import type {
  WarMapActivePointLayerLegendItem,
  WarMapLegendAisMode,
  WarMapLegendItem,
  WarMapLegendSection,
  WarMapSymbolKey,
  WarMapTranslateFn,
  WarMapTransportLegendState,
} from "./war-map-symbol-types";

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
