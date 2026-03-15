import { TaskLogModel } from "@modular/mongo";
import { redactSensitiveFields } from "@modular/utils";
import { Prisma } from "@prisma/client";
import { Injectable } from "@nestjs/common";

import { PrismaService } from "../config/prisma.service";

import {
  ExceptionEventsService,
  type ExceptionEventKind,
  type ExceptionEventStats,
} from "./exception-events.service";

export type TaskLogStatus = "pending" | "processing" | "completed" | "failed";

export interface TaskLogListFilters {
  orgId: string;
  queue?: string;
  jobId?: string;
  stage?: string;
  status?: TaskLogStatus;
  start?: Date;
  end?: Date;
}

export interface AuditLogListFilters {
  orgId: string;
  search?: string;
  resource?: string;
  action?: string;
  start?: Date;
  end?: Date;
}

export interface PaginationInput {
  page?: number;
  pageSize?: number;
}

export interface PaginatedResult<TItem> {
  page: number;
  pageSize: number;
  total: number;
  items: TItem[];
}

export interface TaskLogListItem {
  id: string;
  queue: string;
  jobId: string;
  orgId: string;
  stage: string;
  status: TaskLogStatus;
  message?: string | null;
  data?: unknown;
  error?: unknown;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface TaskLogSummary {
  totals: {
    total: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  };
  byStage: { stage: string; count: number }[];
  topErrors: {
    queue: string;
    stage: string;
    errorName: string;
    sampleMessage: string | null;
    count: number;
  }[];
}

export interface AuditLogListItem {
  id: string;
  orgId: string;
  actorId?: string | null;
  resource: string;
  action: string;
  metadata?: unknown;
  ipAddress?: string | null;
  createdAt: string;
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
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
      next[key] = isSensitiveKey(key) ? REDACTED : redactDeep(entry, depth + 1);
    }
    return next;
  }
  return value;
}

function normalizePagination(input?: PaginationInput): Required<PaginationInput> {
  const page =
    typeof input?.page === "number" && Number.isFinite(input.page) && input.page > 0
      ? Math.floor(input.page)
      : DEFAULT_PAGE;
  const pageSize =
    typeof input?.pageSize === "number" && Number.isFinite(input.pageSize) && input.pageSize > 0
      ? Math.min(MAX_PAGE_SIZE, Math.floor(input.pageSize))
      : DEFAULT_PAGE_SIZE;

  return { page, pageSize };
}

function serializeDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
    return value;
  }

  return null;
}

