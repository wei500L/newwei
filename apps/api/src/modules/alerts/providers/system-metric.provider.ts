import {
  CUSTOM_MANUAL_SYSTEM_METRIC_SLUG,
  SYSTEM_LOAD_1M_METRIC_SLUG,
  SYSTEM_MEMORY_USAGE_METRIC_SLUG,
  SYSTEM_UPTIME_SECONDS_METRIC_SLUG,
} from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { AlertMetricProvider, AlertRule } from "@prisma/client";
import os from "node:os";

import { CacheService } from "../../cache/cache.service";
import {
  SITUATION_MONITOR_OREF_ACTIVE_ALERTS_METRIC_SLUG,
  SITUATION_MONITOR_OREF_HISTORY_24H_METRIC_SLUG,
  SITUATION_MONITOR_OREF_METRICS_CACHE_KEY,
} from "../../situation-monitor/signal-metrics.constants";

import { MetricEvaluation, MetricProvider } from "./metric-provider";

interface OrefMetricsSnapshot {
  activeAlerts?: number;
  historyCount24h?: number;
  updatedAt?: string;
}

type MetricFetcher = () => MetricEvaluation | Promise<MetricEvaluation>;

@Injectable()
export class SystemMetricProvider implements MetricProvider {
  readonly type = AlertMetricProvider.system_metric;

  constructor(private readonly cache: CacheService) {}

  private readonly metricFetchers: Record<string, MetricFetcher> = {
    [SYSTEM_MEMORY_USAGE_METRIC_SLUG]: () => {
      const total = os.totalmem();
      const free = os.freemem();
      const used = total - free;
      const usagePct = total ? (used / total) * 100 : 0;
      return {
        latest: usagePct,
        previous: null,
        changePercent: null,
        context: { totalBytes: total, usedBytes: used, freeBytes: free }
      };
    },
    [SYSTEM_LOAD_1M_METRIC_SLUG]: () => {
      const load1 = os.loadavg()[0] ?? 0;
      return { latest: load1, previous: null, changePercent: null, context: { load1 } };
    },
    [SYSTEM_UPTIME_SECONDS_METRIC_SLUG]: () => {
      const uptime = os.uptime();
      return { latest: uptime, previous: null, changePercent: null, context: { uptime } };
    },
    [SITUATION_MONITOR_OREF_ACTIVE_ALERTS_METRIC_SLUG]: async () =>
      this.readOrefMetricSnapshot("activeAlerts"),
    [SITUATION_MONITOR_OREF_HISTORY_24H_METRIC_SLUG]: async () =>
      this.readOrefMetricSnapshot("historyCount24h"),
  };

  supports(rule: Pick<AlertRule, "metricProvider">) {
    return rule.metricProvider === this.type;
  }

  async fetch(
    rule: Pick<AlertRule, "metricSlug" | "operator" | "changeWindowMin" | "metadata" | "metricProvider" | "orgId">
  ): Promise<MetricEvaluation> {
    const metricSlug =
      typeof rule.metricSlug === "string" ? rule.metricSlug.trim() : "";
    const metadata =
      rule.metadata && typeof rule.metadata === "object" && !Array.isArray(rule.metadata)
        ? (rule.metadata as Record<string, unknown>)
        : null;
    const directValue =
      typeof metadata?.currentValue === "number" &&
      Number.isFinite(metadata.currentValue)
        ? metadata.currentValue
        : undefined;
    if (directValue !== undefined) {
      return { latest: directValue, previous: null, changePercent: null, context: { source: "metadata" } };
    }
    if (metricSlug === CUSTOM_MANUAL_SYSTEM_METRIC_SLUG) {
      return {
        latest: null,
        previous: null,
        changePercent: null,
        context: { error: "custom_manual_requires_current_value" },
      };
    }

    const fetcher = this.metricFetchers[metricSlug];
    if (!fetcher) {
      return { latest: null, previous: null, changePercent: null, context: { error: "unknown system metric" } };
    }

    return await fetcher();
  }

  private async readOrefMetricSnapshot(
    key: "activeAlerts" | "historyCount24h",
  ): Promise<MetricEvaluation> {
    const snapshot = await this.cache.get<OrefMetricsSnapshot>(
      SITUATION_MONITOR_OREF_METRICS_CACHE_KEY,
    );
    if (!snapshot) {
      return {
        latest: null,
        previous: null,
        changePercent: null,
        context: { error: "metrics_unavailable" },
      };
    }

    const value = Number(snapshot[key]);
    return {
      latest: Number.isFinite(value) ? value : null,
      previous: null,
      changePercent: null,
      context: {
        source: "situation-monitor-signals",
        updatedAt:
          typeof snapshot.updatedAt === "string" ? snapshot.updatedAt : undefined,
      },
    };
  }
}
