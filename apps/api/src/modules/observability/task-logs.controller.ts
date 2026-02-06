import { TaskLogModel } from "@modular/mongo";
import { redactSensitiveFields } from "@modular/utils";
import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

type TaskLogStatus = "pending" | "processing" | "completed" | "failed";

function isTaskLogStatus(value: string): value is TaskLogStatus {
  return value === "pending" || value === "processing" || value === "completed" || value === "failed";
}

const REDACTED = "[REDACTED]";

function isSensitiveKey(key: string) {
  const normalized = key.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (
    normalized === "authorization" ||
    normalized === "proxy-authorization" ||
    normalized === "x-api-key" ||
    normalized === "x_api_key" ||
    normalized === "api_key" ||
    normalized === "apikey" ||
    normalized === "token" ||
    normalized === "access_token" ||
    normalized === "refresh_token" ||
    normalized === "password" ||
    normalized === "passphrase" ||
    normalized === "secret"
  ) {
    return true;
  }
  return normalized.endsWith("_api_key") || normalized.endsWith("apikey");
}

function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 10) {
    return value;
  }
  if (!value) {
    return value;
  }
  if (typeof value === "string") {
    return redactSensitiveFields(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactDeep(entry, depth + 1));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (isSensitiveKey(key)) {
        next[key] = REDACTED;
      } else {
        next[key] = redactDeep(entry, depth + 1);
      }
    }
    return next;
  }
  return value;
}

@ApiTags("observability")
@ApiBearerAuth()
@Controller("admin/quality")
export class TaskLogsController {
  @Get("task-logs")
  @Permissions("settings.manage")
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("queue") queue?: string,
    @Query("jobId") jobId?: string,
    @Query("stage") stage?: string,
    @Query("status") status?: string,
    @Query("limit") limit?: string,
    @Query("sinceMinutes") sinceMinutes?: string
  ) {
    const normalizedLimitRaw = limit ? Number(limit) : 50;
    const normalizedLimit = Math.min(Math.max(Number.isFinite(normalizedLimitRaw) ? Math.floor(normalizedLimitRaw) : 50, 1), 200);

    const normalizedSinceRaw = sinceMinutes ? Number(sinceMinutes) : null;
    const normalizedSinceMinutes =
      normalizedSinceRaw !== null && Number.isFinite(normalizedSinceRaw) ? Math.floor(normalizedSinceRaw) : null;
    const since =
      normalizedSinceMinutes !== null && normalizedSinceMinutes > 0
        ? new Date(Date.now() - normalizedSinceMinutes * 60 * 1000)
        : null;

    const where: Record<string, unknown> = { orgId: user.orgId };
    const normalizedQueue = typeof queue === "string" ? queue.trim() : "";
    if (normalizedQueue) {
      where.queue = normalizedQueue;
    }
    const normalizedJobId = typeof jobId === "string" ? jobId.trim() : "";
    if (normalizedJobId) {
      where.jobId = normalizedJobId;
    }
    const normalizedStage = typeof stage === "string" ? stage.trim() : "";
    if (normalizedStage) {
      where.stage = normalizedStage;
    }
    const normalizedStatus = typeof status === "string" ? status.trim() : "";
    if (normalizedStatus && isTaskLogStatus(normalizedStatus)) {
      where.status = normalizedStatus;
    }
    if (since) {
      where.createdAt = { $gte: since };
    }

    const logs = await TaskLogModel.find(where)
      .sort({ createdAt: -1 })
      .limit(normalizedLimit)
      .lean();

    return logs.map((log) => {
      const messageValue =
        typeof (log as { message?: unknown }).message === "string"
          ? redactSensitiveFields((log as { message: string }).message)
          : (log as { message?: unknown }).message;
      return {
        ...log,
        ...(messageValue !== undefined ? { message: messageValue } : {}),
        data: redactDeep((log as { data?: unknown }).data),
        error: redactDeep((log as { error?: unknown }).error),
      };
    });
  }

  @Get("task-logs/summary")
  @Permissions("settings.manage")
  async summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query("queue") queue?: string,
    @Query("stage") stage?: string,
    @Query("status") status?: string,
    @Query("sinceMinutes") sinceMinutes?: string
  ) {
    const normalizedSinceRaw = sinceMinutes ? Number(sinceMinutes) : null;
    const normalizedSinceMinutes =
      normalizedSinceRaw !== null && Number.isFinite(normalizedSinceRaw) ? Math.floor(normalizedSinceRaw) : null;
    const since =
      normalizedSinceMinutes !== null && normalizedSinceMinutes > 0
        ? new Date(Date.now() - normalizedSinceMinutes * 60 * 1000)
        : null;

    const where: Record<string, unknown> = { orgId: user.orgId };
    const normalizedQueue = typeof queue === "string" ? queue.trim() : "";
    if (normalizedQueue) {
      where.queue = normalizedQueue;
    }
    const normalizedStage = typeof stage === "string" ? stage.trim() : "";
    if (normalizedStage) {
      where.stage = normalizedStage;
    }
    const normalizedStatus = typeof status === "string" ? status.trim() : "";
    if (normalizedStatus && isTaskLogStatus(normalizedStatus)) {
      where.status = normalizedStatus;
    }
    if (since) {
      where.createdAt = { $gte: since };
    }

    const statusAggPromise = TaskLogModel.aggregate([
      { $match: where },
      { $group: { _id: "$status", count: { $sum: 1 } } }
    ]);

    const stageAggPromise = TaskLogModel.aggregate([
      { $match: where },
      { $group: { _id: "$stage", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 50 }
    ]);

    const includeTopErrors = !normalizedStatus || normalizedStatus === "failed";
    const errorAggPromise = includeTopErrors
      ? TaskLogModel.aggregate([
          { $match: { ...where, status: "failed" } },
          {
            $project: {
              queue: 1,
              stage: 1,
              errorName: { $ifNull: ["$error.name", "unknown"] },
              errorMessage: { $ifNull: ["$error.message", "$message"] }
            }
          },
          {
            $group: {
              _id: { queue: "$queue", stage: "$stage", errorName: "$errorName" },
              count: { $sum: 1 },
              sampleMessage: { $first: "$errorMessage" }
            }
          },
          { $sort: { count: -1 } },
          { $limit: 25 }
        ])
      : Promise.resolve([]);

    const [statusAgg, stageAgg, errorAgg] = await Promise.all([statusAggPromise, stageAggPromise, errorAggPromise]);

    const totals = {
      total: 0,
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0
    };

    for (const entry of statusAgg) {
      const key = String(entry._id ?? "");
      const count = Number(entry.count ?? 0);
      totals.total += count;
      if (key in totals) {
        (totals as Record<string, number>)[key] = count;
      }
    }

    const byStage = stageAgg.map((entry) => ({
      stage: String(entry._id ?? "unknown"),
      count: Number(entry.count ?? 0)
    }));

    const topErrors = errorAgg.map((entry) => {
      const queueValue = String(entry._id?.queue ?? "unknown");
      const stageValue = String(entry._id?.stage ?? "unknown");
      const errorNameRaw = String(entry._id?.errorName ?? "unknown");
      const sampleMessageRaw = entry.sampleMessage ? String(entry.sampleMessage) : null;
      return {
        queue: queueValue,
        stage: stageValue,
        errorName: redactSensitiveFields(errorNameRaw),
        sampleMessage: sampleMessageRaw ? redactSensitiveFields(sampleMessageRaw) : null,
        count: Number(entry.count ?? 0)
      };
    });

    return {
      totals,
      byStage,
      topErrors
    };
  }
}
