const processedFindMock = jest.fn();
const rawFindMock = jest.fn();

jest.mock("@modular/mongo", () => ({
  ProcessedItemModel: { find: processedFindMock },
  RawItemModel: { find: rawFindMock }
}));

import { SituationMonitorService } from "../situation-monitor.service";

describe("SituationMonitorService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses sortAt (publishedAt-priority) windowing with ingestedAt/createdAt fallbacks for headline selection", async () => {
    const chain = {
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([])
    };
    processedFindMock.mockReturnValue(chain);

    const cache = {} as any;
    const external = {} as any;
    const service = new SituationMonitorService(cache, external, {} as any);

    const since = new Date("2026-01-01T00:00:00.000Z");
    const result = await (service as any).buildHeadlinesByCategory({
      orgId: "org-1",
      since,
      maxItems: 10,
      maxPerCategory: 5,
      allowGdeltFallback: false,
      scope: "tagged",
      debug: false
    });

    expect(result).toBeDefined();

    expect(processedFindMock).toHaveBeenCalledTimes(1);
    const query = processedFindMock.mock.calls[0]?.[0] as any;
    expect(query?.createdAt).toBeUndefined();
    expect(query?.$or).toEqual(
      expect.arrayContaining([expect.objectContaining({ sortAt: { $gte: since } })])
    );

    expect(chain.sort).toHaveBeenCalledWith({ sortAt: -1, ingestedAt: -1, createdAt: -1 });
    expect(chain.select).toHaveBeenCalledWith(expect.objectContaining({ ingestedAt: 1 }));
  });
});

