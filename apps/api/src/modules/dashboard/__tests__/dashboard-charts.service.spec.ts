import { ProcessedArticleStatus } from "@prisma/client";

import { DashboardChartsService } from "../dashboard-charts.service";

describe("DashboardChartsService", () => {
  it("filters war map news markers by publishedAt priority (falls back to crawlAt when publishedAt is null)", async () => {
    const prisma = {
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([])
      }
    };
    const geocoding = {
      resolveCandidates: jest.fn()
    };
    const service = new DashboardChartsService(prisma as any, geocoding as any);

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T00:00:00.000Z")
    };

    await service.getWarMapNewsMarkers(range, "org-1");

    expect(prisma.processedArticle.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.processedArticle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: ProcessedArticleStatus.completed,
          OR: expect.arrayContaining([
            expect.objectContaining({
              publishedAt: expect.objectContaining({
                gte: range.start,
                lte: range.end
              }),
              article: { orgId: "org-1" }
            }),
            expect.objectContaining({
              publishedAt: null,
              article: expect.objectContaining({
                orgId: "org-1",
                crawlAt: expect.objectContaining({
                  gte: range.start,
                  lte: range.end
                })
              })
            })
          ])
        })
      })
    );
  });

  it("filters war map events by publishedAt priority (falls back to crawlAt when publishedAt is null)", async () => {
    const prisma = {
      alertEvent: {
        findMany: jest.fn().mockResolvedValue([])
      },
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([])
      }
    };
    const geocoding = {
      resolveCandidates: jest.fn()
    };
    const service = new DashboardChartsService(prisma as any, geocoding as any);

    const range = {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T00:00:00.000Z")
    };

    await service.getWarMapEvents(range, "org-1");

    expect(prisma.processedArticle.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.processedArticle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: ProcessedArticleStatus.completed,
          OR: expect.arrayContaining([
            expect.objectContaining({
              publishedAt: expect.objectContaining({
                gte: range.start,
                lte: range.end
              }),
              article: { orgId: "org-1" }
            }),
            expect.objectContaining({
              publishedAt: null,
              article: expect.objectContaining({
                orgId: "org-1",
                crawlAt: expect.objectContaining({
                  gte: range.start,
                  lte: range.end
                })
              })
            })
          ])
        })
      })
    );
  });
});

