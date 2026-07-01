import { QueueEventPayload, QueueEventPublisher } from "../queue/queue-event.publisher";

import { ClassificationQualitySeedTriggerService } from "./classification-quality-seed-trigger.service";
import { ClassificationQualityService } from "./classification-quality.service";

describe("ClassificationQualitySeedTriggerService", () => {
  let registerListener: jest.Mock;
  let unsubscribe: jest.Mock;
  let queueEvents: QueueEventPublisher;
  let enqueueReviewSeedItemJob: jest.Mock;
  let classificationQuality: ClassificationQualityService;
  let service: ClassificationQualitySeedTriggerService;
  let listener: ((orgId: string, payload: QueueEventPayload) => Promise<void> | void) | undefined;

  beforeEach(() => {
    registerListener = jest.fn();
    unsubscribe = jest.fn();
    listener = undefined;
    registerListener.mockImplementation((nextListener: typeof listener) => {
      listener = nextListener;
      return unsubscribe;
    });

    queueEvents = {
      registerListener,
    } as unknown as QueueEventPublisher;

    enqueueReviewSeedItemJob = jest.fn().mockResolvedValue(undefined);
    classificationQuality = {
      enqueueReviewSeedItemJob,
    } as unknown as ClassificationQualityService;

    service = new ClassificationQualitySeedTriggerService(
      queueEvents,
      classificationQuality,
    );
  });

  it("registers and unregisters queue listener", () => {
    service.onModuleInit();
    expect(registerListener).toHaveBeenCalledTimes(1);

    service.onModuleDestroy();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("enqueues review seed job for COMPLETED event with processed item id", async () => {
    service.onModuleInit();
    expect(listener).toBeDefined();
    if (!listener) {
      throw new Error("queue listener is not registered");
    }

    await listener("org-1", {
      event: "COMPLETED",
      jobId: "job-1",
      timestamp: new Date().toISOString(),
      data: { id: "  processed-1  " },
    });

    expect(enqueueReviewSeedItemJob).toHaveBeenCalledWith({
      orgId: "org-1",
      processedItemId: "processed-1",
    });
  });

  it("ignores non-completed events and invalid payloads", async () => {
    service.onModuleInit();
    expect(listener).toBeDefined();
    if (!listener) {
      throw new Error("queue listener is not registered");
    }

    await listener("org-1", {
      event: "FAILED",
      jobId: "job-1",
      timestamp: new Date().toISOString(),
      data: { id: "processed-1" },
    });
    await listener("org-1", {
      event: "COMPLETED",
      jobId: "job-2",
      timestamp: new Date().toISOString(),
      data: { unknown: "value" },
    });
    await listener("org-1", {
      event: "COMPLETED",
      jobId: "job-3",
      timestamp: new Date().toISOString(),
    });

    expect(enqueueReviewSeedItemJob).not.toHaveBeenCalled();
  });
});
