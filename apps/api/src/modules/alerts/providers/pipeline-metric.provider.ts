import { Injectable } from "@nestjs/common";
import { AlertMetricProvider, AlertRule, PipelineJobStatus, Prisma } from "@prisma/client";

import { PrismaService } from "../../config/prisma.service";

import { MetricEvaluation, MetricProvider } from "./metric-provider";

@Injectable()
export class PipelineMetricProvider implements MetricProvider {
  readonly type = AlertMetricProvider.pipeline_job;

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

    const allowedStatuses = Object.values(PipelineJobStatus);
    const requestedStatuses = Array.isArray(rule.metadata?.statuses)
      ? rule.metadata.statuses
      : rule.metadata?.status
        ? [rule.metadata.status]
        : undefined;
    const statuses =
      (requestedStatuses?.filter((status): status is PipelineJobStatus =>
        allowedStatuses.includes(status as PipelineJobStatus)
      ) ?? [PipelineJobStatus.failed]);

    const queueName = typeof rule.metadata?.queueName === "string" ? rule.metadata.queueName : undefined;
    const sourceId = typeof rule.metadata?.sourceId === "string" ? rule.metadata.sourceId : undefined;

    const baseWhere: Prisma.PipelineJobWhereInput = {
      orgId: rule.orgId,
      status: { in: statuses },
      ...(queueName ? { queueName } : {}),
      ...(sourceId ? { sourceId } : {})
    };

    const [latest, previous] = await Promise.all([
      this.prisma.pipelineJob.count({
        where: {
          ...baseWhere,
          createdAt: { gte: windowStart }
        }
      }),
      this.prisma.pipelineJob.count({
        where: {
          ...baseWhere,
          createdAt: { gte: previousWindowStart, lt: windowStart }
        }
      })
    ]);

    const changePercent = previous ? ((latest - previous) / previous) * 100 : null;

    return {
      latest,
      previous,
      changePercent,
      context: { windowMinutes, statuses, queueName, sourceId }
    };
  }
}
