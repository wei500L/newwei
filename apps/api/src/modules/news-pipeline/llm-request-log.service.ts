import { type LlmRequestLog } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { FilterQuery, Model } from "mongoose";

import {
  DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_KEYS,
  DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_PREFIXES,
  LlmRequestLogSettingsService,
  type LlmRequestLogSettingsSource,
  type LlmRequestLogMetadataPolicy,
  type LlmRequestLogMetadataPolicySummarySnapshot,
} from "../system-settings/llm-request-log-settings.service";

export const LLM_REQUEST_LOG_MODEL = "LLM_REQUEST_LOG_MODEL";

export type LlmRequestType =
  | "completion"
  | "embedding"
  | "rerank"
  | "stream"
  | "responses";
export type LlmRequestStatus = "success" | "error";
export type LlmApiSurface = "chat_completions" | "responses" | "embeddings";

export interface LlmRequestLogEntry {
  orgId: string;
  requestType: LlmRequestType;
  model: string;
  status: LlmRequestStatus;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
  latencyMs: number;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
  apiSurface?: LlmApiSurface | null;
}

export interface LlmRequestLogFilter {
  orgId: string;
  model?: string;
  requestType?: LlmRequestType;
  status?: LlmRequestStatus;
  start?: Date;
  end?: Date;
}

export interface LlmRequestLogPagination {
  page?: number;
  pageSize?: number;
}

export interface LlmRequestLogListItem {
  id: string;
  orgId: string;
  requestType: LlmRequestType;
  model: string;
  status: LlmRequestStatus;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  latencyMs: number;
  error: string | null;
  metadata: unknown;
  apiSurface: LlmApiSurface | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LlmRequestLogQueryResult {
  page: number;
  pageSize: number;
  total: number;
  items: LlmRequestLogListItem[];
  metadataPolicy: LlmRequestLogMetadataPolicySummary;
}

export interface LlmRequestLogMetadataPolicySummary {
  source: LlmRequestLogSettingsSource;
  allowedTopLevelKeys: string[];
  allowedTopLevelPrefixes: string[];
  keyCount: number;
  prefixCount: number;
}

export interface LlmUsageSummaryTotals {
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  avgLatencyMs: number;
}

export interface LlmUsageSummaryGroupRow extends LlmUsageSummaryTotals {
  model: string;
}

export interface LlmUsageSummaryByDayRow extends LlmUsageSummaryTotals {
  date: string;
}

export interface LlmUsageSummary {
  totals: LlmUsageSummaryTotals;
  byModel: LlmUsageSummaryGroupRow[];
  byDay: LlmUsageSummaryByDayRow[];
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const UNKNOWN_ORG_ID = "_unknown_";
const MAX_ERROR_LENGTH = 1000;
const MAX_METADATA_DEPTH = 4;
const MAX_METADATA_OBJECT_KEYS = 40;
const MAX_METADATA_ARRAY_ITEMS = 40;
const MAX_METADATA_STRING_LENGTH = 500;
const MAX_METADATA_SERIALIZED_LENGTH = 8_192;
const WRITE_SUCCESS_LOG_INTERVAL = 500;
const METADATA_NORMALIZATION_LOG_INTERVAL = 100;
const METADATA_POLICY_CACHE_TTL_MS = 5_000;

const METADATA_PRIORITY_KEYS = [
  "traceid",
  "requestid",
  "correlationid",
  "taskid",
  "jobid",
  "module",
  "feature",
  "source",
  "operation",
  "pipeline",
  "provider",
  "attempt",
  "retry",
  "stage",
  "tags",
];

interface UsageAggRow {
  requestCount?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  totalLatencyMs?: number;
}

interface UsageAggModelRow extends UsageAggRow {
  _id?: string;
}

interface UsageAggDayRow extends UsageAggRow {
  _id?: string;
}

interface LlmRequestLogRaw
  extends Omit<LlmRequestLogListItem, "id" | "metadata" | "createdAt" | "updatedAt"> {
  _id: { toString(): string };
  metadata?: unknown;
  createdAt?: Date;
  updatedAt?: Date;
}

interface NormalizedMetadataResult {
  value: Record<string, unknown> | null;
  filtered: boolean;
  truncated: boolean;
}

interface ResolvedMetadataPolicy {
  allowedTopLevelKeys: Set<string>;
  allowedTopLevelPrefixes: string[];
}

interface CachedResolvedMetadataPolicy {
  expiresAt: number;
  value: ResolvedMetadataPolicy;
}

@Injectable()
export class LlmRequestLogService {
  private readonly logger = createLogger({ name: "llm-request-log-service" });
  private writeSuccessTotal = 0;
  private writeFailureTotal = 0;
  private metadataFilteredTotal = 0;
  private metadataTruncatedTotal = 0;
  private cachedResolvedMetadataPolicy: CachedResolvedMetadataPolicy | null = null;

