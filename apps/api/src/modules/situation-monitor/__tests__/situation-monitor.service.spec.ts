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

  const createProcessedFindChain = (result: unknown[]) => ({
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(result),
  });

  const createRawFindChain = (result: unknown[]) => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(result),
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
    const feedback = { getLearningState: jest.fn().mockResolvedValue(new Map()) } as any;
    const service = new SituationMonitorService(cache, external, feedback, {} as any);

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

  it("filters placeholder titles from processed headlines", async () => {
    const processedChain = createProcessedFindChain([
      {
        _id: "processed-1",
        rawItemId: "raw-1",
        result: { title: "No title" },
        tags: ["situation-monitor", "sm:tech"],
        sortAt: new Date("2026-01-02T10:00:00.000Z"),
        createdAt: new Date("2026-01-02T09:00:00.000Z"),
      },
      {
        _id: "processed-2",
        rawItemId: "raw-2",
        result: { title: "AI chip export controls tighten" },
        tags: ["situation-monitor", "sm:tech"],
        sortAt: new Date("2026-01-02T11:00:00.000Z"),
        createdAt: new Date("2026-01-02T10:00:00.000Z"),
      },
    ]);
    processedFindMock.mockReturnValue(processedChain);

    const rawChain = createRawFindChain([
      { _id: "raw-1", payload: { url: "https://example.com/placeholder", sourceName: "Example" } },
      { _id: "raw-2", payload: { url: "https://example.com/ai-chip", sourceName: "Example" } },
    ]);
    rawFindMock.mockReturnValue(rawChain);

    const cache = {} as any;
    const external = {} as any;
    const feedback = { getLearningState: jest.fn().mockResolvedValue(new Map()) } as any;
    const service = new SituationMonitorService(cache, external, feedback, {} as any);

    const result = await (service as any).buildHeadlinesByCategory({
      orgId: "org-1",
      since: new Date("2026-01-01T00:00:00.000Z"),
      maxItems: 20,
      maxPerCategory: 5,
      allowGdeltFallback: false,
      scope: "tagged",
      debug: false,
    });

    expect(result.tech).toHaveLength(1);
    expect(result.tech[0]?.title).toBe("AI chip export controls tighten");
  });

  it("filters placeholder titles from gdelt fallback headlines", async () => {
    const processedChain = createProcessedFindChain([]);
    processedFindMock.mockReturnValue(processedChain);

    const rawChain = createRawFindChain([]);
    rawFindMock.mockReturnValue(rawChain);

    const external = {
      fetchGdeltCategoryHeadlines: jest.fn(async (category: string) => {
        if (category !== "tech") {
          return [];
        }
        return [
          {
            id: "gdelt-tech-placeholder",
            title: "No title",
            link: "https://example.com/no-title",
            source: "GDELT",
            timestamp: Date.now(),
            category: "tech",
            origin: "gdelt",
            isAlert: false,
          },
          {
            id: "gdelt-tech-valid",
            title: "Semiconductor exports face new review",
            link: "https://example.com/semiconductor-review",
            source: "GDELT",
            timestamp: Date.now(),
            category: "tech",
            origin: "gdelt",
            isAlert: false,
          },
        ];
      }),
    } as any;
    const cache = {} as any;
    const feedback = { getLearningState: jest.fn().mockResolvedValue(new Map()) } as any;
    const service = new SituationMonitorService(cache, external, feedback, {} as any);

    const result = await (service as any).buildHeadlinesByCategory({
      orgId: "org-1",
      since: new Date("2026-01-01T00:00:00.000Z"),
      maxItems: 20,
      maxPerCategory: 5,
      allowGdeltFallback: true,
      scope: "tagged",
      debug: false,
    });

    expect(result.tech).toHaveLength(1);
    expect(result.tech[0]?.title).toBe("Semiconductor exports face new review");
  });

  it("builds diagnostics from the same displayed headlines returned to clients", async () => {
    const cache = {
      get: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
      wrap: jest.fn(async (_key: string, _ttl: number, factory: () => Promise<unknown>) => await factory()),
    } as any;
    const external = {
      isGdeltEnabled: jest.fn().mockReturnValue(false),
    } as any;
    const feedback = { getLearningState: jest.fn().mockResolvedValue(new Map()) } as any;
    const realtimeSignals = {
      getSituationMonitorInsightSnapshot: jest.fn().mockResolvedValue({
        keywordSpikes: [],
        predictionLeads: [],
        pizzint: undefined,
        tensions: [],
      }),
    } as any;
    const service = new SituationMonitorService(cache, external, feedback, realtimeSignals, {} as any);

    const makeHeadline = (index: number, origin: "items" | "gdelt") => ({
      id: `tech-${index}`,
      title: `Tech headline ${index}`,
      titleZh: null,
      link: `https://example.com/tech-${index}`,
      source: origin === "items" ? "Internal" : "GDELT",
      timestamp: Date.parse(`2026-01-02T${String(index % 24).padStart(2, "0")}:00:00.000Z`),
      category: "tech",
      origin,
      isAlert: false,
      itemMetaId: `meta-${index}`,
      summary: null,
      keyPoints: [],
      topics: [],
    });

    const headlines = {
      politics: [],
      tech: [
        ...Array.from({ length: 10 }, (_, index) => makeHeadline(index + 1, "items")),
        ...Array.from({ length: 5 }, (_, index) => makeHeadline(index + 11, "gdelt")),
      ],
      finance: [],
      gov: [],
      ai: [],
      intel: [],
    };

    jest.spyOn(service as any, "buildHeadlinesByCategory").mockResolvedValue(headlines);

    const result = await service.getInsights("org-1", { sections: ["core"] });

    expect(result.headlines?.tech).toHaveLength(12);
    expect(result.diagnostics?.categories.tech).toEqual({
      internalCount: 10,
      gdeltFallbackCount: 2,
      totalCount: 12,
    });
  });
});
