const aggregateMock = jest.fn();
const findMock = jest.fn();

jest.mock("@modular/mongo", () => ({
  ProcessedItemModel: {
    aggregate: aggregateMock,
    find: findMock
  }
}));

import { AlertMetricProvider } from "@prisma/client";

import { EntitySentimentMetricProvider } from "./entity-sentiment-metric.provider";

describe("EntitySentimentMetricProvider.fetch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses sortAt (publishedAt-priority) windowing and includes evidence items with both publishedAt and ingestedAt", async () => {
    aggregateMock
      .mockReturnValueOnce({
        allowDiskUse: jest.fn().mockResolvedValue([
          {
            total: 10,
            negative: 8,
            positive: 1,
            neutral: 1,
            scoreSum: -6
          }
        ])
      })
      .mockReturnValueOnce({
        allowDiskUse: jest.fn().mockResolvedValue([
          {
            total: 10,
            negative: 1,
            positive: 5,
            neutral: 4,
            scoreSum: 4
          }
        ])
      });

    const leanMock = jest.fn().mockResolvedValue([
      {
        _id: { toString: () => "p1" },
        itemMetaId: "item-1",
        ingestedAt: new Date("2026-01-16T11:00:00.000Z"),
        createdAt: new Date("2026-01-16T12:00:00.000Z"),
        result: {
          title: "Bad news",
          summary: "Some summary",
          published_at: "2026-01-16",
          source: "example",
          sentiment_label: "Negative"
        }
      }
    ]);
    const chain = {
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: leanMock
    };
    findMock.mockReturnValue(chain);

    const provider = new EntitySentimentMetricProvider();
    const result = await provider.fetch({
      orgId: "org-1",
      metricProvider: AlertMetricProvider.entity_sentiment,
      metricSlug: "Seed",
      operator: "gte" as any,
      changeWindowMin: 60,
      metadata: { includeEvidenceItems: 2, baselineWindowMin: 60, minDocsInWindow: 5 }
    });

    expect(aggregateMock).toHaveBeenCalledTimes(2);
    const pipeline = aggregateMock.mock.calls[0]?.[0] as any[];
    expect(pipeline?.[0]?.$match?.createdAt).toBeUndefined();
    expect(pipeline?.[0]?.$match?.$or).toEqual(
      expect.arrayContaining([expect.objectContaining({ sortAt: expect.any(Object) })])
    );

    expect(result.latest).not.toBeNull();
    const context = result.context as any;
    expect(Array.isArray(context.evidence)).toBe(true);
    expect(context.evidence[0].processedId).toBe("p1");
    expect(context.evidence[0].publishedAt).toBe("2026-01-16");
    expect(context.evidence[0].ingestedAt).toBe("2026-01-16T11:00:00.000Z");
    expect(context.evidence[0].createdAt).toBe("2026-01-16T11:00:00.000Z");

    expect(findMock).toHaveBeenCalledTimes(1);
    const findQuery = findMock.mock.calls[0]?.[0] as any;
    expect(findQuery?.createdAt).toBeUndefined();
    expect(findQuery?.$or).toEqual(
      expect.arrayContaining([expect.objectContaining({ sortAt: expect.any(Object) })])
    );
  });
});
