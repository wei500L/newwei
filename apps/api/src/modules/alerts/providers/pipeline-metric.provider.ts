import { LlmRequestLogModel } from "@modular/mongo";
import { Injectable } from "@nestjs/common";
import { AlertMetricProvider, AlertRule, MongoOutboxStatus, MongoOutboxType, PipelineJobStatus, Prisma } from "@prisma/client";

import { PrismaService } from "../../config/prisma.service";
import { setPipelineMetric } from "../../observability/prometheus-metrics";

import { MetricEvaluation, MetricProvider } from "./metric-provider";

const PIPELINE_RATE_METRICS = new Set([
  "pipeline.success_rate",
  "pipeline.failure_rate",
]);

const PIPELINE_LATENCY_METRICS = new Set([
  "pipeline.average_llm_latency_ms",
  "pipeline.ingestion_p90_ms",
  "pipeline.ingestion_p99_ms",
]);

function quantile(values: number[], percentile: number): number | null {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) {
    return null;
  }
  const index = Math.ceil((percentile / 100) * finite.length) - 1;
  return finite[Math.max(0, Math.min(finite.length - 1, index))] ?? null;
}

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
    const metricSlug =
      typeof rule.metricSlug === "string" ? rule.metricSlug.trim() : "";
    if (!metricSlug) {
      return {
        latest: null,
        previous: null,
        changePercent: null,
        context: { error: "metric_slug_missing" }
      };
    }
    if (metricSlug.startsWith("mongo_outbox.")) {
      return this.fetchMongoOutboxMetric({ ...rule, metricSlug });
    }
    if (PIPELINE_RATE_METRICS.has(metricSlug)) {
      return this.fetchPipelineRateMetric({ ...rule, metricSlug });
    }
    if (PIPELINE_LATENCY_METRICS.has(metricSlug)) {
      return this.fetchPipelineLatencyMetric({ ...rule, metricSlug });
    }

    const windowMinutes = rule.changeWindowMin ?? 60;
    const windowMs = windowMinutes * 60 * 1000;
    const now = Date.now();
    const windowStart = new Date(now - windowMs);
    const previousWindowStart = new Date(now - 2 * windowMs);

    const allowedStatuses = Object.values(PipelineJobStatus);
    const metadata =
      rule.metadata && typeof rule.metadata === "object" && !Array.isArray(rule.metadata)
        ? (rule.metadata as Record<string, unknown>)
        : null;
    const requestedStatuses = Array.isArray(metadata?.statuses)
      ? metadata.statuses.filter((status): status is string => typeof status === "string")
      : typeof metadata?.status === "string"
        ? [metadata.status]
        : undefined;
    const statuses =
      (requestedStatuses?.filter((status): status is PipelineJobStatus =>
        allowedStatuses.includes(status as PipelineJobStatus)
      ) ?? [PipelineJobStatus.failed]);

    const queueName = typeof metadata?.queueName === "string" ? metadata.queueName : undefined;
    const sourceId = typeof metadata?.sourceId === "string" ? metadata.sourceId : undefined;

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

    const changePercent =
      previous !== null && Number.isFinite(previous) && previous !== 0
        ? ((latest - previous) / previous) * 100
        : null;

    return {
      latest,
      previous,
      changePercent,
      context: { windowMinutes, statuses, queueName, sourceId }
    };
  }

  private async fetchPipelineRateMetric(
    rule: Pick<AlertRule, "metricSlug" | "changeWindowMin" | "metadata" | "orgId">,
  ): Promise<MetricEvaluation> {
    const windowMinutes = rule.changeWindowMin ?? 60;
    const windowStart = new Date(Date.now() - windowMinutes * 60_000);
    const metadata =
      rule.metadata && typeof rule.metadata === "object" && !Array.isArray(rule.metadata)
        ? (rule.metadata as Record<string, unknown>)
        : null;
    const queueName = typeof metadata?.queueName === "string" ? metadata.queueName : undefined;
    const sourceId = typeof metadata?.sourceId === "string" ? metadata.sourceId : undefined;
    const where: Prisma.PipelineJobWhereInput = {
      orgId: rule.orgId,
      createdAt: { gte: windowStart },
      ...(queueName ? { queueName } : {}),
      ...(sourceId ? { sourceId } : {}),
    };

    const [total, completed, failed] = await Promise.all([
      this.prisma.pipelineJob.count({ where }),
      this.prisma.pipelineJob.count({
        where: { ...where, status: PipelineJobStatus.completed },
      }),
      this.prisma.pipelineJob.count({
        where: { ...where, status: PipelineJobStatus.failed },
      }),
    ]);
    const latest =
      total > 0
        ? rule.metricSlug === "pipeline.success_rate"
          ? completed / total
          : failed / total
        : 0;
    setPipelineMetric(rule.orgId, rule.metricSlug, latest);
    return {
      latest,
      previous: null,
      changePercent: null,
      context: { windowMinutes, total, completed, failed, queueName, sourceId },
    };
  }

  private async fetchPipelineLatencyMetric(
    rule: Pick<AlertRule, "metricSlug" | "changeWindowMin" | "metadata" | "orgId">,
  ): Promise<MetricEvaluation> {
    const windowMinutes = rule.changeWindowMin ?? 60;
    const windowStart = new Date(Date.now() - windowMinutes * 60_000);
    if (rule.metricSlug === "pipeline.average_llm_latency_ms") {
      const rows = (await LlmRequestLogModel.find(
        {
          orgId: rule.orgId,
          createdAt: { $gte: windowStart },
          latencyMs: { $type: "number" },
        },
        { latencyMs: 1 },
      )
        .sort({ createdAt: -1 })
        .limit(5000)
        .lean()) as { latencyMs?: unknown }[];
      const values = rows
        .map((row) => Number(row.latencyMs))
        .filter((value) => Number.isFinite(value) && value >= 0);
      const latest =
        values.length > 0
          ? values.reduce((sum, value) => sum + value, 0) / values.length
          : 0;
      setPipelineMetric(rule.orgId, rule.metricSlug, latest);
      return {
        latest,
        previous: null,
        changePercent: null,
        context: { windowMinutes, sampleSize: values.length },
      };
    }

    const rows = await this.prisma.pipelineJob.findMany({
      where: {
        orgId: rule.orgId,
        status: PipelineJobStatus.completed,
        createdAt: { gte: windowStart },
        startedAt: { not: null },
        completedAt: { not: null },
      },
      select: { startedAt: true, completedAt: true },
      orderBy: { completedAt: "desc" },
      take: 5000,
    });
    const values = rows
      .map((row) =>
        row.startedAt && row.completedAt
          ? row.completedAt.getTime() - row.startedAt.getTime()
          : Number.NaN,
      )
      .filter((value) => Number.isFinite(value) && value >= 0);
    const percentile = rule.metricSlug === "pipeline.ingestion_p99_ms" ? 99 : 90;
    const latest = quantile(values, percentile) ?? 0;
    setPipelineMetric(rule.orgId, rule.metricSlug, latest);
    return {
      latest,
      previous: null,
      changePercent: null,
      context: { windowMinutes, sampleSize: values.length, percentile },
    };
  }

  private async fetchMongoOutboxMetric(
    rule: Pick<AlertRule, "metricSlug" | "metadata" | "orgId">
  ): Promise<MetricEvaluation> {
    const now = new Date();
    const staleLockCutoff = new Date(now.getTime() - this.outboxStaleLockMs);
    const activeOutboxStatuses = [
      MongoOutboxStatus.pending,
      MongoOutboxStatus.failed,
      MongoOutboxStatus.processing,
    ];
    const allowedStatuses = Object.values(MongoOutboxStatus);
    const metadata =
      rule.metadata && typeof rule.metadata === "object" && !Array.isArray(rule.metadata)
        ? (rule.metadata as Record<string, unknown>)
        : null;
    const requestedStatuses = Array.isArray(metadata?.statuses)
      ? metadata.statuses.filter((status): status is string => typeof status === "string")
      : typeof metadata?.status === "string"
        ? [metadata.status]
        : undefined;
    const allowedTypes = Object.values(MongoOutboxType);
    const requestedType =
      typeof metadata?.type === "string" ? metadata.type.trim() : undefined;
    const outboxType = allowedTypes.includes(requestedType as MongoOutboxType)
      ? (requestedType as MongoOutboxType)
      : MongoOutboxType.processed_item;

    const baseWhere: Prisma.MongoOutboxWhereInput = {
      orgId: rule.orgId,
      type: outboxType
    };

    const slug = rule.metricSlug.trim();
    if (slug === "mongo_outbox.oldest_age_minutes") {
      const oldest = await this.prisma.mongoOutbox.findFirst({
        where: {
          ...baseWhere,
          status: { in: activeOutboxStatuses }
        },
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
      "mongo_outbox.backlog": activeOutboxStatuses,
      "mongo_outbox.pending": [MongoOutboxStatus.pending],
      "mongo_outbox.failed": [MongoOutboxStatus.failed],
      "mongo_outbox.processing": [MongoOutboxStatus.processing],
      "mongo_outbox.dead": [MongoOutboxStatus.dead],
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
