import { createLogger, ensureTraceId, getCurrentTraceId } from '@modular/utils';
import { Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';

import { CacheService } from '../cache/cache.service';

import {
  ARCHIVE_PREPARATION_QUEUE,
  ARCHIVE_PREPARATION_QUEUE_NAME,
  ARCHIVE_PREPARATION_STATUS_INDEX_KEY,
  ARCHIVE_PREPARATION_STATUS_INDEX_MAX_ENTRIES,
  ARCHIVE_PREPARATION_STATUS_TTL_SECONDS,
} from './archive-preparation.constants';
import type {
  ArchivePreparationOperationalStatus,
  ArchivePreparationJobPayload,
  ArchivePreparationScope,
  ArchivePreparationStatusRecord,
} from './archive-preparation.types';
import { ArchivePreparationState, type ArchivePreparationStatus } from './archive.types';

@Injectable()
export class ArchivePreparationQueueService {
  private readonly logger = createLogger({ name: 'archive-preparation-queue' });

  constructor(
    @Inject(ARCHIVE_PREPARATION_QUEUE)
    private readonly queue: Queue<ArchivePreparationJobPayload>,
    private readonly cache: CacheService,
  ) {}

  async ensureDigestCoverage(orgId: string, anchorDate: string): Promise<void> {
    await this.ensureQueued({ scope: 'digest', orgId, anchorDate });
  }

  async ensureCalendarCoverage(orgId: string, month: string): Promise<void> {
    await this.ensureQueued({ scope: 'calendar', orgId, month });
  }

  async getDigestStatus(
    orgId: string,
    anchorDate: string,
  ): Promise<ArchivePreparationStatus | null> {
    return this.getStatus('digest', orgId, anchorDate);
  }

  async getOperationalStatus(): Promise<ArchivePreparationOperationalStatus> {
    const counts = await this.queue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
    );
    const pending =
      (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
    const recentStatuses = await this.getRecentStatuses(10);
    return {
      updatedAt: new Date().toISOString(),
      pending,
      counts: {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
      },
      recentStatuses,
    };
  }

  async markProcessing(payload: ArchivePreparationJobPayload): Promise<void> {
    await this.setStatus(payload, ArchivePreparationState.PROCESSING);
  }

  async markReady(payload: ArchivePreparationJobPayload): Promise<void> {
    await this.setStatus(payload, ArchivePreparationState.READY);
  }

  async markFailed(
    payload: ArchivePreparationJobPayload,
    errorMessage: string,
  ): Promise<void> {
    await this.setStatus(payload, ArchivePreparationState.FAILED, errorMessage);
  }

  async markPartial(payload: ArchivePreparationJobPayload): Promise<void> {
    await this.setStatus(payload, ArchivePreparationState.PARTIAL);
  }

  private async ensureQueued(payload: ArchivePreparationJobPayload): Promise<void> {
    const jobId = this.buildJobId(payload);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'waiting' || state === 'active' || state === 'delayed') {
        return;
      }
      await existing.remove();
    }

    await this.setStatus(payload, ArchivePreparationState.QUEUED);
    try {
      await this.queue.add(ARCHIVE_PREPARATION_QUEUE_NAME, {
        ...payload,
        traceId: ensureTraceId(getCurrentTraceId()),
      }, {
        jobId,
        removeOnComplete: {
          age: ARCHIVE_PREPARATION_STATUS_TTL_SECONDS,
          count: 1000,
        },
        removeOnFail: false,
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 15_000,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('already exists')) {
        this.logger.error({ error, jobId, payload }, 'Failed to enqueue archive preparation job');
        throw error;
      }
    }
  }

  private async getStatus(
    scope: ArchivePreparationScope,
    orgId: string,
    scopeValue: string,
  ): Promise<ArchivePreparationStatus | null> {
    const record = await this.cache.get<ArchivePreparationStatusRecord>(
      this.buildStatusKey(scope, orgId, scopeValue),
    );
    if (!record) {
      return null;
    }
    return {
      state: record.state,
      readyCount: 0,
      missingCount: 0,
      updatedAt: new Date(record.updatedAt),
      errorMessage: record.errorMessage ?? null,
    };
  }

  private async setStatus(
    payload: ArchivePreparationJobPayload,
    state: ArchivePreparationState,
    errorMessage?: string,
  ): Promise<void> {
    const scopeValue = this.resolveScopeValue(payload);
    const statusKey = this.buildStatusKey(payload.scope, payload.orgId, scopeValue);
    const record: ArchivePreparationStatusRecord = {
      scope: payload.scope,
      scopeValue,
      state,
      updatedAt: new Date().toISOString(),
      ...(errorMessage ? { errorMessage } : {}),
    };
    await this.cache.set<ArchivePreparationStatusRecord>(
      statusKey,
      record,
      ARCHIVE_PREPARATION_STATUS_TTL_SECONDS,
    );
    await this.cache.zadd(
      ARCHIVE_PREPARATION_STATUS_INDEX_KEY,
      Date.now(),
      statusKey,
    );
    await this.trimStatusIndex();
  }

  private async getRecentStatuses(
    limit: number,
  ): Promise<ArchivePreparationStatusRecord[]> {
    const total = await this.cache.zcard(ARCHIVE_PREPARATION_STATUS_INDEX_KEY);
    if (total <= 0) {
      return [];
    }
    const start = Math.max(0, total - limit);
    const keys = await this.cache.zrange(
      ARCHIVE_PREPARATION_STATUS_INDEX_KEY,
      start,
      total - 1,
    );
    const records = await this.cache.getMany<ArchivePreparationStatusRecord>(keys);
    return records.filter((value): value is ArchivePreparationStatusRecord => Boolean(value)).reverse();
  }

  private async trimStatusIndex(): Promise<void> {
    const total = await this.cache.zcard(ARCHIVE_PREPARATION_STATUS_INDEX_KEY);
    if (total <= ARCHIVE_PREPARATION_STATUS_INDEX_MAX_ENTRIES) {
      return;
    }
    const overflow = total - ARCHIVE_PREPARATION_STATUS_INDEX_MAX_ENTRIES;
    const keys = await this.cache.zrange(
      ARCHIVE_PREPARATION_STATUS_INDEX_KEY,
      0,
      overflow - 1,
    );
    if (keys.length === 0) {
      return;
    }
    await this.cache.zrem(ARCHIVE_PREPARATION_STATUS_INDEX_KEY, keys);
    await this.cache.delMany(keys);
  }

  private buildJobId(payload: ArchivePreparationJobPayload): string {
    return [payload.scope, payload.orgId, this.resolveScopeValue(payload)].join(':');
  }

  private buildStatusKey(
    scope: ArchivePreparationScope,
    orgId: string,
    scopeValue: string,
  ): string {
    return ['archive', 'preparation', 'status', scope, orgId, scopeValue].join(':');
  }

  private resolveScopeValue(payload: ArchivePreparationJobPayload): string {
    if (payload.scope === 'digest') {
      return payload.anchorDate ?? 'unknown';
    }
    return payload.month ?? 'unknown';
  }
}
