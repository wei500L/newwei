import { ProcessedItemModel, TaskLogModel } from "@modular/mongo";
import { Injectable } from "@nestjs/common";

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
  failureTypes: Array<{
    stage: string;
    errorName: string;
    count: number;
  }>;
}

@Injectable()
export class PipelineQualityService {
  async summary(orgId: string, windowMinutes = 60): Promise<PipelineQualitySummary> {
    const normalizedWindow = Math.max(5, Math.min(60 * 24 * 14, Math.floor(windowMinutes)));
    const since = new Date(Date.now() - normalizedWindow * 60 * 1000);

    const [statusAgg, latencyAgg, failureAgg] = await Promise.all([
      ProcessedItemModel.aggregate([
        { $match: { orgId, createdAt: { $gte: since } } },
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
          },
        },
      ]),
      ProcessedItemModel.aggregate([
        {
          $match: {
            orgId,
            createdAt: { $gte: since },
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
      ]),
      TaskLogModel.aggregate([
        { $match: { orgId, status: "failed", createdAt: { $gte: since } } },
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
    ]);

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
    const averageLatencyMs =
      latencyAgg.length > 0 && Number.isFinite(latencyAgg[0].avgLatencyMs)
        ? Math.round(latencyAgg[0].avgLatencyMs)
        : null;

    const failureTypes = failureAgg.map((entry) => ({
      stage: String(entry._id?.stage ?? "unknown"),
      errorName: String(entry._id?.errorName ?? "unknown"),
      count: Number(entry.count ?? 0),
    }));

    return {
      windowMinutes: normalizedWindow,
      totals,
      successRate,
      averageLatencyMs,
      failureTypes,
    };
  }
}
