import { Injectable } from "@nestjs/common";
import { AlertMetricProvider, AlertRule, MongoOutboxStatus, MongoOutboxType, PipelineJobStatus, Prisma } from "@prisma/client";

import { PrismaService } from "../../config/prisma.service";

import { MetricEvaluation, MetricProvider } from "./metric-provider";

@Injectable()
export class PipelineMetricProvider implements MetricProvider {
  readonly type = AlertMetricProvider.pipeline_job;
  private readonly outboxStaleLockMs = 5 * 60_000;

  constructor(private readonly prisma: PrismaService) {}

  supports(rule: Pick<AlertRule, "metricProvider">) {
    return rule.metricProvider === this.type;
  }

  async fetch(
    rule: Pick<AlertRule, "metricSlug" | "operator" | "changeWindowMin" | "metadata" | "metricProvider" | "orgId">
  ): Promise<MetricEvaluation> {
    if (rule.metricSlug.startsWith("mongo_outbox.")) {
      return this.fetchMongoOutboxMetric(rule);
    }

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

  private async fetchMongoOutboxMetric(
    rule: Pick<AlertRule, "metricSlug" | "metadata" | "orgId">
  ): Promise<MetricEvaluation> {
    const now = new Date();
    const staleLockCutoff = new Date(now.getTime() - this.outboxStaleLockMs);
    const allowedStatuses = Object.values(MongoOutboxStatus);
    const requestedStatuses = Array.isArray(rule.metadata?.statuses)
      ? rule.metadata.statuses
      : rule.metadata?.status
        ? [rule.metadata.status]
        : undefined;

    const baseWhere: Prisma.MongoOutboxWhereInput = {
      orgId: rule.orgId,
      type: MongoOutboxType.processed_item
    };

    const slug = rule.metricSlug.trim();
    if (slug === "mongo_outbox.oldest_age_minutes") {
      const oldest = await this.prisma.mongoOutbox.findFirst({
        where: baseWhere,
        orderBy: { createdAt: "asc" },
        select: { createdAt: true }
      });
      const latest = oldest?.createdAt
        ? Math.max(0, (now.getTime() - oldest.createdAt.getTime()) / 60_000)
        : null;
      return {
        latest: latest !== null ? Math.round(latest) : null,
        previous: null,
        changePercent: null,
        context: { type: baseWhere.type, oldestCreatedAt: oldest?.createdAt?.toISOString() ?? null }
      };
    }

    if (slug === "mongo_outbox.stale_processing") {
      const latest = await this.prisma.mongoOutbox.count({
        where: {
          ...baseWhere,
          status: MongoOutboxStatus.processing,
          lockedAt: { lt: staleLockCutoff }
        }
      });
      return { latest, previous: null, changePercent: null, context: { type: baseWhere.type, staleLockCutoff } };
    }

    const defaultStatusesBySlug: Record<string, MongoOutboxStatus[]> = {
      "mongo_outbox.backlog": [MongoOutboxStatus.pending, MongoOutboxStatus.failed, MongoOutboxStatus.processing],
      "mongo_outbox.pending": [MongoOutboxStatus.pending],
      "mongo_outbox.failed": [MongoOutboxStatus.failed],
      "mongo_outbox.processing": [MongoOutboxStatus.processing],
    };

    const fallbackStatuses = defaultStatusesBySlug[slug] ?? defaultStatusesBySlug["mongo_outbox.backlog"];
    const statuses =
      (requestedStatuses?.filter((status): status is MongoOutboxStatus =>
        allowedStatuses.includes(status as MongoOutboxStatus)
      ) ?? fallbackStatuses);

    const where: Prisma.MongoOutboxWhereInput = {
      ...baseWhere,
      status: { in: statuses }
    };

    if (slug === "mongo_outbox.pending") {
      where.availableAt = { lte: now };
    }

    const latest = await this.prisma.mongoOutbox.count({ where });
    return { latest, previous: null, changePercent: null, context: { type: baseWhere.type, statuses } };
  }
}
