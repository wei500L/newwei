import type { AlertMetricProvider, AlertRule } from "@prisma/client";

export interface MetricEvaluation {
  latest: number | null;
  previous: number | null;
  changePercent: number | null;
  context?: Record<string, unknown>;
}

export interface MetricProvider {
  type: AlertMetricProvider;
  supports(rule: Pick<AlertRule, "metricProvider">): boolean;
  fetch(
    rule: Pick<AlertRule, "metricSlug" | "operator" | "changeWindowMin" | "metadata" | "metricProvider" | "orgId">
  ): Promise<MetricEvaluation>;
}
