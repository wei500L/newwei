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

  it("includes evidence items when negative sentiment increases", async () => {
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

    expect(result.latest).not.toBeNull();
    const context = result.context as any;
    expect(Array.isArray(context.evidence)).toBe(true);
    expect(context.evidence[0].processedId).toBe("p1");
    expect(findMock).toHaveBeenCalledTimes(1);
  });
});

