import { RawItemModel } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Inject, Injectable, forwardRef } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { MongoOutboxStatus, MongoOutboxType, Prisma } from "@prisma/client";
import { Types } from "mongoose";
import { z } from "zod";

import { ItemStatus } from "../../common/pipeline-status";
import { toPrismaJsonValue } from "../../common/prisma-json";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";
import {
  NormalizedNewsPayload,
  NormalizedNewsPayloadSchema,
} from "../news-pipeline/news-pipeline.schema";

import { ItemsService } from "./items.service";

const logger = createLogger({ name: "raw-item-outbox" });
const RAW_ITEM_OUTBOX_LOCK_KEY = "cron:raw-item-outbox";
const RAW_ITEM_OUTBOX_LOCK_TTL_MS = 55_000;

const RawItemOutboxPayloadSchema = z.object({
  type: z.literal(MongoOutboxType.raw_item),
  orgId: z.string().trim().min(1),
  itemMetaId: z.string().trim().min(1),
  rawItemId: z.string().trim().min(1),
  source: z.string().trim().min(1),
  payload: NormalizedNewsPayloadSchema,
});

type RawItemOutboxPayload = z.infer<typeof RawItemOutboxPayloadSchema>;

interface RawItemOutboxEntryRow {
  id: string;
  orgId: string;
  payload: Prisma.JsonValue | null;
  status: MongoOutboxStatus;
  attempts: number | null;
  createdAt: Date;
}

