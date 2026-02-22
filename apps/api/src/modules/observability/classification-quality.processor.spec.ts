jest.mock("bullmq", () => {
  const workerInstance = {
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return {
    Worker: jest.fn().mockImplementation(() => workerInstance),
    Queue: jest.fn(),
  };
});

import { Worker } from "bullmq";

import { ClassificationQualityProcessor } from "./classification-quality.processor";
import { ClassificationQualityService } from "./classification-quality.service";

describe("ClassificationQualityProcessor", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const buildProcessor = () => {
    const env = {
      newsPipelineEnv: {
        processQueueConcurrency: 3,
      },
    } as any;

    const classificationQuality = {
      processReviewSeedItemJob: jest.fn().mockResolvedValue(undefined),
      processReportJob: jest.fn().mockResolvedValue(undefined),
    } as unknown as ClassificationQualityService;

    const queue = {
      opts: {
        connection: {
          host: "127.0.0.1",
          port: 6379,
        },
      },
    } as any;

    const processor = new ClassificationQualityProcessor(
      env,
      classificationQuality,
      queue,
    );

    return { processor, classificationQuality };
  };

  const getWorkerHandler = () => {
    const workerCtor = Worker as jest.Mock;
    const call = workerCtor.mock.calls[0];
    if (!call) {
      throw new Error("Worker constructor was not called");
    }
    return call[1] as (job: { id?: string; data: Record<string, unknown> }) => Promise<void>;
  };

  it("dispatches review seed jobs", async () => {
    const { processor, classificationQuality } = buildProcessor();
    await processor.onModuleInit();
    const handler = getWorkerHandler();

    await handler({
      id: "job-1",
      data: {
        jobType: "review_seed_item",
        orgId: "org-1",
        processedItemId: "processed-1",
        traceId: "trace-1",
      },
    });

    expect(classificationQuality.processReviewSeedItemJob).toHaveBeenCalledWith({
      orgId: "org-1",
      processedItemId: "processed-1",
    });
    expect(classificationQuality.processReportJob).not.toHaveBeenCalled();
  });

  it("dispatches report jobs", async () => {
    const { processor, classificationQuality } = buildProcessor();
    await processor.onModuleInit();
    const handler = getWorkerHandler();

    await handler({
      id: "job-2",
      data: {
        jobType: "report",
        orgId: "org-1",
        reportJobId: "report-1",
        traceId: "trace-2",
      },
    });

    expect(classificationQuality.processReportJob).toHaveBeenCalledWith(
      "org-1",
      "report-1",
    );
    expect(classificationQuality.processReviewSeedItemJob).not.toHaveBeenCalled();
  });

  it("keeps backward compatibility for legacy report payload without jobType", async () => {
    const { processor, classificationQuality } = buildProcessor();
    await processor.onModuleInit();
    const handler = getWorkerHandler();

    await handler({
      id: "job-3",
      data: {
        orgId: "org-legacy",
        reportJobId: "report-legacy",
        traceId: "trace-legacy",
      },
    });

    expect(classificationQuality.processReportJob).toHaveBeenCalledWith(
      "org-legacy",
      "report-legacy",
    );
  });

  it("skips invalid payloads without required ids", async () => {
    const { processor, classificationQuality } = buildProcessor();
    await processor.onModuleInit();
    const handler = getWorkerHandler();

    await handler({
      id: "job-4",
      data: {
        jobType: "report",
        orgId: "org-1",
      },
    });

    expect(classificationQuality.processReportJob).not.toHaveBeenCalled();
    expect(classificationQuality.processReviewSeedItemJob).not.toHaveBeenCalled();
  });

  it("closes worker on module destroy", async () => {
    const { processor } = buildProcessor();
    await processor.onModuleInit();
    const workerInstance = (Worker as jest.Mock).mock.results[0]?.value;
    await processor.onModuleDestroy();
    expect(workerInstance.close).toHaveBeenCalledTimes(1);
  });
});
