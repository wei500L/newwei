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
    const take = rule.operator === AlertOperator.change_up_pct || rule.operator === AlertOperator.change_down_pct ? 2 : 1;
    const where: Prisma.EconomicDataPointWhereInput = {
      item: { slug: rule.metricSlug }
    };
    if (rule.changeWindowMin) {
      const windowStart = new Date(Date.now() - rule.changeWindowMin * 60 * 1000);
      where.recordedAt = { gte: windowStart };
    }
    const points = await this.prisma.economicDataPoint.findMany({
      where,
      orderBy: { recordedAt: "desc" },
      take
    });
    if (!points.length) {
      return { latest: null, previous: null, changePercent: null };
    }
    const latest = Number(points[0].value);
    const previous = points.length > 1 ? Number(points[1].value) : null;
    const changePercent = previous ? ((latest - previous) / previous) * 100 : null;
    return { latest, previous, changePercent };
  }
}
