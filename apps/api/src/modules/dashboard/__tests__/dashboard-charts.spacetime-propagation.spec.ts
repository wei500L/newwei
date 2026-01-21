const mongoFindMock = jest.fn();

jest.mock("@modular/mongo", () => ({
  ProcessedItemModel: {
    find: mongoFindMock
  }
}));

import { DashboardChartsService } from "../dashboard-charts.service";

describe("DashboardChartsService.getSpacetimePropagation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("prefers duplicate edges and falls back to time-lag edges", async () => {
    const prisma = {
      newsEventItem: {
        findMany: jest.fn().mockResolvedValue([
          {
            processedItemId: "p1",
            createdAt: new Date("2026-01-10T10:00:00.000Z"),
            processedArticle: {
              id: "pa1",
              cleanedMarkdownRef: "p1",
              title: "A1",
              publishedAt: new Date("2026-01-10T10:00:00.000Z"),
              processedAt: new Date("2026-01-10T10:10:00.000Z"),
              article: {
                url: "https://a.example.com/a1",
                sourceLabel: "SourceA",
                crawlAt: new Date("2026-01-10T10:05:00.000Z")
              }
            }
          },
          {
            processedItemId: "p2",
            createdAt: new Date("2026-01-10T11:00:00.000Z"),
            processedArticle: {
              id: "pa2",
              cleanedMarkdownRef: "p2",
              title: "B1",
              publishedAt: new Date("2026-01-10T11:00:00.000Z"),
              processedAt: new Date("2026-01-10T11:10:00.000Z"),
              article: {
                url: "https://b.example.com/b1",
                sourceLabel: "SourceB",
                crawlAt: new Date("2026-01-10T11:05:00.000Z")
              }
            }
          },
          {
            processedItemId: "p3",
            createdAt: new Date("2026-01-10T12:00:00.000Z"),
            processedArticle: {
              id: "pa3",
              cleanedMarkdownRef: "p3",
              title: "C1",
              publishedAt: new Date("2026-01-10T12:00:00.000Z"),
              processedAt: new Date("2026-01-10T12:10:00.000Z"),
              article: {
                url: "https://c.example.com/c1",
                sourceLabel: "SourceC",
                crawlAt: new Date("2026-01-10T12:05:00.000Z")
              }
            }
          }
        ])
      }
    } as any;

    mongoFindMock.mockReturnValue({
      lean: () => ({
        exec: async () => [
          { _id: { toHexString: () => "p1" }, duplicateOf: null, duplicateSimilarity: null },
          { _id: { toHexString: () => "p2" }, duplicateOf: { toHexString: () => "p1" }, duplicateSimilarity: 0.92 },
          { _id: { toHexString: () => "p3" }, duplicateOf: null, duplicateSimilarity: null }
        ]
      })
    });

    const service = new DashboardChartsService(prisma, {} as any, { get: jest.fn(), set: jest.fn() } as any);

    const result = await service.getSpacetimePropagation(
      {
        start: new Date("2026-01-01T00:00:00.000Z"),
        end: new Date("2026-01-31T23:59:59.999Z")
      } as any,
      "org-1",
      { eventId: "evt-1" }
    );

    expect(prisma.newsEventItem.findMany).toHaveBeenCalledTimes(1);
    expect(mongoFindMock).toHaveBeenCalled();

    const edgeKinds = result.edges.map((edge) => `${edge.kind}:${edge.source}->${edge.target}`);
    expect(edgeKinds).toContain("duplicate:SourceA->SourceB");
    expect(edgeKinds).toContain("time:SourceB->SourceC");
  });
});