@Injectable()
export class RawItemOutboxService {
  private readonly outboxBatchSize = 50;
  private readonly outboxStaleLockMs = 5 * 60_000;
  private readonly outboxRetryBaseDelayMs = 30_000;
  private readonly outboxMaxAttempts = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    @Inject(forwardRef(() => ItemsService))
    private readonly itemsService: ItemsService,
  ) {}

  async enqueueWrite(
    tx: Prisma.TransactionClient,
    input: {
      orgId: string;
      itemMetaId: string;
      rawItemId: string;
      source: string;
      payload: NormalizedNewsPayload;
    },
  ): Promise<string> {
    const entry = await tx.mongoOutbox.create({
      data: {
        orgId: input.orgId,
        type: MongoOutboxType.raw_item,
        status: MongoOutboxStatus.pending,
        availableAt: new Date(),
        payload: toPrismaJsonValue({
          type: MongoOutboxType.raw_item,
          orgId: input.orgId,
          itemMetaId: input.itemMetaId,
          rawItemId: input.rawItemId,
          source: input.source,
          payload: input.payload,
        }),
      },
      select: { id: true },
    });
    return entry.id;
  }

  async deliverNow(outboxId: string): Promise<boolean> {
    const entry = await this.prisma.mongoOutbox.findUnique({
      where: { id: outboxId },
      select: {
        id: true,
        orgId: true,
        payload: true,
        status: true,
        attempts: true,
        createdAt: true,
      },
    });
    if (!entry) {
      return false;
    }
    return this.deliverEntry(entry);
  }

  async deliverPendingForItemMeta(orgId: string, itemMetaId: string): Promise<void> {
    const entries = await this.prisma.mongoOutbox.findMany({
      where: {
        orgId,
        type: MongoOutboxType.raw_item,
        status: {
          in: [MongoOutboxStatus.pending, MongoOutboxStatus.failed, MongoOutboxStatus.processing],
        },
      },
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

    for (const entry of entries) {
      const payload = this.parseOutboxPayload(entry.payload);
      if (!payload || payload.itemMetaId !== itemMetaId) {
        continue;
      }
      await this.deliverEntry(entry);
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async retryPendingRawItemOutbox() {
    await this.cache.withLock(
      RAW_ITEM_OUTBOX_LOCK_KEY,
      RAW_ITEM_OUTBOX_LOCK_TTL_MS,
      async () => {
        const now = new Date();
        const staleLockCutoff = new Date(now.getTime() - this.outboxStaleLockMs);
        try {
          const entries = await this.fetchRetryEntries(now, staleLockCutoff);
          for (const entry of entries) {
            await this.deliverEntry(entry);
          }
        } catch (error) {
          logger.warn({ error }, "Failed to process raw-item outbox batch");
        }
      },
    );
  }

  private async deliverEntry(entry: RawItemOutboxEntryRow): Promise<boolean> {
    const payload = this.parseOutboxPayload(entry.payload);
    if (!payload || payload.orgId !== entry.orgId) {
      await this.markOutboxDead(
        entry.id,
        (entry.attempts ?? 0) + 1,
        new Error("Invalid raw-item outbox payload"),
      );
      return false;
    }

    const claimed = await this.claimOutboxEntry(entry.id, entry.status);
    if (!claimed) {
      return false;
    }

    try {
      await this.writeRawItemFromPayload(payload);
      await this.itemsService.applyRawItemPersisted(
        payload.orgId,
        payload.itemMetaId,
        payload.rawItemId,
      );
      await this.prisma.mongoOutbox.delete({ where: { id: entry.id } });
      return true;
    } catch (error) {
      const attempts = claimed.attempts ?? 1;
      logger.warn(
        { error, outboxId: entry.id, itemMetaId: payload.itemMetaId, rawItemId: payload.rawItemId },
        "Raw-item outbox delivery failed",
      );
      await this.markOutboxFailure(entry.id, attempts, error, payload);
      return false;
    }
  }

  private async writeRawItemFromPayload(payload: RawItemOutboxPayload) {
    if (!Types.ObjectId.isValid(payload.rawItemId)) {
      throw new Error("Invalid rawItemId in outbox payload");
    }
    const rawItemObjectId = new Types.ObjectId(payload.rawItemId);
    try {
      await RawItemModel.create({
        _id: rawItemObjectId,
        itemMetaId: payload.itemMetaId,
        payload: payload.payload,
        source: payload.source,
      });
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        const existing = await RawItemModel.findById(rawItemObjectId);
        if (existing) {
          return existing;
        }
      }
      throw error;
    }
    return null;
  }

  private parseOutboxPayload(payload: Prisma.JsonValue | null): RawItemOutboxPayload | null {
    const parsed = RawItemOutboxPayloadSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  }

  private async claimOutboxEntry(outboxId: string, status: MongoOutboxStatus) {
    const now = new Date();
    const staleLockCutoff = new Date(now.getTime() - this.outboxStaleLockMs);
    const eligibilityWhere =
      status === MongoOutboxStatus.processing
        ? {
            id: outboxId,
            type: MongoOutboxType.raw_item,
            status,
            lockedAt: { lt: staleLockCutoff },
          }
        : {
            id: outboxId,
            type: MongoOutboxType.raw_item,
            status,
            availableAt: { lte: now },
          };

    return this.prisma.runInTransaction(async (tx) => {
      const updated = await tx.mongoOutbox.updateMany({
        where: eligibilityWhere,
        data: {
          status: MongoOutboxStatus.processing,
          lockedAt: now,
          attempts: { increment: 1 },
          lastError: null,
        },
      });
      if (updated.count === 0) {
        return null;
      }
      return tx.mongoOutbox.findUnique({ where: { id: outboxId } });
    });
  }

  private async fetchRetryEntries(now: Date, staleLockCutoff: Date): Promise<RawItemOutboxEntryRow[]> {
    const [pending, failed, staleProcessing] = await Promise.all([
      this.findEntriesForRetry({
        type: MongoOutboxType.raw_item,
        status: MongoOutboxStatus.pending,
        availableAt: { lte: now },
      }),
      this.findEntriesForRetry({
        type: MongoOutboxType.raw_item,
        status: MongoOutboxStatus.failed,
        availableAt: { lte: now },
      }),
      this.findEntriesForRetry({
        type: MongoOutboxType.raw_item,
        status: MongoOutboxStatus.processing,
        lockedAt: { lt: staleLockCutoff },
      }),
    ]);

    return this.mergeRetryEntries([pending, failed, staleProcessing], this.outboxBatchSize);
  }

  private findEntriesForRetry(where: Prisma.MongoOutboxWhereInput): Promise<RawItemOutboxEntryRow[]> {
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
        createdAt: true,
      },
    });
  }

  private mergeRetryEntries(groups: RawItemOutboxEntryRow[][], take: number): RawItemOutboxEntryRow[] {
    const merged = new Map<string, RawItemOutboxEntryRow>();
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

  private async markOutboxFailure(
    outboxId: string,
    attempts: number,
    error: unknown,
    payload: RawItemOutboxPayload,
  ) {
    if (attempts >= this.outboxMaxAttempts) {
      await this.markOutboxDead(outboxId, attempts, error, payload);
      return;
    }

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
          attempts: Math.max(attempts, 1),
        },
      });
    } catch (updateError) {
      logger.warn(
        { error: updateError, outboxId, message },
        "Failed to update raw-item outbox status after delivery error",
      );
    }
  }

  private async markOutboxDead(
    outboxId: string,
    attempts: number,
    error: unknown,
    payload?: RawItemOutboxPayload,
  ) {
    const message = error instanceof Error ? error.message : String(error);

    try {
      await this.prisma.mongoOutbox.update({
        where: { id: outboxId },
        data: {
          status: MongoOutboxStatus.dead,
          lastError: message,
          availableAt: new Date(),
          lockedAt: null,
          attempts: Math.max(attempts, 1),
        },
      });
    } catch (updateError) {
      logger.warn(
        { error: updateError, outboxId, message },
        "Failed to mark raw-item outbox dead",
      );
    }

    if (!payload) {
      return;
    }

    try {
      await this.prisma.itemMeta.updateMany({
        where: {
          id: payload.itemMetaId,
          orgId: payload.orgId,
          mongoRef: payload.rawItemId,
        },
        data: { status: ItemStatus.Failed },
      });
    } catch (compensateError) {
      logger.warn(
        {
          error: compensateError,
          outboxId,
          itemMetaId: payload.itemMetaId,
          rawItemId: payload.rawItemId,
        },
        "Failed to mark ItemMeta failed after raw-item outbox dead letter",
      );
    }
  }

  private isDuplicateKeyError(error: unknown) {
    return Boolean(
      error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: number }).code === 11000,
    );
  }

  private computeBackoffDelay(baseDelayMs: number, attempt: number, maxAttempts: number) {
    const exponentialDelay = baseDelayMs * 2 ** Math.max(Math.min(attempt, maxAttempts) - 1, 0);
    const jitterFactor = 0.5 + Math.random();
    return Math.round(exponentialDelay * jitterFactor);
  }
}