  constructor(
    @Inject(LLM_REQUEST_LOG_MODEL)
    private readonly llmRequestLogModel: Model<LlmRequestLog>,
    @Optional()
    private readonly llmRequestLogSettings?: LlmRequestLogSettingsService,
  ) {}

  logRequest(entry: LlmRequestLogEntry): void {
    const normalized = this.normalizeEntry(entry);
    void this.llmRequestLogModel
      .create(normalized)
      .then(() => {
        this.recordWriteSuccess();
      })
      .catch((error: unknown) => {
        const writeFailureTotal = this.recordWriteFailure();
        this.logger.warn(
          {
            err: error,
            orgId: normalized.orgId,
            requestType: normalized.requestType,
            model: normalized.model,
            metricName: "llm_request_log_write_total",
            metricOutcome: "failure",
            writeFailureTotal,
          },
          "Failed to persist LLM request log",
        );
      });
  }

  async queryLogs(
    filter: LlmRequestLogFilter,
    pagination: LlmRequestLogPagination = {},
  ): Promise<LlmRequestLogQueryResult> {
    const where = this.buildWhere(filter);
    const metadataPolicy = this.resolveMetadataPolicySummary();
    const page = Math.max(DEFAULT_PAGE, Math.trunc(pagination.page ?? DEFAULT_PAGE));
    const requestedPageSize = Math.trunc(pagination.pageSize ?? DEFAULT_PAGE_SIZE);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requestedPageSize));
    const skip = (page - 1) * pageSize;

    const [total, rows] = await Promise.all([
      this.llmRequestLogModel.countDocuments(where),
      this.llmRequestLogModel
        .find(where)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
    ]);

    const items = (rows as LlmRequestLogRaw[]).map((row) => ({
      id: row._id.toString(),
      orgId: row.orgId,
      requestType: row.requestType,
      model: row.model,
      status: row.status,
      promptTokens: this.toNullableNumber(row.promptTokens),
      completionTokens: this.toNullableNumber(row.completionTokens),
      totalTokens: this.toNullableNumber(row.totalTokens),
      costUsd: this.toNullableNumber(row.costUsd),
      latencyMs: Math.max(0, Number(row.latencyMs ?? 0)),
      error: typeof row.error === "string" ? row.error : null,
      metadata: row.metadata ?? null,
      apiSurface: this.toApiSurface(row.apiSurface),
      createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(0),
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date(0),
    }));

    return {
      page,
      pageSize,
      total,
      items,
      metadataPolicy,
    };
  }

