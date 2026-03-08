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

interface StoredArchivePreparationStatusRecord
  extends ArchivePreparationStatusRecord {
  orgId: string;
}

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

  async getOperationalStatus(
    orgId: string,
  ): Promise<ArchivePreparationOperationalStatus> {
    const recentStatuses = await this.getRecentStatuses(orgId, 10);
    const counts = await this.getScopedCounts(orgId);
    const pending = counts.waiting + counts.active + counts.delayed;
    return {
      updatedAt: new Date().toISOString(),
      pending,
      counts,
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
      if (message.includes('already exists')) {
        return;
      }

      this.logger.error(
        { error, jobId, payload },
        'Failed to enqueue archive preparation job',
      );
      throw error;
    }

    try {
      await this.setStatus(payload, ArchivePreparationState.QUEUED);
    } catch (error) {
      this.logger.warn(
        { error, jobId, payload },
        'Queued archive preparation job but failed to persist queued status',
      );
    }
  }

  private async getStatus(
    scope: ArchivePreparationScope,
    orgId: string,
    scopeValue: string,
  ): Promise<ArchivePreparationStatus | null> {
    const record = await this.cache.get<StoredArchivePreparationStatusRecord>(
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
    const record: StoredArchivePreparationStatusRecord = {
      orgId: payload.orgId,
      scope: payload.scope,
      scopeValue,
      state,
      updatedAt: new Date().toISOString(),
      ...(errorMessage ? { errorMessage } : {}),
    };
    await this.cache.set<StoredArchivePreparationStatusRecord>(
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
    orgId: string,
    limit: number,
  ): Promise<ArchivePreparationStatusRecord[]> {
    const records = await this.getScopedStatusRecords(orgId);
    return records.slice(0, limit).map((record) => this.toPublicStatusRecord(record));
  }

  private async getScopedCounts(orgId: string): Promise<ArchivePreparationOperationalStatus['counts']> {
    const records = await this.getScopedStatusRecords(orgId);
    return records.reduce<ArchivePreparationOperationalStatus['counts']>(
      (counts, record) => {
        switch (record.state) {
          case ArchivePreparationState.QUEUED:
            counts.waiting += 1;
            break;
          case ArchivePreparationState.PROCESSING:
          case ArchivePreparationState.PARTIAL:
            counts.active += 1;
            break;
          case ArchivePreparationState.READY:
            counts.completed += 1;
            break;
          case ArchivePreparationState.FAILED:
            counts.failed += 1;
            break;
          default:
            break;
        }
        return counts;
      },
      {
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
      },
    );
  }

  private async getScopedStatusRecords(
    orgId: string,
  ): Promise<StoredArchivePreparationStatusRecord[]> {
    const total = await this.cache.zcard(ARCHIVE_PREPARATION_STATUS_INDEX_KEY);
    if (total <= 0) {
      return [];
    }

    const keys = await this.cache.zrange(
      ARCHIVE_PREPARATION_STATUS_INDEX_KEY,
      0,
      total - 1,
    );
    const records = await this.cache.getMany<StoredArchivePreparationStatusRecord>(keys);

    return keys
      .map((key, index) => this.normalizeStatusRecord(key, records[index]))
      .filter(
        (record): record is StoredArchivePreparationStatusRecord => record != null,
      )
      .filter((record) => record.orgId === orgId)
      .reverse();
  }

  private normalizeStatusRecord(
    statusKey: string,
    record: StoredArchivePreparationStatusRecord | null | undefined,
  ): StoredArchivePreparationStatusRecord | null {
    if (!record) {
      return null;
    }

    const orgId = record.orgId ?? this.parseOrgIdFromStatusKey(statusKey);
    if (!orgId) {
      return null;
    }

    return {
      ...record,
      orgId,
    };
  }

  private toPublicStatusRecord(
    record: StoredArchivePreparationStatusRecord,
  ): ArchivePreparationStatusRecord {
    return {
      scope: record.scope,
      scopeValue: record.scopeValue,
      state: record.state,
      updatedAt: record.updatedAt,
      errorMessage: record.errorMessage ?? null,
    };
  }

  private parseOrgIdFromStatusKey(statusKey: string): string | null {
    const segments = statusKey.split(':');
    return segments.length >= 6 ? segments[4] ?? null : null;
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
