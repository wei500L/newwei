jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    warn: jest.fn(),
  }),
}));

import {
  BullmqQueueCleanupService,
  type BullmqQueueCleanupProfile,
} from "./bullmq-queue-cleanup.service";
import {
  BULLMQ_DLQ_JOB_RETENTION,
  BULLMQ_FAILED_JOB_RETENTION,
  BULLMQ_RETAINED_JOB_CLEAN_BATCH_SIZE,
} from "./bullmq-retention";

const createJob = () => ({
  remove: jest.fn().mockResolvedValue(undefined),
});

const createQueue = (overrides: Record<string, unknown> = {}) => ({
  name: "test-queue",
  clean: jest.fn().mockResolvedValue([]),
  getFailedCount: jest.fn().mockResolvedValue(0),
  getJobCounts: jest.fn().mockResolvedValue({ waiting: 0 }),
  getJobs: jest.fn().mockResolvedValue([]),
  close: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

async function destroy(service: BullmqQueueCleanupService) {
  await service.onModuleDestroy();
}

describe("BullmqQueueCleanupService", () => {
  it("cleans failed jobs by age using the standard retention profile", async () => {
    const service = new BullmqQueueCleanupService();
    const queue = createQueue();

    service.track(queue);
    await service.cleanTrackedQueues();
    await destroy(service);

    expect(queue.clean).toHaveBeenCalledWith(
      BULLMQ_FAILED_JOB_RETENTION.age! * 1000,
      BULLMQ_RETAINED_JOB_CLEAN_BATCH_SIZE,
      "failed",
    );
  });

  it("trims oldest failed jobs above the standard count limit", async () => {
    const service = new BullmqQueueCleanupService();
    const jobs = [createJob(), createJob()];
    const queue = createQueue({
      getFailedCount: jest
        .fn()
        .mockResolvedValue(BULLMQ_FAILED_JOB_RETENTION.count! + jobs.length),
      getJobs: jest.fn().mockResolvedValue(jobs),
    });

    service.track(queue);
    await service.cleanTrackedQueues();
    await destroy(service);

    expect(queue.getJobs).toHaveBeenCalledWith(["failed"], 0, 1, true);
    expect(jobs[0]?.remove).toHaveBeenCalledTimes(1);
    expect(jobs[1]?.remove).toHaveBeenCalledTimes(1);
  });

  it("cleans and trims waiting jobs for DLQ queues", async () => {
    const service = new BullmqQueueCleanupService();
    const jobs = [createJob(), createJob()];
    const queue = createQueue({
      getJobCounts: jest
        .fn()
        .mockResolvedValue({ waiting: BULLMQ_DLQ_JOB_RETENTION.count! + jobs.length }),
      getJobs: jest.fn().mockResolvedValue(jobs),
    });
    const profile: BullmqQueueCleanupProfile = {
      failedRetention: BULLMQ_DLQ_JOB_RETENTION,
      waitingRetention: BULLMQ_DLQ_JOB_RETENTION,
    };

    service.track(queue, profile);
    await service.cleanTrackedQueues();
    await destroy(service);

    expect(queue.clean).toHaveBeenCalledWith(
      BULLMQ_DLQ_JOB_RETENTION.age! * 1000,
      BULLMQ_RETAINED_JOB_CLEAN_BATCH_SIZE,
      "waiting",
    );
    expect(queue.getJobs).toHaveBeenCalledWith(["waiting"], 0, 1, true);
    expect(jobs[0]?.remove).toHaveBeenCalledTimes(1);
    expect(jobs[1]?.remove).toHaveBeenCalledTimes(1);
  });

  it("tracks non-queue resources for close only", async () => {
    const service = new BullmqQueueCleanupService();
    const events = {
      close: jest.fn().mockResolvedValue(undefined),
    };

    service.track(events);
    await service.cleanTrackedQueues();
    await destroy(service);

    expect(events.close).toHaveBeenCalledTimes(1);
  });
});
