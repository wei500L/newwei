import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { AuditLogOutboxStatus, Prisma } from "@prisma/client";

import { settleWithConcurrency } from "../../common/multi-tenant-scheduler";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

const logger = createLogger({ name: "audit-log-outbox" });
const AUDIT_LOG_OUTBOX_DELIVERY_CONCURRENCY = 8;
const AUDIT_LOG_OUTBOX_LOCK_KEY = "cron:audit-log-outbox";
const AUDIT_LOG_OUTBOX_LOCK_TTL_MS = 55_000;

interface AuditLogOutboxPayload {
  orgId: string;
  actorId?: string | null;
  resource: string;
  action: string;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string | null;
  createdAt: string;
}

interface NormalizedAuditLogOutboxPayload {
  orgId: string;
  actorId: string | null;
  resource: string;
  action: string;
  metadata: Prisma.InputJsonValue | undefined;
  ipAddress: string | null;
  createdAt: Date;
}

interface AuditLogOutboxEntryRow {
  id: string;
  orgId: string;
  payload: Prisma.JsonValue;
  status: AuditLogOutboxStatus;
  attempts: number | null;
  createdAt: Date;
}

@Injectable()
export class AuditLogOutboxService {
  private readonly outboxBatchSize = 200;
  private readonly outboxStaleLockMs = 5 * 60_000;
  private readonly outboxRetryBaseDelayMs = 30_000;
  private readonly outboxMaxAttempts = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async retryPendingAuditLogOutbox() {
    const locked = await this.cache.withLock(
      AUDIT_LOG_OUTBOX_LOCK_KEY,
      AUDIT_LOG_OUTBOX_LOCK_TTL_MS,
      async () => {
        const now = new Date();
        const staleLockCutoff = new Date(
          now.getTime() - this.outboxStaleLockMs,
        );

        try {
          const entries = await this.fetchRetryEntries(now, staleLockCutoff);

          const results = await settleWithConcurrency(
            entries,
            AUDIT_LOG_OUTBOX_DELIVERY_CONCURRENCY,
            async (entry) => {
              const payload = this.parseOutboxPayload(entry.payload);
              if (!payload || payload.orgId !== entry.orgId) {
                await this.markOutboxDead(
                  entry.id,
                  (entry.attempts ?? 0) + 1,
                  new Error("Invalid outbox payload"),
                );
                return;
              }

              await this.deliverOutboxPayload(entry.id, entry.status, payload);
            },
          );

          for (const result of results) {
            if (result.status === "fulfilled") {
              continue;
            }
            logger.warn(
              {
                err: result.reason,
                outboxId: result.item.id,
                orgId: result.item.orgId,
              },
              "Failed to process audit log outbox entry",
            );
          }
        } catch (error) {
          logger.warn(
            { err: error },
            "Failed to process audit log outbox batch",
          );
        }
      },
    );

    if (locked === null) {
      logger.info(
        "Skipped audit log outbox batch because previous batch is still in progress",
      );
    }
  }

  private parseOutboxPayload(
    payload: Prisma.JsonValue,
  ): NormalizedAuditLogOutboxPayload | null {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }

    const raw = payload as Partial<AuditLogOutboxPayload> &
      Record<string, unknown>;
    if (typeof raw.orgId !== "string" || !raw.orgId.trim()) {
      return null;
    }
    if (typeof raw.resource !== "string" || !raw.resource.trim()) {
      return null;
    }
    if (typeof raw.action !== "string" || !raw.action.trim()) {
      return null;
    }
    if (typeof raw.createdAt !== "string" || !raw.createdAt.trim()) {
      return null;
    }

    const createdAt = new Date(raw.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      return null;
    }

    const actorId =
      raw.actorId === null
        ? null
        : typeof raw.actorId === "string"
          ? raw.actorId
          : null;
    const ipAddress =
      raw.ipAddress === null
        ? null
        : typeof raw.ipAddress === "string"
          ? raw.ipAddress
          : null;
    const metadata =
      "metadata" in raw ? (raw.metadata as Prisma.InputJsonValue) : undefined;

