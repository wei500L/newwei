import { createLogger, getCurrentTraceId } from "@modular/utils";
import {
  VectorBadResponseError,
  VectorClient,
  VectorServiceUnavailableError,
  VectorUnauthorizedError,
  type VectorSearchMatch
} from "@modular/vector-client";
import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";

import { VectorServiceSettingsService } from "../system-settings/vector-service-settings.service";

const logger = createLogger({ name: "vector-client" });

export interface VectorServiceRuntimeDiagnostics {
  snapshotAt: string;
  source: "env" | "db";
  enabled: boolean;
  configured: boolean;
  fallbackToMongo: boolean;
  baseUrl: string | null;
  timeoutMs: number;
  maxRetries: number;
  hasToken: boolean;
  tokenSource: "stored" | "env" | "none";
  temporarilyUnavailable: boolean;
  unavailableUntil: string | null;
  consecutiveFailures: number;
  lastOperation: "search" | "upsert" | null;
  lastFailureAt: string | null;
  lastErrorName: string | null;
  lastErrorMessage: string | null;
}

@Injectable()
export class VectorClientService {
  private client: VectorClient | null = null;
  private clientFingerprint: string | null = null;
  private lastIncompleteWarnAtMs = 0;
  private consecutiveFailures = 0;
  private unavailableUntilMs = 0;
  private lastOperation: "search" | "upsert" | null = null;
  private lastFailureAtMs = 0;
  private lastErrorName: string | null = null;
  private lastErrorMessage: string | null = null;

  constructor(private readonly settings: VectorServiceSettingsService) {}

  async searchBestEffort(options: {
    orgId: string;
    embeddingModel: string;
    vector: number[];
    limit: number;
    minScore?: number;
    lookbackMs?: number;
    traceId?: string;
  }): Promise<VectorSearchMatch[] | null> {
    const client = await this.resolveClient();
    if (!client) {
      return null;
    }
    if (this.isTemporarilyUnavailable()) {
      return null;
    }
    try {
      const response = await client.search(
        {
          orgId: options.orgId,
          embeddingModel: options.embeddingModel,
          vector: options.vector,
          limit: options.limit,
          minScore: options.minScore,
          lookbackMs: options.lookbackMs
        },
        { traceId: options.traceId ?? getCurrentTraceId() }
      );
      this.markAvailable();
      return response.matches ?? [];
    } catch (error) {
      this.markUnavailable(error, "search");
      return null;
    }
  }

  async upsertBestEffort(options: {
    orgId: string;
    embeddingModel: string;
    points: {
      processedItemId: string;
      itemMetaId: string;
      createdAtMs: number;
      vector: number[];
    }[];
    traceId?: string;
  }): Promise<boolean> {
    const client = await this.resolveClient();
    if (!client) {
      return false;
    }
    if (!options.points.length) {
      return true;
    }
    if (this.isTemporarilyUnavailable()) {
      return false;
    }
    try {
      await client.upsert(
        {
          orgId: options.orgId,
          embeddingModel: options.embeddingModel,
          points: options.points
        },
        { traceId: options.traceId ?? getCurrentTraceId() }
      );
      this.markAvailable();
      return true;
    } catch (error) {
      this.markUnavailable(error, "upsert");
      return false;
    }
  }

  async upsertOrThrow(options: {
    orgId: string;
    embeddingModel: string;
    points: {
      processedItemId: string;
      itemMetaId: string;
      createdAtMs: number;
      vector: number[];
    }[];
    traceId?: string;
  }): Promise<void> {
    const cfg = await this.settings.getEffectiveConfig();
    if (!cfg.enabled || options.points.length === 0) {
      return;
    }

    const client = await this.resolveClient();
    if (!client) {
      throw new VectorServiceUnavailableError(
        "Vector service enabled but configuration is incomplete",
      );
    }
    if (this.isTemporarilyUnavailable()) {
      throw new VectorServiceUnavailableError(
        "Vector service is temporarily unavailable",
      );
    }

    try {
      await client.upsert(
        {
          orgId: options.orgId,
          embeddingModel: options.embeddingModel,
          points: options.points,
        },
        { traceId: options.traceId ?? getCurrentTraceId() },
      );
      this.markAvailable();
    } catch (error) {
      this.markUnavailable(error, "upsert");
      throw error instanceof Error
        ? error
        : new VectorServiceUnavailableError("Vector upsert failed", error);
    }
  }

