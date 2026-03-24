import { AlertMetricProvider, MongoOutboxStatus, MongoOutboxType } from "@prisma/client";

import { PipelineMetricProvider } from "./pipeline-metric.provider";

describe("PipelineMetricProvider", () => {
  const createProvider = () => {
    const prisma = {
      mongoOutbox: {
        count: jest.fn().mockResolvedValue(3),
        findFirst: jest.fn().mockResolvedValue({
          createdAt: new Date("2026-03-24T00:00:00.000Z"),
        }),
      },
      pipelineJob: {
        count: jest.fn(),
      },
    } as any;

    return { prisma, provider: new PipelineMetricProvider(prisma) };
  };

  it("excludes dead entries from the default mongo outbox backlog metric", async () => {
    const { prisma, provider } = createProvider();

    await provider.fetch({
      orgId: "org-1",
      metricProvider: AlertMetricProvider.pipeline_job,
      metricSlug: "mongo_outbox.backlog",
      operator: "gte" as any,
      changeWindowMin: 60,
      metadata: {},
    });

    expect(prisma.mongoOutbox.count).toHaveBeenCalledWith({
      where: {
        orgId: "org-1",
        type: MongoOutboxType.processed_item,
        status: {
          in: [
            MongoOutboxStatus.pending,
            MongoOutboxStatus.failed,
            MongoOutboxStatus.processing,
          ],
        },
      },
    });
  });

  it("supports a dedicated mongo_outbox.dead metric", async () => {
    const { prisma, provider } = createProvider();

    await provider.fetch({
      orgId: "org-1",
      metricProvider: AlertMetricProvider.pipeline_job,
      metricSlug: "mongo_outbox.dead",
      operator: "gte" as any,
      changeWindowMin: 60,
      metadata: {},
    });

    expect(prisma.mongoOutbox.count).toHaveBeenCalledWith({
      where: {
        orgId: "org-1",
        type: MongoOutboxType.processed_item,
        status: { in: [MongoOutboxStatus.dead] },
      },
    });
  });

  it("limits mongo_outbox.oldest_age_minutes to active backlog statuses", async () => {
    const { prisma, provider } = createProvider();

    await provider.fetch({
      orgId: "org-1",
      metricProvider: AlertMetricProvider.pipeline_job,
      metricSlug: "mongo_outbox.oldest_age_minutes",
      operator: "gte" as any,
      changeWindowMin: 60,
      metadata: {},
    });

    expect(prisma.mongoOutbox.findFirst).toHaveBeenCalledWith({
      where: {
        orgId: "org-1",
        type: MongoOutboxType.processed_item,
        status: {
          in: [
            MongoOutboxStatus.pending,
            MongoOutboxStatus.failed,
            MongoOutboxStatus.processing,
          ],
        },
      },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
  });
});
