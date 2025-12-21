import { Injectable } from "@nestjs/common";
import { AlertMetricProvider, AlertRule } from "@prisma/client";
import os from "node:os";

import { MetricEvaluation, MetricProvider } from "./metric-provider";

type MetricFetcher = () => MetricEvaluation;

@Injectable()
export class SystemMetricProvider implements MetricProvider {
  readonly type = AlertMetricProvider.system_metric;

  private readonly metricFetchers: Record<string, MetricFetcher> = {
    "system.memory.usage_pct": () => {
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
    "system.load.1m": () => {
      const [load1] = os.loadavg();
      return { latest: load1, previous: null, changePercent: null, context: { load1 } };
    },
    "system.uptime.seconds": () => {
      const uptime = os.uptime();
      return { latest: uptime, previous: null, changePercent: null, context: { uptime } };
    }
  };

  supports(rule: Pick<AlertRule, "metricProvider">) {
    return rule.metricProvider === this.type;
  }

  async fetch(
    rule: Pick<AlertRule, "metricSlug" | "operator" | "changeWindowMin" | "metadata" | "metricProvider" | "orgId">
  ): Promise<MetricEvaluation> {
    const directValue =
      typeof rule.metadata?.currentValue === "number" ? rule.metadata.currentValue : undefined;
    if (directValue !== undefined) {
      return { latest: directValue, previous: null, changePercent: null, context: { source: "metadata" } };
    }

    const fetcher = this.metricFetchers[rule.metricSlug];
    if (!fetcher) {
      return { latest: null, previous: null, changePercent: null, context: { error: "unknown system metric" } };
    }
    return fetcher();
  }
}
