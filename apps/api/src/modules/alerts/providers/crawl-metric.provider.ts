import { Injectable } from "@nestjs/common";
import { AlertMetricProvider, AlertRule, CrawlTaskStatus, Prisma } from "@prisma/client";

import { PrismaService } from "../../config/prisma.service";

import { MetricEvaluation, MetricProvider } from "./metric-provider";

@Injectable()
export class CrawlMetricProvider implements MetricProvider {
  readonly type = AlertMetricProvider.crawl_task;

  constructor(private readonly prisma: PrismaService) {}

  supports(rule: Pick<AlertRule, "metricProvider">) {
    return rule.metricProvider === this.type;
  }

  async fetch(
    rule: Pick<AlertRule, "metricSlug" | "operator" | "changeWindowMin" | "metadata" | "metricProvider" | "orgId">
  ): Promise<MetricEvaluation> {
    const windowMinutes = rule.changeWindowMin ?? 60;
    const windowMs = windowMinutes * 60 * 1000;
    const now = Date.now();
    const windowStart = new Date(now - windowMs);
    const previousWindowStart = new Date(now - 2 * windowMs);

    const allowedStatuses = Object.values(CrawlTaskStatus);
    const requestedStatuses = Array.isArray(rule.metadata?.statuses)
      ? rule.metadata.statuses
      : rule.metadata?.status
        ? [rule.metadata.status]
        : undefined;
    const statuses =
      (requestedStatuses?.filter((status): status is CrawlTaskStatus =>
        allowedStatuses.includes(status as CrawlTaskStatus)
      ) ?? [CrawlTaskStatus.failed]);

    const createdById = typeof rule.metadata?.createdById === "string" ? rule.metadata.createdById : undefined;

    const baseWhere: Prisma.CrawlTaskWhereInput = {
      orgId: rule.orgId,
      status: { in: statuses },
      ...(createdById ? { createdById } : {})
    };

    const [latest, previous] = await Promise.all([
      this.prisma.crawlTask.count({
        where: {
          ...baseWhere,
          updatedAt: { gte: windowStart }
        }
      }),
      this.prisma.crawlTask.count({
        where: {
          ...baseWhere,
          updatedAt: { gte: previousWindowStart, lt: windowStart }
        }
      })
    ]);

    const changePercent = previous ? ((latest - previous) / previous) * 100 : null;

    return {
      latest,
      previous,
      changePercent,
      context: { windowMinutes, statuses, createdById }
    };
  }
}
