import { ProcessedItemModel, TaskLogModel } from "@modular/mongo";
import { Injectable } from "@nestjs/common";
import {
  MongoOutboxStatus,
  MongoOutboxType,
  ObservabilitySnapshotScope,
} from "@prisma/client";

import { PrismaService } from "../config/prisma.service";
import { ITEM_PIPELINE_QUEUE_NAME } from "../queue/queue.constants";

import { ObservabilitySnapshotService } from "./observability-snapshot.service";

export interface PipelineQualitySummary {
  windowMinutes: number;
  totals: {
    total: number;
    completed: number;
    failed: number;
    processing: number;
    pending: number;
  };
  successRate: number | null;
  averageLatencyMs: number | null;
  ingestionLatencyMs?: {
    sampleSize: number;
    averageMs: number | null;
    p50Ms: number | null;
    p90Ms: number | null;
    p99Ms: number | null;
    maxMs: number | null;
  };
  failureTypes: {
    stage: string;
    errorName: string;
    count: number;
  }[];
  llmModels?: {
    model: string;
    count: number;
    avgLatencyMs: number | null;
    avgCostUsd: number | null;
    avgTotalTokens: number | null;
  }[];
  outbox?: {
    totals: {
      total: number;
      pending: number;
      processing: number;
      failed: number;
      dead: number;
      staleProcessing: number;
    };
    oldestCreatedAt: string | null;
    oldestAgeMinutes: number | null;
  };
}

