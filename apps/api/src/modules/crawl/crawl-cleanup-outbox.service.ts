import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { MongoOutboxStatus, MongoOutboxType, Prisma } from "@prisma/client";

import { PrismaService } from "../config/prisma.service";

import { CrawlResultService } from "./crawl-result.service";

const logger = createLogger({ name: "crawl-cleanup-outbox" });

interface CleanupCrawlResultsOutboxPayload {
  type: typeof MongoOutboxType.cleanup_crawl_results;
  taskId: string;
  orgId?: string;
}

interface CleanupOutboxEntryRow {
  id: string;
  orgId: string;
  payload: Prisma.JsonValue | null;
  status: MongoOutboxStatus;
  attempts: number | null;
  createdAt: Date;
}

@Injectable()
export class CrawlCleanupOutboxService {
  private readonly outboxBatchSize = 100;
  private readonly outboxStaleLockMs = 5 * 60_000;
  private readonly outboxRetryBaseDelayMs = 30_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly resultService: CrawlResultService
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async retryPendingCleanupOutbox() {
    const now = new Date();
    const staleLockCutoff = new Date(now.getTime() - this.outboxStaleLockMs);
    try {
      const entries = await this.fetchRetryEntries(now, staleLockCutoff);

      for (const entry of entries) {
        const payload = this.parseOutboxPayload(entry.payload);
        if (!payload || (payload.orgId && payload.orgId !== entry.orgId)) {
          await this.markOutboxFailure(
            entry.id,
            (entry.attempts ?? 0) + 1,
            new Error("Invalid outbox payload")
          );
          continue;
        }

        await this.deliverOutboxPayload(entry.id, entry.status, entry.orgId, payload.taskId);
      }
    } catch (error) {
      logger.warn({ error }, "Failed to process crawl cleanup outbox batch");
    }
  }

  private parseOutboxPayload(payload: Prisma.JsonValue | null): CleanupCrawlResultsOutboxPayload | null {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }

    const raw = payload as Record<string, unknown>;
    if (raw.type !== MongoOutboxType.cleanup_crawl_results) {
      return null;
    }

    if (typeof raw.taskId !== "string" || !raw.taskId.trim()) {
      return null;
    }

    const orgId = typeof raw.orgId === "string" && raw.orgId.trim() ? raw.orgId : undefined;
    return { type: MongoOutboxType.cleanup_crawl_results, taskId: raw.taskId, orgId };
  }

  private async deliverOutboxPayload(
    outboxId: string,
    status: MongoOutboxStatus,
    orgId: string,
    taskId: string
  ) {
    const claimed = await this.claimOutboxEntry(outboxId, status);
    if (!claimed) {
      return;
    }

    try {
      await this.resultService.deleteTaskResults(taskId, orgId);
      await this.prisma.mongoOutbox.delete({ where: { id: outboxId } });
    } catch (error) {
      const attempts = claimed?.attempts ?? 1;
      logger.warn({ error, outboxId, taskId, orgId }, "Crawl cleanup outbox delivery failed");
      await this.markOutboxFailure(outboxId, attempts, error);
    }
  }

  private async claimOutboxEntry(outboxId: string, status: MongoOutboxStatus) {
    const now = new Date();
    const staleLockCutoff = new Date(now.getTime() - this.outboxStaleLockMs);
    const eligibilityWhere =
      status === MongoOutboxStatus.processing
        ? {
            id: outboxId,
            type: MongoOutboxType.cleanup_crawl_results,
            status,
            lockedAt: { lt: staleLockCutoff }
          }
        : {
            id: outboxId,
            type: MongoOutboxType.cleanup_crawl_results,
            status,
            availableAt: { lte: now }
          };
    return this.prisma.runInTransaction(async (tx) => {
      const updated = await tx.mongoOutbox.updateMany({
        where: eligibilityWhere,
        data: {
          status: MongoOutboxStatus.processing,
          lockedAt: now,
          attempts: { increment: 1 },
          lastError: null
        }
      });

      if (updated.count === 0) {
        return null;
      }

      return tx.mongoOutbox.findUnique({ where: { id: outboxId } });
    });
  }

  private async fetchRetryEntries(now: Date, staleLockCutoff: Date): Promise<CleanupOutboxEntryRow[]> {
    const [pending, failed, staleProcessing] = await Promise.all([
      this.findEntriesForRetry({
        type: MongoOutboxType.cleanup_crawl_results,
        status: MongoOutboxStatus.pending,
        availableAt: { lte: now }
      }),
      this.findEntriesForRetry({
        type: MongoOutboxType.cleanup_crawl_results,
        status: MongoOutboxStatus.failed,
        availableAt: { lte: now }
      }),
      this.findEntriesForRetry({
        type: MongoOutboxType.cleanup_crawl_results,
        status: MongoOutboxStatus.processing,
        lockedAt: { lt: staleLockCutoff }
      })
    ]);

    return this.mergeRetryEntries([pending, failed, staleProcessing], this.outboxBatchSize);
  }

  private findEntriesForRetry(where: Prisma.MongoOutboxWhereInput): Promise<CleanupOutboxEntryRow[]> {
    return this.prisma.mongoOutbox.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: this.outboxBatchSize,
      select: {
        id: true,
        orgId: true,
        payload: true,
        status: true,
        attempts: true,
        createdAt: true
      }
    });
  }

  private mergeRetryEntries(groups: CleanupOutboxEntryRow[][], take: number): CleanupOutboxEntryRow[] {
    const merged = new Map<string, CleanupOutboxEntryRow>();
    for (const group of groups) {
      for (const entry of group) {
        if (!merged.has(entry.id)) {
          merged.set(entry.id, entry);
        }
      }
    }

    return Array.from(merged.values())
      .sort((left, right) => {
        const createdDelta = left.createdAt.getTime() - right.createdAt.getTime();
        if (createdDelta !== 0) {
          return createdDelta;
        }
        return left.id.localeCompare(right.id);
      })
      .slice(0, take);
  }

  private async markOutboxFailure(outboxId: string, attempts: number, error: unknown) {
    const nextDelay = this.computeBackoffDelay(this.outboxRetryBaseDelayMs, attempts, 5);
    const availableAt = new Date(Date.now() + nextDelay);
    const message = error instanceof Error ? error.message : String(error);

    try {
      await this.prisma.mongoOutbox.update({
        where: { id: outboxId },
        data: {
          status: MongoOutboxStatus.failed,
          lastError: message,
          availableAt,
          lockedAt: null,
          attempts: Math.max(attempts, 1)
        }
      });
    } catch (updateError) {
      logger.warn(
        { error: updateError, outboxId, message },
        "Failed to update crawl cleanup outbox status after delivery error"
      );
    }
  }

  private computeBackoffDelay(baseDelayMs: number, attempt: number, maxAttempts: number) {
    const exponentialDelay = baseDelayMs * 2 ** Math.max(Math.min(attempt, maxAttempts) - 1, 0);
    const jitterFactor = 0.5 + Math.random();
    return Math.round(exponentialDelay * jitterFactor);
  }
}
