import type { WarMapFlightMode } from "@modular/utils";

import { formatDateTime, type SupportedLocale } from "@/lib/i18n";

import type { WarMapTranslateFn } from "./war-map-overlay-model";
import {
  formatAisShipTypeLabel,
  toLayerLabel,
  type DeckPoint,
} from "./war-map-point-model";

export interface WarMapTooltipGetterContext {
  t: WarMapTranslateFn;
  locale: SupportedLocale;
  flightMode: WarMapFlightMode;
}

/**
 * 构造 Deck tooltip getter（FE-批4A：从 war-map.tsx tooltipGetter 迁移）。
 * 聚类/事件/新闻/AIS/航班的逐行文案契约不变。
 */
export function createWarMapTooltipGetter(context: WarMapTooltipGetterContext) {
  const { t, locale, flightMode } = context;
  return ({ object }: { object?: DeckPoint }) => {
    if (!object) {
      return null;
    }
    if (object.kind === "event-cluster") {
      const count = object.clusterCount ?? 0;
      return {
        text: t("dashboard.charts.warMap.tooltip.clusterSignals", {
          count,
        }),
      };
    }
    if (object.kind === "news-cluster") {
      const count = object.clusterCount ?? 0;
      return {
        text: t("dashboard.charts.warMap.tooltip.clusterNews", {
          count,
        }),
      };
    }
    if (object.kind === "layer-cluster") {
      const count = object.clusterCount ?? 0;
      const layerLabel = object.layerId
        ? t(`dashboard.charts.warMap.layerNames.${object.layerId}`, {
            defaultValue: toLayerLabel(object.layerId),
          })
        : object.label;
      return {
        text:
          object.layerId === "flights"
            ? t("dashboard.charts.warMap.tooltip.clusterFlights", {
                defaultValue:
                  flightMode === "all"
                    ? "{{count}} flights. Click to zoom in."
                    : "{{count}} military/possible military flights. Click to zoom in.",
                count,
              })
            : t("dashboard.charts.warMap.tooltip.clusterLayer", {
                count,
                layer: layerLabel,
              }),
      };
    }

    const latestTimestamp =
      object.publishedAt ?? object.ingestedAt ?? object.latestAt;
    const latestLabel =
      object.kind === "event"
        ? t("dashboard.charts.warMap.panel.latest")
        : object.kind === "layer" &&
            (object.layerId === "flights" || object.layerId === "ais")
          ? t("dashboard.charts.warMap.tooltip.observed")
          : object.publishedAt
            ? t("dashboard.charts.warMap.tooltip.published")
            : object.ingestedAt
              ? t("dashboard.charts.warMap.tooltip.ingested")
              : null;

    const formattedTimestamp = latestTimestamp
      ? formatDateTime(latestTimestamp, locale, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : null;

    const lines = [object.label];
    if (object.description) {
      lines.push(object.description);
    }
    if (object.kind === "event" && object.severity) {
      lines.push(
        `${t("dashboard.charts.warMap.tooltip.severity")}: ${t(`dashboard.charts.warMap.stats.${object.severity}`, {
          defaultValue: object.severity,
        })}`,
      );
    }
    if (object.kind === "event") {
      lines.push(
        `${t("dashboard.charts.warMap.tooltip.alerts")}: ${object.alertCount ?? 0}`,
      );
      lines.push(
        `${t("dashboard.charts.warMap.stats.news")}: ${object.newsCount ?? 0}`,
      );
    }
    if (object.kind === "news" && object.locationLabel) {
      lines.push(
        `${t("dashboard.charts.warMap.tooltip.location")}: ${object.locationLabel}`,
      );
    }
    if (object.kind === "layer" && object.layerId === "ais") {
      if (object.aisFeatureKind === "vessel") {
        if (object.mmsi) {
          lines.push(`MMSI: ${object.mmsi}`);
        }
        if (object.shipTypeLabelZh || object.shipTypeLabel) {
          lines.push(
            `${t("dashboard.charts.warMap.tooltip.shipType")}: ${object.shipTypeLabelZh ?? object.shipTypeLabel}`,
          );
        } else if (typeof object.shipType === "number") {
          lines.push(
            `${t("dashboard.charts.warMap.tooltip.shipType")}: ${formatAisShipTypeLabel(object.shipType)}`,
          );
        }
        if (object.vesselRoleZh || object.vesselRole) {
          lines.push(
            `${t("dashboard.charts.warMap.tooltip.type")}: ${object.vesselRoleZh ?? object.vesselRole}`,
          );
        }
        if (typeof object.heading === "number") {
          lines.push(
            `${t("dashboard.charts.warMap.tooltip.heading")}: ${Math.round(object.heading)}°`,
          );
        }
        if (typeof object.speed === "number") {
          lines.push(
            `${t("dashboard.charts.warMap.tooltip.speed")}: ${Math.round(object.speed)} kn`,
          );
        }
        if (typeof object.course === "number") {
          lines.push(
            `${t("dashboard.charts.warMap.tooltip.course")}: ${Math.round(object.course)}°`,
          );
        }
      } else if (object.aisFeatureKind === "density") {
        lines.push(
          object.description ??
            t("dashboard.charts.warMap.stats.aisDensityAggregateHint"),
        );
        if (typeof object.intensity === "number") {
          lines.push(
            `${t("dashboard.charts.warMap.tooltip.intensity")}: ${object.intensity.toFixed(2)}`,
          );
        }
        if (typeof object.deltaPct === "number") {
          lines.push(
            `${t("dashboard.charts.warMap.tooltip.change")}: ${object.deltaPct > 0 ? "+" : ""}${Math.round(object.deltaPct)}%`,
          );
        }
        if (typeof object.shipsPerDay === "number") {
          lines.push(
            `${t("dashboard.charts.warMap.tooltip.shipsPerDay")}: ${Math.round(object.shipsPerDay)}`,
          );
        }
      } else if (object.aisFeatureKind === "disruption") {
        lines.push(
          object.description ??
            t("dashboard.charts.warMap.stats.aisDisruptionAggregateHint"),
        );
        if (object.disruptionType) {
          lines.push(
            `${t("dashboard.charts.warMap.tooltip.type")}: ${object.disruptionType}`,
          );
        }
        if (object.severity) {
          lines.push(
            `${t("dashboard.charts.warMap.tooltip.severity")}: ${t(`dashboard.charts.warMap.stats.${object.severity}`, {
              defaultValue: object.severity,
            })}`,
          );
        }
        if (typeof object.vesselCount === "number") {
          lines.push(
            `${t("dashboard.charts.warMap.tooltip.vessels")}: ${object.vesselCount}`,
          );
        }
        if (typeof object.changePct === "number") {
          lines.push(
            `${t("dashboard.charts.warMap.tooltip.change")}: ${object.changePct > 0 ? "+" : ""}${Math.round(object.changePct)}%`,
          );
        }
        if (typeof object.darkShips === "number") {
          lines.push(
            `${t("dashboard.charts.warMap.tooltip.darkShips")}: ${object.darkShips}`,
          );
        }
        if (typeof object.windowHours === "number") {
          lines.push(
            `${t("dashboard.charts.warMap.tooltip.window")}: ${object.windowHours}h`,
          );
        }
        if (object.region) {
          lines.push(
            `${t("dashboard.charts.warMap.tooltip.region")}: ${object.region}`,
          );
        }
      }
    }
    if (object.kind === "layer" && object.layerId === "flights") {
      if (object.icao24) {
        lines.push(`ICAO24: ${object.icao24.toUpperCase()}`);
      }
      if (object.displayCategoryZh || object.displayCategory) {
        lines.push(
          `${t("dashboard.charts.warMap.tooltip.type")}: ${object.displayCategoryZh ?? object.displayCategory}`,
        );
      }
      if (object.roleZh || object.role) {
        lines.push(
          `${t("dashboard.charts.warMap.tooltip.role")}: ${object.roleZh ?? object.role}`,
        );
      }
      if (object.registration) {
        lines.push(
          `${t("dashboard.charts.warMap.tooltip.registration")}: ${object.registration}`,
        );
      }
      if (object.aircraftType) {
        lines.push(
          `${t("dashboard.charts.warMap.tooltip.aircraftType")}: ${object.aircraftType}`,
        );
      }
      if (object.countryCode || object.countryName) {
        lines.push(
          `${t("dashboard.charts.warMap.tooltip.country")}: ${object.countryName ? `${object.countryName}${object.countryCode ? ` (${object.countryCode})` : ""}` : object.countryCode}`,
        );
      }
      if (typeof object.heading === "number") {
        lines.push(
          `${t("dashboard.charts.warMap.tooltip.heading")}: ${Math.round(object.heading)}°`,
        );
      }
      if (typeof object.altitudeFt === "number") {
        lines.push(
          `${t("dashboard.charts.warMap.tooltip.altitude")}: ${Math.round(object.altitudeFt)} ft`,
        );
      }
      if (typeof object.groundSpeedKt === "number") {
        lines.push(
          `${t("dashboard.charts.warMap.tooltip.speed")}: ${Math.round(object.groundSpeedKt)} kt`,
        );
      }
    }
    if (formattedTimestamp && latestLabel) {
      lines.push(`${latestLabel}: ${formattedTimestamp}`);
    }
    if (
      object.kind === "layer" &&
      (object.layerId === "flights" || object.layerId === "ais") &&
      object.sourceUpdatedAt
    ) {
      lines.push(
        `${t("dashboard.charts.warMap.tooltip.updated")}: ${formatDateTime(object.sourceUpdatedAt, locale, {
          dateStyle: "medium",
          timeStyle: "short",
        })}`,
      );
    }
    if (object.kind === "news") {
      lines.push(
        t("dashboard.charts.warMap.tooltip.clickInspect"),
      );
    }
    return { text: lines.join("\n") };
  };
}

/** 构造 Deck cursor getter：拖拽 grabbing、hover 点位 pointer、其余 grab。 */
export function createWarMapCursorGetter(hoveredInteractionKey: string | null) {
  return ({ isDragging }: { isDragging?: boolean }) => {
    if (isDragging) {
      return "grabbing";
    }
    return hoveredInteractionKey ? "pointer" : "grab";
  };
}