@Injectable()
export class PipelineQualityService {
  private readonly outboxStaleLockMs = 5 * 60_000;
  private readonly maxLatencySamples = 5_000;
  private readonly summaryTtlSeconds = 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshots: ObservabilitySnapshotService,
  ) {}

  private percentile(sorted: number[], pct: number): number | null {
    if (sorted.length === 0) {
      return null;
    }
    const clamped = Math.min(1, Math.max(0, pct));
    const index = Math.floor(clamped * (sorted.length - 1));
    const value = sorted[index];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  private async computeIngestionLatency(orgId: string, since: Date) {
    const records = await ProcessedItemModel.find(
      {
        orgId,
        createdAt: { $gte: since },
        status: "completed",
        ingestedAt: { $type: "date" },
      },
      { createdAt: 1, ingestedAt: 1 },
    )
      .sort({ createdAt: -1 })
      .limit(this.maxLatencySamples)
      .lean();

    const latencies = records
      .map((record) => {
        const createdAt = (record as { createdAt?: Date }).createdAt;
        const ingestedAt = (record as { ingestedAt?: Date }).ingestedAt;
        if (!createdAt || !ingestedAt) {
          return null;
        }
        const latency = createdAt.getTime() - ingestedAt.getTime();
        return Number.isFinite(latency) && latency >= 0 ? latency : null;
      })
      .filter((latency): latency is number => latency !== null);

    if (latencies.length === 0) {
      return {
        sampleSize: 0,
        averageMs: null,
        p50Ms: null,
        p90Ms: null,
        p99Ms: null,
        maxMs: null,
      };
    }

    latencies.sort((a, b) => a - b);
    const sum = latencies.reduce((acc, value) => acc + value, 0);
    const averageMs = Math.round(sum / latencies.length);
    const maxMs = latencies[latencies.length - 1] ?? null;

    return {
      sampleSize: latencies.length,
      averageMs,
      p50Ms: this.percentile(latencies, 0.5),
      p90Ms: this.percentile(latencies, 0.9),
      p99Ms: this.percentile(latencies, 0.99),
      maxMs,
    };
  }

  async summary(
    orgId: string,
    windowMinutes = 60,
  ): Promise<PipelineQualitySummary> {
    const normalizedWindow = Math.max(
      5,
      Math.min(60 * 24 * 14, Math.floor(windowMinutes)),
    );
    const snapshot = await this.snapshots.getOrCreate<PipelineQualitySummary>({
      orgId,
      scope: ObservabilitySnapshotScope.quality_pipeline,
      variantKey: `windowMinutes:${normalizedWindow}`,
      ttlSeconds: this.summaryTtlSeconds,
      loader: async () => this.buildSummary(orgId, normalizedWindow),
    });
    return snapshot.payload;
  }

  private async buildSummary(
    orgId: string,
    normalizedWindow: number,
  ): Promise<PipelineQualitySummary> {
    const since = new Date(Date.now() - normalizedWindow * 60 * 1000);
    const now = new Date();
    const staleLockCutoff = new Date(now.getTime() - this.outboxStaleLockMs);
    const activeOutboxStatuses = [
      MongoOutboxStatus.pending,
      MongoOutboxStatus.failed,
      MongoOutboxStatus.processing,
    ];

    const [
      processedAggResult,
      failureAgg,
      outboxStatusAgg,
      outboxStaleProcessing,
      outboxOldest,
      ingestionLatency,
    ] = await Promise.all([
      ProcessedItemModel.aggregate([
        { $match: { orgId, createdAt: { $gte: since } } },
        {
          $facet: {
            statusAgg: [
              {
                $group: {
                  _id: "$status",
                  count: { $sum: 1 },
                },
              },
            ],
            latencyAgg: [
              {
                $match: {
                  status: "completed",
                  "llm.latencyMs": { $type: "number" },
                },
              },
              {
                $group: {
                  _id: null,
                  avgLatencyMs: { $avg: "$llm.latencyMs" },
                },
              },
            ],
            llmAgg: [
              {
                $match: {
                  status: "completed",
                },
              },
              {
                $project: {
                  model: { $ifNull: ["$llm.model", "unknown"] },
                  latencyMs: {
                    $cond: [
                      { $eq: [{ $type: "$llm.latencyMs" }, "number"] },
                      "$llm.latencyMs",
                      null,
                    ],
                  },
                  costUsd: {
                    $cond: [
                      { $eq: [{ $type: "$llm.costUsd" }, "number"] },
                      "$llm.costUsd",
                      null,
                    ],
                  },
                  totalTokens: {
                    $cond: [
                      { $eq: [{ $type: "$llm.totalTokens" }, "number"] },
                      "$llm.totalTokens",
                      null,
                    ],
                  },
                },
              },
              {
                $group: {
                  _id: "$model",
                  count: { $sum: 1 },
                  avgLatencyMs: { $avg: "$latencyMs" },
                  avgCostUsd: { $avg: "$costUsd" },
                  avgTotalTokens: { $avg: "$totalTokens" },
                },
              },
              { $sort: { count: -1 } },
              { $limit: 10 },
            ],
          },
        },
      ]),
      TaskLogModel.aggregate([
        {
          $match: {
            orgId,
            queue: ITEM_PIPELINE_QUEUE_NAME,
            status: "failed",
            createdAt: { $gte: since },
          },
        },
        {
          $project: {
            stage: 1,
            errorName: { $ifNull: ["$error.name", "unknown"] },
          },
        },
        {
          $group: {
            _id: { stage: "$stage", errorName: "$errorName" },
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 20 },
      ]),
      this.prisma.mongoOutbox.groupBy({
        by: ["status"],
        where: { orgId, type: MongoOutboxType.processed_item },
        _count: { _all: true },
      }),
      this.prisma.mongoOutbox.count({
        where: {
          orgId,
          type: MongoOutboxType.processed_item,
          status: MongoOutboxStatus.processing,
          lockedAt: { lt: staleLockCutoff },
        },
      }),
      this.prisma.mongoOutbox.findFirst({
        where: {
          orgId,
          type: MongoOutboxType.processed_item,
          status: { in: activeOutboxStatuses },
        },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
      this.computeIngestionLatency(orgId, since),
    ]);
    const processedAgg = Array.isArray(processedAggResult)
      ? (processedAggResult[0] ?? {})
      : {};
    const statusAgg = Array.isArray(processedAgg.statusAgg)
      ? (processedAgg.statusAgg as { _id?: unknown; count?: unknown }[])
      : [];
    const latencyAgg = Array.isArray(processedAgg.latencyAgg)
      ? (processedAgg.latencyAgg as { avgLatencyMs?: number }[])
      : [];
    const llmAgg = Array.isArray(processedAgg.llmAgg)
      ? (processedAgg.llmAgg as {
          _id?: unknown;
          count?: unknown;
          avgLatencyMs?: number;
          avgCostUsd?: number;
          avgTotalTokens?: number;
        }[])
      : [];

    const totals = {
      total: 0,
      completed: 0,
      failed: 0,
      processing: 0,
      pending: 0,
    };

    for (const entry of statusAgg) {
      const status = String(entry._id ?? "");
      const count = Number(entry.count ?? 0);
      totals.total += count;
      if (status in totals) {
        (totals as Record<string, number>)[status] = count;
      }
    }

    const completed = totals.completed ?? 0;
    const successRate = totals.total > 0 ? completed / totals.total : null;
    const averageLatencyCandidate = latencyAgg[0]?.avgLatencyMs;
    const averageLatencyMs =
      typeof averageLatencyCandidate === "number" &&
      Number.isFinite(averageLatencyCandidate)
        ? Math.round(averageLatencyCandidate)
        : null;

    const failureTypes = failureAgg.map((entry) => ({
      stage: String(entry._id?.stage ?? "unknown"),
      errorName: String(entry._id?.errorName ?? "unknown"),
      count: Number(entry.count ?? 0),
    }));

    const llmModels = llmAgg.map((entry) => {
      const avgLatencyMs =
        typeof entry.avgLatencyMs === "number" &&
        Number.isFinite(entry.avgLatencyMs)
          ? Math.round(entry.avgLatencyMs)
          : null;
      const avgCostUsd =
        typeof entry.avgCostUsd === "number" &&
        Number.isFinite(entry.avgCostUsd)
          ? Math.round(entry.avgCostUsd * 1000) / 1000
          : null;
      const avgTotalTokens =
        typeof entry.avgTotalTokens === "number" &&
        Number.isFinite(entry.avgTotalTokens)
          ? Math.round(entry.avgTotalTokens)
          : null;

      return {
        model: String(entry._id ?? "unknown"),
        count: Number(entry.count ?? 0),
        avgLatencyMs,
        avgCostUsd,
        avgTotalTokens,
      };
    });

    const outboxTotals = {
      total: 0,
      pending: 0,
      processing: 0,
      failed: 0,
      dead: 0,
      staleProcessing: outboxStaleProcessing,
    };
    for (const entry of outboxStatusAgg) {
      const status = entry.status;
      const count = entry._count?._all ?? 0;
      outboxTotals.total += count;
      if (status === MongoOutboxStatus.pending) {
        outboxTotals.pending = count;
      } else if (status === MongoOutboxStatus.processing) {
        outboxTotals.processing = count;
      } else if (status === MongoOutboxStatus.failed) {
        outboxTotals.failed = count;
      } else if (status === MongoOutboxStatus.dead) {
        outboxTotals.dead = count;
      }
    }
    const oldestCreatedAt = outboxOldest?.createdAt
      ? outboxOldest.createdAt.toISOString()
      : null;
    const oldestAgeMinutes = outboxOldest?.createdAt
      ? Math.max(
          0,
          Math.round((Date.now() - outboxOldest.createdAt.getTime()) / 60_000),
        )
      : null;

    return {
      windowMinutes: normalizedWindow,
      totals,
      successRate,
      averageLatencyMs,
      ingestionLatencyMs: ingestionLatency,
      failureTypes,
      llmModels,
      outbox: {
        totals: outboxTotals,
        oldestCreatedAt,
        oldestAgeMinutes,
      },
    };
  }
}
