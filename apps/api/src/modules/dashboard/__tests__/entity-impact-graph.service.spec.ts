const aggregateMock = jest.fn();

jest.mock("@modular/mongo", () => ({
  ProcessedItemModel: {
    aggregate: aggregateMock
  }
}));

import { EntityImpactGraphService } from "../entity-impact-graph.service";

describe("EntityImpactGraphService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("wraps graph generation in cache when ttl > 0", async () => {
    const prisma = {} as any;
    const cache = {
      wrap: jest.fn(async (_key: string, _ttl: number, loader: () => Promise<any>) => loader())
    } as any;
    const settings = {
      getSettings: jest.fn().mockResolvedValue({
        enabled: true,
        minEntityConfidence: 0.6,
        minCorrelation: 0.4,
        minCoOccurrence: 3,
        maxNodes: 80,
        categories: ["person", "organization"],
        cacheTtlSeconds: 60
      })
    } as any;

    const service = new EntityImpactGraphService(prisma, cache, settings);
    jest.spyOn(service, "calculateCoOccurrence").mockResolvedValue([]);
    jest.spyOn(service, "calculateCorrelation").mockResolvedValue([]);
    jest
      .spyOn(service, "buildGraphData")
      .mockReturnValue({ nodes: [], links: [], categories: [] } as any);

    const startDate = new Date("2026-01-01T00:00:00.000Z");
    const endDate = new Date("2026-01-02T00:00:00.000Z");

    await service.getEntityImpactGraph({ orgId: "org-1", startDate, endDate });

    expect(cache.wrap).toHaveBeenCalledTimes(1);
    const [key, ttl] = (cache.wrap as jest.Mock).mock.calls[0];
    expect(ttl).toBe(60);
    expect(String(key)).toContain("entityImpactGraph:data:org-1");

    expect(service.calculateCoOccurrence).toHaveBeenCalledWith("org-1", startDate, endDate, 3, 0.6);
    expect(service.calculateCorrelation).toHaveBeenCalledWith("org-1", startDate, endDate, 0.4, 0.6);
  });

  it("skips cache when ttl is 0", async () => {
    const prisma = {} as any;
    const cache = { wrap: jest.fn() } as any;
    const settings = {
      getSettings: jest.fn().mockResolvedValue({
        enabled: true,
        minEntityConfidence: 0.5,
        minCorrelation: 0.3,
        minCoOccurrence: 2,
        maxNodes: 100,
        categories: ["person", "organization", "stock", "commodity"],
        cacheTtlSeconds: 0
      })
    } as any;

    const service = new EntityImpactGraphService(prisma, cache, settings);
    jest.spyOn(service, "calculateCoOccurrence").mockResolvedValue([]);
    jest.spyOn(service, "calculateCorrelation").mockResolvedValue([]);
    jest
      .spyOn(service, "buildGraphData")
      .mockReturnValue({ nodes: [], links: [], categories: [] } as any);

    await service.getEntityImpactGraph({
      orgId: "org-1",
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      endDate: new Date("2026-01-02T00:00:00.000Z")
    });

    expect(cache.wrap).not.toHaveBeenCalled();
    expect(service.calculateCoOccurrence).toHaveBeenCalled();
    expect(service.calculateCorrelation).toHaveBeenCalled();
  });

  it("calculates co-occurrence via Mongo aggregation", async () => {
    aggregateMock.mockReturnValue({
      allowDiskUse: jest.fn().mockResolvedValue([
        {
          entityA: "A",
          entityB: "B",
          typeA: "person",
          typeB: "organization",
          count: 2,
          articleIds: ["1"]
        }
      ])
    });

    const service = new EntityImpactGraphService({} as any, {} as any, {} as any);
    const startDate = new Date("2026-01-01T00:00:00.000Z");
    const endDate = new Date("2026-01-02T00:00:00.000Z");

    const result = await service.calculateCoOccurrence("org-1", startDate, endDate, 2, 0.5);

    expect(aggregateMock).toHaveBeenCalledTimes(1);
    const pipeline = aggregateMock.mock.calls[0][0];
    expect(pipeline[0]).toMatchObject({
      $match: { orgId: "org-1", status: "completed" }
    });
    expect(result).toEqual([
      {
        entityA: "A",
        entityB: "B",
        typeA: "person",
        typeB: "organization",
        count: 2,
        articleIds: ["1"]
      }
    ]);
  });
});

