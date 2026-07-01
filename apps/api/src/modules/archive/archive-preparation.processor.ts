import { createLogger, ensureTraceId, runWithTraceId } from '@modular/utils';
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, QueueEvents, Worker } from 'bullmq';

import { ArchivePreparationSettingsService } from '../system-settings/archive-preparation-settings.service';

import { ArchivePreparationQueueService } from './archive-preparation-queue.service';
import {
  ARCHIVE_PREPARATION_QUEUE,
  ARCHIVE_PREPARATION_QUEUE_EVENTS,
  ARCHIVE_PREPARATION_QUEUE_NAME,
} from './archive-preparation.constants';
import type { ArchivePreparationJobPayload } from './archive-preparation.types';
import { ArchiveService } from './archive.service';

const logger = createLogger({ name: 'archive-preparation-processor' });

@Injectable()
export class ArchivePreparationProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<ArchivePreparationJobPayload>;
  private readonly handleQueueFailed = (event: { jobId: string; failedReason?: string }) => {
    logger.warn({ jobId: event.jobId, failedReason: event.failedReason }, 'Archive preparation queue event failed');
  };

  constructor(
    private readonly archiveService: ArchiveService,
    private readonly queueService: ArchivePreparationQueueService,
    private readonly settings: ArchivePreparationSettingsService,
    @Inject(ARCHIVE_PREPARATION_QUEUE)
    private readonly queue: Queue<ArchivePreparationJobPayload>,
    @Inject(ARCHIVE_PREPARATION_QUEUE_EVENTS)
    private readonly events: QueueEvents,
  ) {}

  async onModuleInit() {
    this.worker = new Worker<ArchivePreparationJobPayload>(
      ARCHIVE_PREPARATION_QUEUE_NAME,
      async (job) => {
        const traceId = ensureTraceId(job.data.traceId);
        return runWithTraceId(traceId, async () => {
          logger.info({ jobId: job.id, scope: job.data.scope }, 'Processing archive preparation job');
          await this.queueService.markProcessing(job.data);
          await this.processJob(job.data);
          await this.queueService.markReady(job.data);
        });
      },
      {
        connection: this.queue.opts.connection,
        concurrency: 1,
      },
    );

    this.worker.on('failed', async (job, error) => {
      logger.error({ jobId: job?.id, error, scope: job?.data?.scope }, 'Archive preparation worker failed');
      if (job?.data) {
        await this.queueService.markFailed(
          job.data,
          error instanceof Error ? error.message : String(error),
        );
      }
    });

    this.events.on('failed', this.handleQueueFailed);
  }

  async onModuleDestroy() {
    this.events.off('failed', this.handleQueueFailed);
    await this.worker?.close();
  }

  private async processJob(payload: ArchivePreparationJobPayload): Promise<void> {
    const runtime = await this.settings.getEffectiveSettings();
    for (;;) {
      const selection =
        payload.scope === 'digest'
          ? await this.archiveService.getMissingRecentClassificationBatch(
              payload.orgId,
              new Date(
                `${payload.anchorDate ?? new Date().toISOString().slice(0, 10)}T23:59:59.999Z`,
              ),
              runtime.jobBatchSize,
            )
          : await this.archiveService.getMissingMonthClassificationBatch(
              payload.orgId,
              payload.month ?? new Date().toISOString().slice(0, 7),
              runtime.jobBatchSize,
            );

      if (selection.rows.length === 0) {
        return;
      }

      await this.archiveService.classifyRowsBatch(payload.orgId, selection.rows, {
        jobBatchSize: runtime.jobBatchSize,
        embeddingBatchSize: runtime.embeddingBatchSize,
        embeddingMaxConcurrency: runtime.embeddingMaxConcurrency,
        rerankMaxConcurrency: runtime.rerankMaxConcurrency,
      });

      if (!selection.hasMoreMissing) {
        await this.queueService.markPartial(payload);
        return;
      }

      await this.queueService.markPartial(payload);
    }
  }
}
