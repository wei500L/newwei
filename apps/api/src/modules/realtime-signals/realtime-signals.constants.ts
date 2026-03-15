import { AlertOperator, AlertSeverity } from "@prisma/client";

import type { RealtimeSignalSource } from "./realtime-signals.types";

export const REALTIME_SIGNAL_METRIC_SLUGS = {
  adsb: "realtime.adsb.military_flights",
  adsbSnapshotHealth: "realtime.adsb.snapshot_health",
  ais: "realtime.ais.disruptions",
  unrest: "realtime.unrest.events",
  outages: "realtime.outages.internet",
  keywordSpike: "realtime.keyword_spike.count",
  pizzint: "realtime.pizzint.defcon",
  gdeltTension: "realtime.gdelt_tension.max_score",
  polymarketLeads: "realtime.polymarket_leads.count",
} as const;

export type RealtimeSignalMetricSlug =
  (typeof REALTIME_SIGNAL_METRIC_SLUGS)[keyof typeof REALTIME_SIGNAL_METRIC_SLUGS];

const REALTIME_SIGNAL_METRIC_SLUG_ALIASES: Readonly<
  Record<string, RealtimeSignalMetricSlug>
> = {
  "realtime.opensky.military_flights": REALTIME_SIGNAL_METRIC_SLUGS.adsb,
};

export function normalizeRealtimeSignalMetricSlug(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return REALTIME_SIGNAL_METRIC_SLUG_ALIASES[trimmed] ?? trimmed;
}

export const REALTIME_SIGNAL_SOURCES: RealtimeSignalSource[] = [
  "adsb",
  "ais",
  "unrest",
  "outages",
  "keyword_spike",
  "pizzint",
  "gdelt_tension",
  "polymarket_leads",
];

export interface RealtimeSignalDefaultRuleDefinition {
  key:
    | "adsb"
    | "adsb_snapshot_health"
    | "ais"
    | "unrest"
    | "outages"
    | "keyword_spike"
    | "pizzint"
    | "gdelt_tension"
    | "polymarket_leads";
  name: string;
  description: string;
  metricSlug: RealtimeSignalMetricSlug;
  operator: AlertOperator;
  thresholdValue: number;
  severity: AlertSeverity;
}

export const REALTIME_SIGNAL_DEFAULT_RULES: RealtimeSignalDefaultRuleDefinition[] =
  [
    {
      key: "adsb",
      name: "Realtime Signal: Military Flight Activity Surge",
      description:
        "Alert when detected military flight count exceeds baseline threshold.",
      metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.adsb,
      operator: AlertOperator.gte,
      thresholdValue: 50,
      severity: AlertSeverity.medium,
    },
    {
      key: "adsb_snapshot_health",
      name: "Realtime Signal: ADS-B Snapshot Degraded",
      description:
        "Alert when the ADS-B snapshot is stale or the map is temporarily using the previous retained snapshot.",
      metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.adsbSnapshotHealth,
      operator: AlertOperator.gte,
      thresholdValue: 1,
      severity: AlertSeverity.high,
    },
    {
      key: "ais",
      name: "Realtime Signal: Maritime Disruptions Elevated",
      description: "Alert when AIS disruptions count crosses the threshold.",
      metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.ais,
      operator: AlertOperator.gte,
      thresholdValue: 5,
      severity: AlertSeverity.medium,
    },
    {
      key: "unrest",
      name: "Realtime Signal: Unrest Event Spike",
      description:
        "Alert when protest/unrest events rise above the configured threshold.",
      metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.unrest,
      operator: AlertOperator.gte,
      thresholdValue: 20,
      severity: AlertSeverity.medium,
    },
    {
      key: "outages",
      name: "Realtime Signal: Internet Outages Detected",
      description: "Alert when internet outage annotations increase materially.",
      metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.outages,
      operator: AlertOperator.gte,
      thresholdValue: 3,
      severity: AlertSeverity.high,
    },
    {
      key: "keyword_spike",
      name: "Realtime Signal: Keyword Spike",
      description:
        "Alert when cross-source keyword spikes are detected in near realtime.",
      metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.keywordSpike,
      operator: AlertOperator.gte,
      thresholdValue: 1,
      severity: AlertSeverity.medium,
    },
    {
      key: "pizzint",
      name: "Realtime Signal: PizzINT DEFCON Escalation",
      description: "Alert when PizzINT DEFCON reaches elevated levels.",
      metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.pizzint,
      operator: AlertOperator.lte,
      thresholdValue: 2,
      severity: AlertSeverity.high,
    },
    {
      key: "gdelt_tension",
      name: "Realtime Signal: GDELT Tension Escalation",
      description:
        "Alert when bilateral tension score exceeds the configured threshold.",
      metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.gdeltTension,
      operator: AlertOperator.gte,
      thresholdValue: 70,
      severity: AlertSeverity.high,
    },
    {
      key: "polymarket_leads",
      name: "Realtime Signal: Prediction Leads News",
      description:
        "Alert when prediction market movement leads low-coverage news topics.",
      metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.polymarketLeads,
      operator: AlertOperator.gte,
      thresholdValue: 1,
      severity: AlertSeverity.medium,
    },
  ];

export const REALTIME_SIGNALS_SERIES_TTL_SECONDS = 60 * 60 * 24 * 2;
export const REALTIME_SIGNALS_SERIES_MAX_POINTS = 2_000;
export const REALTIME_SIGNALS_INGEST_LOCK_TTL_MS = 5 * 60 * 1_000;
