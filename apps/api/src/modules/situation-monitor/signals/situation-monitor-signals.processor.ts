import { createLogger } from '@modular/utils';
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Queue, QueueEvents, Worker } from 'bullmq';

import { EnvService } from '../../config/config.service';

import {
  OREF_POLL_JOB_NAME,
  SITUATION_MONITOR_SIGNALS_QUEUE,
  SITUATION_MONITOR_SIGNALS_QUEUE_EVENTS,
  SITUATION_MONITOR_SIGNALS_QUEUE_NAME,
  TELEGRAM_POLL_JOB_NAME,
} from './situation-monitor-signals.constants';
import { SituationMonitorSignalsService } from './situation-monitor-signals.service';

interface SituationMonitorSignalsJobPayload {
  type: 'poll';
  source: 'telegram' | 'oref';
}

const logger = createLogger({ name: 'situation-monitor-signals-worker' });

@Injectable()
export class SituationMonitorSignalsProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<SituationMonitorSignalsJobPayload>;

  constructor(
    private readonly env: EnvService,
    private readonly signals: SituationMonitorSignalsService,
    @Inject(SITUATION_MONITOR_SIGNALS_QUEUE)
    private readonly queue: Queue<SituationMonitorSignalsJobPayload>,
    @Inject(SITUATION_MONITOR_SIGNALS_QUEUE_EVENTS)
    private readonly events: QueueEvents,
  ) {}

  async onModuleInit() {
    await this.ensureRepeatableJobs();

    this.worker = new Worker<SituationMonitorSignalsJobPayload>(
      SITUATION_MONITOR_SIGNALS_QUEUE_NAME,
      async (job) => {
        await this.processJob(job);
      },
      {
        connection: this.queue.opts.connection,
        concurrency: 1,
      },
    );

    this.worker.on('failed', (job, error) => {
      logger.warn({ error, jobId: job?.id, name: job?.name }, 'Situation monitor signals worker failed');
    });

    this.events.on('failed', (event) => {
      logger.warn({ event }, 'Situation monitor signals queue event failed');
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  private async processJob(job: Job<SituationMonitorSignalsJobPayload>) {
    const source = job.data?.source;
    if (source === 'telegram') {
      await this.signals.runJob(TELEGRAM_POLL_JOB_NAME);
      return;
    }

    if (source === 'oref') {
      await this.signals.runJob(OREF_POLL_JOB_NAME);
      return;
    }

    if (job.name.startsWith(TELEGRAM_POLL_JOB_NAME)) {
      await this.signals.runJob(TELEGRAM_POLL_JOB_NAME);
      return;
    }

    if (job.name.startsWith(OREF_POLL_JOB_NAME)) {
      await this.signals.runJob(OREF_POLL_JOB_NAME);
    }
  }

  private async ensureRepeatableJobs() {
    const telegramIntervalMs = this.readNumberEnv(
      'SITUATION_MONITOR_TELEGRAM_POLL_INTERVAL_MS',
      60_000,
      15_000,
    );
    const orefIntervalMs = this.readNumberEnv(
      'SITUATION_MONITOR_OREF_POLL_INTERVAL_MS',
      300_000,
      30_000,
    );

    await this.queue.add(
      TELEGRAM_POLL_JOB_NAME,
      { type: 'poll', source: 'telegram' },
      {
        jobId: `${TELEGRAM_POLL_JOB_NAME}:repeat`,
        removeOnComplete: true,
        removeOnFail: false,
        repeat: {
          every: telegramIntervalMs,
        },
      },
    );

    await this.queue.add(
      OREF_POLL_JOB_NAME,
      { type: 'poll', source: 'oref' },
      {
        jobId: `${OREF_POLL_JOB_NAME}:repeat`,
        removeOnComplete: true,
        removeOnFail: false,
        repeat: {
          every: orefIntervalMs,
        },
      },
    );

    // Fast first run.
    await Promise.allSettled([
      this.queue.add(
        `${TELEGRAM_POLL_JOB_NAME}:bootstrap`,
        { type: 'poll', source: 'telegram' },
        { removeOnComplete: true, removeOnFail: false },
      ),
      this.queue.add(
        `${OREF_POLL_JOB_NAME}:bootstrap`,
        { type: 'poll', source: 'oref' },
        { removeOnComplete: true, removeOnFail: false },
      ),
    ]);
  }

  private readNumberEnv(key: string, fallback: number, min: number): number {
    const raw = this.env.get<number | string | undefined>(key, { infer: true }) ?? process.env[key];
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(min, Math.floor(parsed));
  }
}