  async fallbackToMongoEnabled(): Promise<boolean> {
    const cfg = await this.settings.getEffectiveConfig();
    return cfg.fallbackToMongo;
  }

  async getDiagnostics(): Promise<VectorServiceRuntimeDiagnostics> {
    const [publicSettings, effective] = await Promise.all([
      this.settings.getPublicSettings(),
      this.settings.getEffectiveConfig(),
    ]);
    const temporarilyUnavailable = this.isTemporarilyUnavailable();

    return {
      snapshotAt: new Date().toISOString(),
      source: publicSettings.source,
      enabled: effective.enabled,
      configured: Boolean(effective.baseUrl && effective.token),
      fallbackToMongo: effective.fallbackToMongo,
      baseUrl: effective.baseUrl ?? null,
      timeoutMs: effective.timeoutMs,
      maxRetries: effective.maxRetries,
      hasToken: Boolean(effective.token),
      tokenSource: publicSettings.tokenSource,
      temporarilyUnavailable,
      unavailableUntil: temporarilyUnavailable
        ? new Date(this.unavailableUntilMs).toISOString()
        : null,
      consecutiveFailures: this.consecutiveFailures,
      lastOperation: this.lastOperation,
      lastFailureAt: this.lastFailureAtMs
        ? new Date(this.lastFailureAtMs).toISOString()
        : null,
      lastErrorName: this.lastErrorName,
      lastErrorMessage: this.lastErrorMessage,
    };
  }

  private async resolveClient(): Promise<VectorClient | null> {
    const cfg = await this.settings.getEffectiveConfig();
    if (!cfg.enabled) {
      return null;
    }

    if (!cfg.baseUrl || !cfg.token) {
      const now = Date.now();
      if (now - this.lastIncompleteWarnAtMs > 60_000) {
        this.lastIncompleteWarnAtMs = now;
        logger.warn(
          { baseUrl: cfg.baseUrl, tokenConfigured: Boolean(cfg.token) },
          "Vector service enabled but configuration is incomplete",
        );
      }
      return null;
    }

    const tokenHash = createHash("sha256").update(cfg.token).digest("hex").slice(0, 16);
    const fingerprint = `${cfg.baseUrl}|${cfg.timeoutMs}|${cfg.maxRetries}|${tokenHash}`;

    if (this.client && this.clientFingerprint === fingerprint) {
      return this.client;
    }

    this.clientFingerprint = fingerprint;
    this.client = new VectorClient({
      baseUrl: cfg.baseUrl,
      token: cfg.token,
      timeoutMs: cfg.timeoutMs,
      maxRetries: cfg.maxRetries
    });
    this.markAvailable();
    return this.client;
  }

  private isTemporarilyUnavailable(): boolean {
    return Date.now() < this.unavailableUntilMs;
  }

  private markAvailable() {
    this.consecutiveFailures = 0;
    this.unavailableUntilMs = 0;
  }

  private markUnavailable(error: unknown, operation: "search" | "upsert") {
    const now = Date.now();
    const wasAvailable = now >= this.unavailableUntilMs;
    const normalizedError = error instanceof Error ? error : null;

    this.consecutiveFailures = Math.min(this.consecutiveFailures + 1, 10);
    this.lastOperation = operation;
    this.lastFailureAtMs = now;
    this.lastErrorName = normalizedError?.name ?? null;
    this.lastErrorMessage = normalizedError?.message ?? null;

    let backoffMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, this.consecutiveFailures - 1));
    if (error instanceof VectorUnauthorizedError) {
      backoffMs = Math.max(backoffMs, 5 * 60_000);
    }
    if (error instanceof VectorBadResponseError) {
      backoffMs = Math.max(backoffMs, 60_000);
    }

    this.unavailableUntilMs = now + backoffMs;
    if (!wasAvailable) {
      return;
    }

    logger.warn(
      { error, operation, backoffMs, consecutiveFailures: this.consecutiveFailures },
      "Vector request failed; temporarily disabling vector service",
    );
  }
}