@Injectable()
export class AdminLogsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exceptionEvents: ExceptionEventsService,
  ) {}

  private buildTaskLogWhere(filters: TaskLogListFilters): Record<string, unknown> {
    const where: Record<string, unknown> = { orgId: filters.orgId };

    if (filters.queue) {
      where.queue = filters.queue;
    }
    if (filters.jobId) {
      where.jobId = filters.jobId;
    }
    if (filters.stage) {
      where.stage = filters.stage;
    }
    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.start || filters.end) {
      where.createdAt = {
        ...(filters.start ? { $gte: filters.start } : {}),
        ...(filters.end ? { $lte: filters.end } : {}),
      };
    }

    return where;
  }

  private mapTaskLog(log: Record<string, unknown>): TaskLogListItem {
    const messageValue =
      typeof log.message === "string" ? redactSensitiveFields(log.message) : log.message;
    const rawId = log._id;
    const id =
      rawId && typeof rawId === "object" && "toString" in rawId
        ? (rawId as { toString(): string }).toString()
        : String(rawId ?? `${log.queue ?? "queue"}:${log.jobId ?? "job"}:${log.stage ?? "stage"}`);

    return {
      id,
      queue: String(log.queue ?? ""),
      jobId: String(log.jobId ?? ""),
      orgId: String(log.orgId ?? ""),
      stage: String(log.stage ?? ""),
      status: String(log.status ?? "pending") as TaskLogStatus,
      ...(messageValue !== undefined ? { message: (messageValue as string | null | undefined) ?? null } : {}),
      data: redactDeep(log.data),
      error: redactDeep(log.error),
      createdAt: serializeDate(log.createdAt),
      updatedAt: serializeDate(log.updatedAt),
    };
  }

  async listTaskLogs(
    filters: TaskLogListFilters,
    pagination?: PaginationInput,
  ): Promise<PaginatedResult<TaskLogListItem>> {
    const { page, pageSize } = normalizePagination(pagination);
    const where = this.buildTaskLogWhere(filters);
    const skip = (page - 1) * pageSize;

    const [total, logs] = await Promise.all([
      TaskLogModel.countDocuments(where),
      TaskLogModel.find(where).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    ]);

    return {
      page,
      pageSize,
      total,
      items: logs.map((log) => this.mapTaskLog(log as unknown as Record<string, unknown>)),
    };
  }

  async summarizeTaskLogs(filters: TaskLogListFilters): Promise<TaskLogSummary> {
    const where = this.buildTaskLogWhere(filters);

    const statusAggPromise = TaskLogModel.aggregate([
      { $match: where },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    const stageAggPromise = TaskLogModel.aggregate([
      { $match: where },
      { $group: { _id: "$stage", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 50 },
    ]);

    const includeTopErrors = !filters.status || filters.status === "failed";
    const errorAggPromise = includeTopErrors
      ? TaskLogModel.aggregate([
          { $match: { ...where, status: "failed" } },
          {
            $project: {
              queue: 1,
              stage: 1,
              errorName: { $ifNull: ["$error.name", "unknown"] },
              errorMessage: { $ifNull: ["$error.message", "$message"] },
            },
          },
          {
            $group: {
              _id: { queue: "$queue", stage: "$stage", errorName: "$errorName" },
              count: { $sum: 1 },
              sampleMessage: { $first: "$errorMessage" },
            },
          },
          { $sort: { count: -1 } },
          { $limit: 25 },
        ])
      : Promise.resolve([]);

    const [statusAgg, stageAgg, errorAgg] = await Promise.all([
      statusAggPromise,
      stageAggPromise,
      errorAggPromise,
    ]);

    const totals = {
      total: 0,
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    };

    for (const entry of statusAgg) {
      const key = String(entry._id ?? "");
      const count = Number(entry.count ?? 0);
      totals.total += count;
      if (key in totals) {
        (totals as Record<string, number>)[key] = count;
      }
    }

    return {
      totals,
      byStage: stageAgg.map((entry) => ({
        stage: String(entry._id ?? "unknown"),
        count: Number(entry.count ?? 0),
      })),
      topErrors: errorAgg.map((entry) => ({
        queue: String(entry._id?.queue ?? "unknown"),
        stage: String(entry._id?.stage ?? "unknown"),
        errorName: redactSensitiveFields(String(entry._id?.errorName ?? "unknown")),
        sampleMessage: entry.sampleMessage ? redactSensitiveFields(String(entry.sampleMessage)) : null,
        count: Number(entry.count ?? 0),
      })),
    };
  }

  async listErrors(
    filters: {
      orgId: string;
      kind?: ExceptionEventKind;
      operationName?: string;
      messageContains?: string;
      start?: Date;
      end?: Date;
    },
    pagination?: PaginationInput,
  ) {
    const { page, pageSize } = normalizePagination(pagination);
    const offset = (page - 1) * pageSize;
    const result = await this.exceptionEvents.list({
      ...filters,
      limit: pageSize,
      offset,
    });

    return {
      page,
      pageSize,
      total: result.total,
      items: result.items,
    };
  }

  async summarizeErrors(filters: {
    orgId: string;
    kind?: ExceptionEventKind;
    operationName?: string;
    messageContains?: string;
    start?: Date;
    end?: Date;
  }): Promise<ExceptionEventStats> {
    return this.exceptionEvents.stats(filters);
  }

  async listAuditLogs(
    filters: AuditLogListFilters,
    pagination?: PaginationInput,
  ): Promise<PaginatedResult<AuditLogListItem>> {
    const { page, pageSize } = normalizePagination(pagination);
    const where: Prisma.AuditLogWhereInput = { orgId: filters.orgId };
    const and: Prisma.AuditLogWhereInput[] = [];

    if (filters.resource) {
      and.push({
        resource: {
          contains: filters.resource,
        },
      });
    }

    if (filters.action) {
      and.push({
        action: {
          contains: filters.action,
        },
      });
    }

    if (filters.start || filters.end) {
      and.push({
        createdAt: {
          ...(filters.start ? { gte: filters.start } : {}),
          ...(filters.end ? { lte: filters.end } : {}),
        },
      });
    }

    if (filters.search) {
      and.push({
        OR: [
          { resource: { contains: filters.search } },
          { action: { contains: filters.search } },
          { actorId: { contains: filters.search } },
          { ipAddress: { contains: filters.search } },
        ],
      });
    }

    if (and.length > 0) {
      where.AND = and;
    }

    const skip = (page - 1) * pageSize;
    const [total, items] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
    ]);

    return {
      page,
      pageSize,
      total,
      items: items.map((item) => ({
        id: item.id,
        orgId: item.orgId,
        actorId: item.actorId,
        resource: item.resource,
        action: item.action,
        metadata: item.metadata,
        ipAddress: item.ipAddress,
        createdAt: item.createdAt.toISOString(),
      })),
    };
  }
}