    return {
      orgId: raw.orgId,
      actorId,
      resource: raw.resource,
      action: raw.action,
      metadata,
      ipAddress,
      createdAt,
    };
  }

  private async deliverOutboxPayload(
    outboxId: string,
    status: AuditLogOutboxStatus,
    payload: NormalizedAuditLogOutboxPayload,
  ) {
    const claimed = await this.claimOutboxEntry(outboxId, status);
    if (!claimed) {
      return;
    }

    try {
      // At-least-once delivery: the audit row is created before the outbox
      // row is deleted, so a failure between the two leaves the entry for a
      // retry. Re-delivery must not insert a duplicate audit row — dedupe by
      // the exact payload identity (createdAt is written with ms precision).
      const existing = await this.prisma.auditLog.findFirst({
        where: {
          orgId: payload.orgId,
          actorId: payload.actorId ?? null,
          resource: payload.resource,
          action: payload.action,
          createdAt: payload.createdAt,
        },
        select: { id: true },
      });
      if (!existing) {
        await this.prisma.auditLog.create({
          data: {
            orgId: payload.orgId,
            actorId: payload.actorId,
            resource: payload.resource,
            action: payload.action,
            metadata: payload.metadata,
            ipAddress: payload.ipAddress,
            createdAt: payload.createdAt,
          },
        });
      }
      await this.prisma.auditLogOutbox.delete({ where: { id: outboxId } });
    } catch (error) {
      const attempts = claimed?.attempts ?? 1;
      logger.warn(
        { err: error, outboxId, orgId: payload.orgId },
        "Audit log outbox delivery failed",
      );
      await this.markOutboxFailure(outboxId, attempts, error);
    }
  }

  private async claimOutboxEntry(
    outboxId: string,
    status: AuditLogOutboxStatus,
  ) {
    const now = new Date();
    const staleLockCutoff = new Date(now.getTime() - this.outboxStaleLockMs);
    const eligibilityWhere =
      status === AuditLogOutboxStatus.processing
        ? {
            id: outboxId,
            status,
            lockedAt: { lt: staleLockCutoff },
          }
        : {
            id: outboxId,
            status,
            availableAt: { lte: now },
          };

    return this.prisma.runInTransaction(async (tx) => {
      const updated = await tx.auditLogOutbox.updateMany({
        where: eligibilityWhere,
        data: {
          status: AuditLogOutboxStatus.processing,
          lockedAt: now,
          attempts: { increment: 1 },
          lastError: null,
        },
      });

      if (updated.count === 0) {
        return null;
      }

      return tx.auditLogOutbox.findUnique({ where: { id: outboxId } });
    });
  }

  private async fetchRetryEntries(
    now: Date,
    staleLockCutoff: Date,
  ): Promise<AuditLogOutboxEntryRow[]> {
    const [pending, failed, staleProcessing] = await Promise.all([
      this.findEntriesForRetry({
        status: AuditLogOutboxStatus.pending,
        availableAt: { lte: now },
      }),
      this.findEntriesForRetry({
        status: AuditLogOutboxStatus.failed,
        availableAt: { lte: now },
      }),
      this.findEntriesForRetry({
        status: AuditLogOutboxStatus.processing,
        lockedAt: { lt: staleLockCutoff },
      }),
    ]);

    return this.mergeRetryEntries(
      [pending, failed, staleProcessing],
      this.outboxBatchSize,
    );
  }

  private findEntriesForRetry(
    where: Prisma.AuditLogOutboxWhereInput,
  ): Promise<AuditLogOutboxEntryRow[]> {
    return this.prisma.auditLogOutbox.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: this.outboxBatchSize,
      select: {
        id: true,
        orgId: true,
        payload: true,
        status: true,
        attempts: true,
        createdAt: true,
      },
    });
  }

  private mergeRetryEntries(
    groups: AuditLogOutboxEntryRow[][],
    take: number,
  ): AuditLogOutboxEntryRow[] {
    const merged = new Map<string, AuditLogOutboxEntryRow>();
    for (const group of groups) {
      for (const entry of group) {
        if (!merged.has(entry.id)) {
          merged.set(entry.id, entry);
        }
      }
    }

    return Array.from(merged.values())
      .sort((left, right) => {
        const createdDelta =
          left.createdAt.getTime() - right.createdAt.getTime();
        if (createdDelta !== 0) {
          return createdDelta;
        }
        return left.id.localeCompare(right.id);
      })
      .slice(0, take);
  }

  private async markOutboxFailure(
    outboxId: string,
    attempts: number,
    error: unknown,
  ) {
    const message = error instanceof Error ? error.message : String(error);
    if (attempts >= this.outboxMaxAttempts) {
      await this.markOutboxDead(outboxId, attempts, error);
      return;
    }

    const nextDelay = this.computeBackoffDelay(
      this.outboxRetryBaseDelayMs,
      attempts,
      5,
    );
    const availableAt = new Date(Date.now() + nextDelay);

    try {
      await this.prisma.auditLogOutbox.update({
        where: { id: outboxId },
        data: {
          status: AuditLogOutboxStatus.failed,
          lastError: message,
          availableAt,
          lockedAt: null,
          attempts: Math.max(attempts, 1),
        },
      });
    } catch (updateError) {
      logger.warn(
        { err: updateError, outboxId, message },
        "Failed to update audit log outbox status after delivery error",
      );
    }
  }

  private async markOutboxDead(
    outboxId: string,
    attempts: number,
    error: unknown,
  ) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await this.prisma.auditLogOutbox.update({
        where: { id: outboxId },
        data: {
          status: AuditLogOutboxStatus.dead,
          lastError: message,
          availableAt: new Date(),
          lockedAt: null,
          attempts: Math.max(attempts, 1),
        },
      });
    } catch (updateError) {
      logger.warn(
        { err: updateError, outboxId, message },
        "Failed to mark audit log outbox dead",
      );
    }
  }

  private computeBackoffDelay(
    baseDelayMs: number,
    attempt: number,
    maxAttempts: number,
  ) {
    const exponentialDelay =
      baseDelayMs * 2 ** Math.max(Math.min(attempt, maxAttempts) - 1, 0);
    const jitterFactor = 0.5 + Math.random();
    return Math.round(exponentialDelay * jitterFactor);
  }
}
