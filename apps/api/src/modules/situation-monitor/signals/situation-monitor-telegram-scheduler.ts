import type { Queue } from 'bullmq';

import { BULLMQ_FAILED_JOB_RETENTION } from '../../../common/bullmq-retention';

import {
  TELEGRAM_POLL_JOB_NAME,
} from './situation-monitor-signals.constants';

export const TELEGRAM_POLL_SCHEDULER_ID = `${TELEGRAM_POLL_JOB_NAME}:scheduler`;

export interface TelegramSchedulerJobPayload {
  type: 'poll';
  source: string;
}

export async function removeLegacyTelegramRepeatJobs(
  queue: Queue<TelegramSchedulerJobPayload>,
): Promise<void> {
  const repeatableJobs = await queue.getRepeatableJobs(0, -1, true);
  await Promise.all(
    repeatableJobs
      .filter((job) => job.name === TELEGRAM_POLL_JOB_NAME)
      .map((job) => queue.removeRepeatableByKey(job.key)),
  );
}

export async function upsertTelegramPollScheduler(
  queue: Queue<TelegramSchedulerJobPayload>,
  intervalMs: number,
): Promise<void> {
  await queue.upsertJobScheduler(
    TELEGRAM_POLL_SCHEDULER_ID,
    { every: Math.max(15_000, Math.floor(intervalMs)) },
    {
      name: TELEGRAM_POLL_JOB_NAME,
      data: { type: 'poll', source: 'telegram' },
      opts: {
        removeOnComplete: true,
        removeOnFail: BULLMQ_FAILED_JOB_RETENTION,
      },
    },
  );
}

export async function removeTelegramPollScheduler(
  queue: Queue<TelegramSchedulerJobPayload>,
): Promise<void> {
  await queue.removeJobScheduler(TELEGRAM_POLL_SCHEDULER_ID);
}

export async function removeQueuedTelegramPollJobs(
  queue: Queue<TelegramSchedulerJobPayload>,
): Promise<void> {
  const pendingJobs = await queue.getJobs(
    ['wait', 'waiting', 'prioritized', 'delayed'],
    0,
    -1,
    true,
  );
  await Promise.allSettled(
    pendingJobs
      .filter((job) => job.name.startsWith(TELEGRAM_POLL_JOB_NAME))
      .map(async (job) => {
        await job.remove();
      }),
  );
}
