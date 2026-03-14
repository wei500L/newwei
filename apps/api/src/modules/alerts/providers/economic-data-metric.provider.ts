import { Injectable } from "@nestjs/common";
import { AlertMetricProvider, AlertOperator, AlertRule, Prisma } from "@prisma/client";

import { PrismaService } from "../../config/prisma.service";

import { MetricEvaluation, MetricProvider } from "./metric-provider";

@Injectable()
export class EconomicDataMetricProvider implements MetricProvider {
  readonly type = AlertMetricProvider.economic_data;

  constructor(private readonly prisma: PrismaService) {}

  supports(rule: { metricProvider: AlertMetricProvider }) {
    return rule.metricProvider === this.type;
  }

  async fetch(
    rule: Pick<AlertRule, "metricSlug" | "operator" | "changeWindowMin" | "metricProvider" | "metadata" | "orgId">
  ): Promise<MetricEvaluation> {
    const metricSlug =
      typeof rule.metricSlug === "string" ? rule.metricSlug.trim() : "";
    const metadata =
      rule.metadata && typeof rule.metadata === "object" && !Array.isArray(rule.metadata)
        ? (rule.metadata as Record<string, unknown>)
        : null;
    const desiredSourceField =
      typeof metadata?.sourceField === "string" ? metadata.sourceField.trim() : "";
    if (!metricSlug) {
      return {
        latest: null,
        previous: null,
        changePercent: null,
        context: { error: "metric_slug_missing" }
      };
    }
    const take = rule.operator === AlertOperator.change_up_pct || rule.operator === AlertOperator.change_down_pct ? 2 : 1;
    const where: Prisma.EconomicDataPointWhereInput = {
      item: { slug: metricSlug },
      ...(desiredSourceField ? { sourceField: desiredSourceField } : {})
    };
    if (rule.changeWindowMin) {
      const windowStart = new Date(Date.now() - rule.changeWindowMin * 60 * 1000);
      where.recordedAt = { gte: windowStart };
    }
    const points = await this.prisma.economicDataPoint.findMany({
      where,
      orderBy: { recordedAt: "desc" },
      take,
      include: { item: true }
    });
    if (!points.length) {
      return { latest: null, previous: null, changePercent: null };
    }
    const latestPoint = points[0];
    if (!latestPoint) {
      return { latest: null, previous: null, changePercent: null };
    }
    const previousPoint = points[1] ?? null;
    const latest = Number(latestPoint.value);
    const previous = previousPoint ? Number(previousPoint.value) : null;
    const changePercent = previous ? ((latest - previous) / previous) * 100 : null;
    const item = latestPoint.item;
    const unit = latestPoint.unit ?? item.defaultUnit ?? null;
    const sourceName = item.sourceEndpoint || item.sourceFunction;
    return {
      latest,
      previous,
      changePercent,
      context: {
        windowMinutes: rule.changeWindowMin ?? null,
        sourceName,
        sourceField: latestPoint.sourceField,
        sourceDocUrl: item.sourceDocUrl ?? null,
        unit,
        recordedAt: latestPoint.recordedAt.toISOString(),
        itemName: item.displayName
      }
    };
  }
}
