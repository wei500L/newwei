import type { KeepJobs } from "bullmq";

const SECONDS_PER_DAY = 24 * 60 * 60;

export const BULLMQ_FAILED_JOB_RETENTION: KeepJobs = {
  age: 7 * SECONDS_PER_DAY,
  count: 10_000,
};

export const BULLMQ_DLQ_JOB_RETENTION: KeepJobs = {
  age: 30 * SECONDS_PER_DAY,
  count: 20_000,
};

export const BULLMQ_RETAINED_JOB_CLEAN_INTERVAL_MS = 60 * 60 * 1000;
export const BULLMQ_RETAINED_JOB_CLEAN_BATCH_SIZE = 1_000;
export const BULLMQ_RETAINED_JOB_CLEAN_MAX_BATCHES = 10;

export function keepsFinishedJob(
  value: boolean | number | KeepJobs | undefined,
): boolean {
  if (value === true) {
    return false;
  }
  if (typeof value === "number") {
    return value > 0;
  }
  if (value && typeof value === "object") {
    return value.age !== 0 && value.count !== 0;
  }
  return true;
}