  async getUsageSummary(
    orgId: string,
    dateRange?: { start?: Date; end?: Date },
  ): Promise<LlmUsageSummary> {
    const where = this.buildWhere({
      orgId,
      start: dateRange?.start,
      end: dateRange?.end,
    });

    const [totalsAgg, byModelAgg, byDayAgg] = await Promise.all([
      this.llmRequestLogModel.aggregate<UsageAggRow>([
        { $match: where },
        {
          $group: {
            _id: null,
            requestCount: { $sum: 1 },
            promptTokens: { $sum: { $ifNull: ["$promptTokens", 0] } },
            completionTokens: { $sum: { $ifNull: ["$completionTokens", 0] } },
            totalTokens: { $sum: { $ifNull: ["$totalTokens", 0] } },
            costUsd: { $sum: { $ifNull: ["$costUsd", 0] } },
            totalLatencyMs: { $sum: { $ifNull: ["$latencyMs", 0] } },
          },
        },
      ]),
      this.llmRequestLogModel.aggregate<UsageAggModelRow>([
        { $match: where },
        {
          $group: {
            _id: "$model",
            requestCount: { $sum: 1 },
            promptTokens: { $sum: { $ifNull: ["$promptTokens", 0] } },
            completionTokens: { $sum: { $ifNull: ["$completionTokens", 0] } },
            totalTokens: { $sum: { $ifNull: ["$totalTokens", 0] } },
            costUsd: { $sum: { $ifNull: ["$costUsd", 0] } },
            totalLatencyMs: { $sum: { $ifNull: ["$latencyMs", 0] } },
          },
        },
        { $sort: { requestCount: -1, _id: 1 } },
      ]),
      this.llmRequestLogModel.aggregate<UsageAggDayRow>([
        { $match: where },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$createdAt",
                timezone: "UTC",
              },
            },
            requestCount: { $sum: 1 },
            promptTokens: { $sum: { $ifNull: ["$promptTokens", 0] } },
            completionTokens: { $sum: { $ifNull: ["$completionTokens", 0] } },
            totalTokens: { $sum: { $ifNull: ["$totalTokens", 0] } },
            costUsd: { $sum: { $ifNull: ["$costUsd", 0] } },
            totalLatencyMs: { $sum: { $ifNull: ["$latencyMs", 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    const totals = this.mapUsageAggRow(totalsAgg[0] ?? {});

    const byModel = byModelAgg.map((row) => ({
      model: typeof row._id === "string" && row._id.trim().length > 0 ? row._id : "unknown",
      ...this.mapUsageAggRow(row),
    }));

    const byDay = byDayAgg.map((row) => ({
      date: typeof row._id === "string" ? row._id : "",
      ...this.mapUsageAggRow(row),
    }));

    return {
      totals,
      byModel,
      byDay,
    };
  }

  private normalizeEntry(entry: LlmRequestLogEntry): LlmRequestLogEntry {
    const metadataPolicy = this.resolveMetadataPolicy();
    const metadata = this.normalizeMetadata(entry.metadata, metadataPolicy);
    if (metadata.filtered) {
      this.metadataFilteredTotal += 1;
    }
    if (metadata.truncated) {
      this.metadataTruncatedTotal += 1;
    }
    if (
      (metadata.filtered || metadata.truncated) &&
      (metadata.truncated ||
        this.metadataFilteredTotal % METADATA_NORMALIZATION_LOG_INTERVAL === 0)
    ) {
      this.logger.info(
        {
          metricName: "llm_request_log_metadata_normalized_total",
          metricOutcome: metadata.truncated ? "truncated" : "filtered",
          metadataFilteredTotal: this.metadataFilteredTotal,
          metadataTruncatedTotal: this.metadataTruncatedTotal,
        },
        "Normalized LLM request metadata before persistence",
      );
    }

    return {
      orgId: this.normalizeOrgId(entry.orgId),
      requestType: entry.requestType,
      model:
        typeof entry.model === "string" && entry.model.trim().length > 0
          ? entry.model.trim()
          : "unknown",
      status: entry.status,
      promptTokens: this.toNullableNumber(entry.promptTokens),
      completionTokens: this.toNullableNumber(entry.completionTokens),
      totalTokens: this.toNullableNumber(entry.totalTokens),
      costUsd: this.toNullableNumber(entry.costUsd),
      latencyMs: Math.max(0, Number(entry.latencyMs) || 0),
      error: this.normalizeError(entry.error),
      metadata: metadata.value,
      apiSurface: entry.apiSurface ?? null,
    };
  }

  private normalizeOrgId(orgId: string): string {
    const trimmed = typeof orgId === "string" ? orgId.trim() : "";
    return trimmed.length > 0 ? trimmed : UNKNOWN_ORG_ID;
  }

  private normalizeError(error: string | null | undefined): string | null {
    if (typeof error !== "string") {
      return null;
    }
    const trimmed = error.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed.slice(0, MAX_ERROR_LENGTH);
  }

  private normalizeMetadata(
    metadata: Record<string, unknown> | null | undefined,
    metadataPolicy: ResolvedMetadataPolicy,
  ): NormalizedMetadataResult {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return { value: null, filtered: false, truncated: false };
    }

    const source = metadata as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    let filtered = false;

    Object.entries(source).forEach(([rawKey, rawValue]) => {
      const normalizedKey = this.normalizeMetadataKey(rawKey);
      if (
        !normalizedKey ||
        !this.isAllowedMetadataKey(normalizedKey, metadataPolicy)
      ) {
        filtered = true;
        return;
      }
      if (Object.keys(sanitized).length >= MAX_METADATA_OBJECT_KEYS) {
        filtered = true;
        return;
      }

      const value = this.sanitizeMetadataValue(rawValue, 1);
      if (value === undefined) {
        filtered = true;
        return;
      }
      sanitized[normalizedKey] = value;
    });

    if (Object.keys(sanitized).length === 0) {
      return { value: null, filtered, truncated: false };
    }

    const serialized = this.safeStringify(sanitized);
    if (serialized.length <= MAX_METADATA_SERIALIZED_LENGTH) {
      return { value: sanitized, filtered, truncated: false };
    }

    return {
      value: this.buildCompactMetadata(sanitized),
      filtered: true,
      truncated: true,
    };
  }

  private buildCompactMetadata(
    metadata: Record<string, unknown>,
  ): Record<string, unknown> {
    const compact: Record<string, unknown> = {};

    METADATA_PRIORITY_KEYS.forEach((key) => {
      if (key in metadata) {
        compact[key] = metadata[key];
      }
    });

    if (Object.keys(compact).length === 0) {
      Object.entries(metadata)
        .slice(0, 5)
        .forEach(([key, value]) => {
          compact[key] = value;
        });
    }

    compact._truncated = true;
    compact._originalKeyCount = Object.keys(metadata).length;
    compact._retainedKeyCount = Object.keys(compact).filter(
      (key) => !key.startsWith("_"),
    ).length;

    const serialized = this.safeStringify(compact);
    if (serialized.length <= MAX_METADATA_SERIALIZED_LENGTH) {
      return compact;
    }

    return {
      _truncated: true,
      _originalKeyCount: Object.keys(metadata).length,
      _retainedKeyCount: 0,
    };
  }

  private sanitizeMetadataValue(value: unknown, depth: number): unknown {
    if (value === null) {
      return null;
    }
    if (depth > MAX_METADATA_DEPTH) {
      return "[depth-truncated]";
    }

    if (typeof value === "string") {
      return value.length > MAX_METADATA_STRING_LENGTH
        ? `${value.slice(0, MAX_METADATA_STRING_LENGTH)}...[truncated]`
        : value;
    }

    if (typeof value === "number") {
      return Number.isFinite(value) ? value : undefined;
    }

    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "undefined") {
      return undefined;
    }

    if (typeof value === "object") {
      if (value instanceof Date) {
        return value.toISOString();
      }
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message.slice(0, MAX_METADATA_STRING_LENGTH),
        };
      }

      if (Array.isArray(value)) {
        const items = value
          .slice(0, MAX_METADATA_ARRAY_ITEMS)
          .map((item) => this.sanitizeMetadataValue(item, depth + 1))
          .filter((item) => item !== undefined);
        return items;
      }

      const nested = value as Record<string, unknown>;
      const nestedRecord: Record<string, unknown> = {};
      Object.entries(nested)
        .slice(0, MAX_METADATA_OBJECT_KEYS)
        .forEach(([rawKey, rawValue]) => {
          const normalizedKey = this.normalizeMetadataKey(rawKey);
          if (!normalizedKey) {
            return;
          }
          const sanitized = this.sanitizeMetadataValue(rawValue, depth + 1);
          if (sanitized === undefined) {
            return;
          }
          nestedRecord[normalizedKey] = sanitized;
        });

      return Object.keys(nestedRecord).length > 0 ? nestedRecord : undefined;
    }

    return String(value).slice(0, MAX_METADATA_STRING_LENGTH);
  }

  private normalizeMetadataKey(rawKey: string): string | null {
    if (typeof rawKey !== "string") {
      return null;
    }
    const trimmed = rawKey.trim().toLowerCase();
    if (!trimmed) {
      return null;
    }
    return trimmed.slice(0, 64);
  }

  private isAllowedMetadataKey(
    key: string,
    metadataPolicy: ResolvedMetadataPolicy,
  ): boolean {
    return (
      metadataPolicy.allowedTopLevelKeys.has(key) ||
      metadataPolicy.allowedTopLevelPrefixes.some((prefix) =>
        key.startsWith(prefix),
      )
    );
  }

  private resolveMetadataPolicy(): ResolvedMetadataPolicy {
    const now = Date.now();
    if (
      this.cachedResolvedMetadataPolicy &&
      now < this.cachedResolvedMetadataPolicy.expiresAt
    ) {
      return this.cachedResolvedMetadataPolicy.value;
    }

    const snapshot: LlmRequestLogMetadataPolicy = this.llmRequestLogSettings
      ? this.llmRequestLogSettings.getMetadataPolicySnapshot()
      : {
          allowedTopLevelKeys: [
            ...DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_KEYS,
          ],
          allowedTopLevelPrefixes: [
            ...DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_PREFIXES,
          ],
        };
    const resolved: ResolvedMetadataPolicy = {
      allowedTopLevelKeys: new Set(snapshot.allowedTopLevelKeys),
      allowedTopLevelPrefixes: snapshot.allowedTopLevelPrefixes,
    };
    this.cachedResolvedMetadataPolicy = {
      value: resolved,
      expiresAt: now + METADATA_POLICY_CACHE_TTL_MS,
    };
    return resolved;
  }

  private resolveMetadataPolicySummary(): LlmRequestLogMetadataPolicySummary {
    let snapshot: LlmRequestLogMetadataPolicySummarySnapshot;
    if (this.llmRequestLogSettings) {
      snapshot = this.llmRequestLogSettings.getMetadataPolicySummarySnapshot();
    } else {
      snapshot = {
        source: "default",
        allowedTopLevelKeys: [
          ...DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_KEYS,
        ],
        allowedTopLevelPrefixes: [
          ...DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_PREFIXES,
        ],
      };
    }

    return {
      source: snapshot.source,
      allowedTopLevelKeys: snapshot.allowedTopLevelKeys,
      allowedTopLevelPrefixes: snapshot.allowedTopLevelPrefixes,
      keyCount: snapshot.allowedTopLevelKeys.length,
      prefixCount: snapshot.allowedTopLevelPrefixes.length,
    };
  }

  private safeStringify(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }

  private recordWriteSuccess(): void {
    this.writeSuccessTotal += 1;
    if (this.writeSuccessTotal % WRITE_SUCCESS_LOG_INTERVAL === 0) {
      this.logger.info(
        {
          metricName: "llm_request_log_write_total",
          metricOutcome: "success",
          writeSuccessTotal: this.writeSuccessTotal,
          writeFailureTotal: this.writeFailureTotal,
        },
        "LLM request log write counters",
      );
    }
  }

  private recordWriteFailure(): number {
    this.writeFailureTotal += 1;
    return this.writeFailureTotal;
  }

  private toNullableNumber(value: unknown): number | null {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    return numeric;
  }

  private toApiSurface(value: unknown): LlmApiSurface | null {
    if (value === "chat_completions" || value === "responses" || value === "embeddings") {
      return value;
    }
    return null;
  }

  private buildWhere(filter: LlmRequestLogFilter): FilterQuery<LlmRequestLog> {
    const where: FilterQuery<LlmRequestLog> = {
      orgId: this.normalizeOrgId(filter.orgId),
    };

    const model = typeof filter.model === "string" ? filter.model.trim() : "";
    if (model) {
      where.model = model;
    }

    if (filter.requestType) {
      where.requestType = filter.requestType;
    }

    if (filter.status) {
      where.status = filter.status;
    }

    const range: Record<string, Date> = {};
    if (filter.start instanceof Date && !Number.isNaN(filter.start.getTime())) {
      range.$gte = filter.start;
    }
    if (filter.end instanceof Date && !Number.isNaN(filter.end.getTime())) {
      range.$lte = filter.end;
    }
    if (Object.keys(range).length > 0) {
      where.createdAt = range;
    }

    return where;
  }

  private mapUsageAggRow(row: UsageAggRow): LlmUsageSummaryTotals {
    const requestCount = this.toSafeInteger(row.requestCount);
    const totalLatencyMs = this.toSafeNumber(row.totalLatencyMs);
    return {
      requestCount,
      promptTokens: this.toSafeInteger(row.promptTokens),
      completionTokens: this.toSafeInteger(row.completionTokens),
      totalTokens: this.toSafeInteger(row.totalTokens),
      costUsd: this.toSafeNumber(row.costUsd),
      avgLatencyMs: requestCount > 0 ? totalLatencyMs / requestCount : 0,
    };
  }

  private toSafeInteger(value: unknown): number {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      return 0;
    }
    return Math.trunc(numeric);
  }

  private toSafeNumber(value: unknown): number {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      return 0;
    }
    return numeric;
  }
}
