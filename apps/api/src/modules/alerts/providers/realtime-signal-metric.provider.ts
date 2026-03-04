import { Injectable } from "@nestjs/common";
import { AlertMetricProvider, AlertRule } from "@prisma/client";

import { normalizeRealtimeSignalMetricSlug } from "../../realtime-signals/realtime-signals.constants";
import { RealtimeSignalsService } from "../../realtime-signals/realtime-signals.service";

import { MetricEvaluation, MetricProvider } from "./metric-provider";

@Injectable()
export class RealtimeSignalMetricProvider implements MetricProvider {
  readonly type = AlertMetricProvider.realtime_signal;

  constructor(private readonly realtimeSignals: RealtimeSignalsService) {}

  supports(rule: Pick<AlertRule, "metricProvider">) {
    return rule.metricProvider === this.type;
  }

  async fetch(
    rule: Pick<
      AlertRule,
      "metricSlug" | "operator" | "changeWindowMin" | "metadata" | "metricProvider" | "orgId"
    >,
  ): Promise<MetricEvaluation> {
    const metricSlug = normalizeRealtimeSignalMetricSlug(rule.metricSlug);
    if (!metricSlug) {
      return {
        latest: null,
        previous: null,
        changePercent: null,
        context: { error: "metric_slug_missing" },
      };
    }
    const evaluation = await this.realtimeSignals.evaluateMetric(
      rule.orgId,
      metricSlug,
      rule.changeWindowMin ?? 60,
    );
    return {
      latest: evaluation.latest,
      previous: evaluation.previous,
      changePercent: evaluation.changePercent,
      context: evaluation.context,
    };
  }
}
