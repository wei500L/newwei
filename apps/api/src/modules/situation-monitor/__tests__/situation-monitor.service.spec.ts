const processedFindMock = jest.fn();
const rawFindMock = jest.fn();

jest.mock("@modular/mongo", () => ({
  ProcessedItemModel: { find: processedFindMock },
  RawItemModel: { find: rawFindMock },
}));

import { SituationMonitorExternalSnapshotStatus } from "@prisma/client";

import { SituationMonitorService } from "../situation-monitor.service";

describe("SituationMonitorService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
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

  const createCacheMock = () =>
    ({
      get: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
      wrap: jest.fn(
        async (_key: string, _ttl: number, factory: () => Promise<unknown>) =>
          await factory(),
      ),
    }) as any;

  const createSnapshotPayload = (input?: {
    status?: SituationMonitorExternalSnapshotStatus;
    generatedAt?: string;
    expiresAt?: string;
    warnings?: Array<{ code: string; message: string; detail?: string }>;
    headlinesByCategory?: Partial<Record<string, unknown[]>>;
    categoryStates?: Partial<Record<string, unknown>>;
  }) => {
    const generatedAt = input?.generatedAt ?? "2026-03-28T12:00:00.000Z";
    const headlinesByCategory = {
      politics: [],
      tech: [],
      finance: [],
      gov: [],
      ai: [],
      intel: [],
      ...(input?.headlinesByCategory ?? {}),
    } as Record<string, unknown[]>;

    return {
      source: "scheduler",
      scope: "gdelt_global",
      variantKey: "default",
      status: input?.status ?? SituationMonitorExternalSnapshotStatus.completed,
      generatedAt,
      expiresAt: input?.expiresAt ?? "2026-03-28T12:20:00.000Z",
      partial:
        (input?.status ?? SituationMonitorExternalSnapshotStatus.completed) !==
        SituationMonitorExternalSnapshotStatus.completed,
      warnings: input?.warnings ?? [],
      diagnostics: {
        requestedCategories: 6,
        fetchedCategories: [],
        reusedCategories: [],
        failedCategories: [],
        totalHeadlines: 0,
      },
      categoryStates: {
        politics: {
          status: headlinesByCategory.politics.length > 0 ? "fresh" : "empty",
          articleCount: headlinesByCategory.politics.length,
          contentGeneratedAt:
            headlinesByCategory.politics.length > 0 ? generatedAt : null,
        },
        tech: {
          status: headlinesByCategory.tech.length > 0 ? "fresh" : "empty",
          articleCount: headlinesByCategory.tech.length,
          contentGeneratedAt:
            headlinesByCategory.tech.length > 0 ? generatedAt : null,
        },
        finance: {
          status: headlinesByCategory.finance.length > 0 ? "fresh" : "empty",
          articleCount: headlinesByCategory.finance.length,
          contentGeneratedAt:
            headlinesByCategory.finance.length > 0 ? generatedAt : null,
        },
        gov: {
          status: headlinesByCategory.gov.length > 0 ? "fresh" : "empty",
          articleCount: headlinesByCategory.gov.length,
          contentGeneratedAt:
            headlinesByCategory.gov.length > 0 ? generatedAt : null,
        },
        ai: {
          status: headlinesByCategory.ai.length > 0 ? "fresh" : "empty",
          articleCount: headlinesByCategory.ai.length,
          contentGeneratedAt:
            headlinesByCategory.ai.length > 0 ? generatedAt : null,
        },
        intel: {
          status: headlinesByCategory.intel.length > 0 ? "fresh" : "empty",
          articleCount: headlinesByCategory.intel.length,
          contentGeneratedAt:
            headlinesByCategory.intel.length > 0 ? generatedAt : null,
        },
        ...(input?.categoryStates ?? {}),
      },
      headlinesByCategory,
    };
  };

  const createService = (input?: {
    cache?: any;
    external?: any;
    externalSnapshots?: any;
    feedback?: any;
    realtimeSignals?: any;
  }) =>
    new SituationMonitorService(
      input?.cache ?? createCacheMock(),
      input?.external ??
        ({
          isGdeltEnabled: jest.fn().mockReturnValue(false),
        } as any),
      input?.externalSnapshots ??
        ({
          getLatestSnapshot: jest
            .fn()
            .mockResolvedValue({ payload: null, stale: false }),
        } as any),
      {} as any,
      input?.feedback ??
        ({
          getLearningState: jest.fn().mockResolvedValue(new Map()),
        } as any),
      input?.realtimeSignals ??
        ({
          getSituationMonitorInsightSnapshot: jest.fn().mockResolvedValue({
            keywordSpikes: [],
            predictionLeads: [],
            pizzint: undefined,
            tensions: [],
          }),
        } as any),
      {} as any,
    );

  it("uses sortAt (publishedAt-priority) windowing with ingestedAt/createdAt fallbacks for headline selection", async () => {
    const chain = createProcessedFindChain([]);
    processedFindMock.mockReturnValue(chain);

    const service = createService({
      external: {} as any,
      realtimeSignals: {} as any,
    });

    const since = new Date("2026-01-01T00:00:00.000Z");
    const result = await (service as any).buildHeadlinesByCategory({
      orgId: "org-1",
      since,
      maxItems: 10,
      maxPerCategory: 5,
      allowGdeltFallback: false,
      scope: "tagged",
      debug: false,
    });

    expect(result).toBeDefined();
    expect(processedFindMock).toHaveBeenCalledTimes(1);
    const query = processedFindMock.mock.calls[0]?.[0] as any;
    expect(query?.createdAt).toBeUndefined();
    expect(query?.$or).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sortAt: { $gte: since } }),
      ]),
    );
    expect(chain.sort).toHaveBeenCalledWith({
      sortAt: -1,
      ingestedAt: -1,
      createdAt: -1,
    });
    expect(chain.select).toHaveBeenCalledWith(
      expect.objectContaining({ ingestedAt: 1 }),
    );
  });

  it("defaults omitted scope to all items in insights loading", async () => {
    const service = createService({
      external: {
        isGdeltEnabled: jest.fn().mockReturnValue(false),
      } as any,
    });
    const buildHeadlinesSpy = jest
      .spyOn(service as any, "buildHeadlinesByCategory")
      .mockResolvedValue({
        politics: [],
        tech: [],
        finance: [],
        gov: [],
        ai: [],
        intel: [],
      });

    await service.getInsights("org-1", { sections: ["core"] });

    expect(buildHeadlinesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "all" }),
    );
  });

  it("defaults omitted windowHours to 72 hours", async () => {
    const service = createService({
      external: {
        isGdeltEnabled: jest.fn().mockReturnValue(false),
      } as any,
    });

    const result = await service.getInsights("org-1", { sections: ["core"] });

    expect(result.windowHours).toBe(72);
  });

  it("restricts headline queries to tagged sources when tagged scope is requested", async () => {
    const chain = createProcessedFindChain([]);
    processedFindMock.mockReturnValue(chain);

    const service = createService({
      external: {} as any,
      realtimeSignals: {} as any,
    });

    await (service as any).buildHeadlinesByCategory({
      orgId: "org-1",
      since: new Date("2026-01-01T00:00:00.000Z"),
      maxItems: 10,
      maxPerCategory: 5,
      allowGdeltFallback: false,
      scope: "tagged",
      debug: false,
    });

    const query = processedFindMock.mock.calls[0]?.[0] as any;
    expect(query?.tags).toBe("situation-monitor");
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
    rawFindMock.mockReturnValue(
      createRawFindChain([
        {
          _id: "raw-1",
          payload: {
            url: "https://example.com/placeholder",
            sourceName: "Example",
          },
        },
        {
          _id: "raw-2",
          payload: {
            url: "https://example.com/ai-chip",
            sourceName: "Example",
          },
        },
      ]),
    );

    const service = createService({
      external: {} as any,
      realtimeSignals: {} as any,
    });

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

  it("merges server-side GDELT snapshot headlines into category gaps during insights loading", async () => {
    processedFindMock.mockReturnValue(createProcessedFindChain([]));
    rawFindMock.mockReturnValue(createRawFindChain([]));

    const externalSnapshots = {
      getLatestSnapshot: jest.fn().mockResolvedValue({
        stale: false,
        payload: createSnapshotPayload({
          headlinesByCategory: {
            politics: [
              {
                id: "gdelt-politics",
                title: "Election campaign reshapes parliamentary politics",
                link: "https://example.com/election-debate",
                source: "GDELT",
                timestamp: Date.parse("2026-03-28T11:30:00.000Z"),
                category: "politics",
                origin: "gdelt",
                isAlert: false,
              },
            ],
            ai: [
              {
                id: "gdelt-ai",
                title: "ChatGPT roadmap expands enterprise AI tooling",
                link: "https://example.com/chatgpt-roadmap",
                source: "GDELT",
                timestamp: Date.parse("2026-03-28T11:45:00.000Z"),
                category: "ai",
                origin: "gdelt",
                isAlert: false,
              },
            ],
          },
        }),
      }),
    } as any;
    const service = createService({
      external: {
        isGdeltEnabled: jest.fn().mockReturnValue(true),
      } as any,
      externalSnapshots,
    });

    const result = await service.getInsights("org-1", { sections: ["core"] });

    expect(externalSnapshots.getLatestSnapshot).toHaveBeenCalledWith({
      includeDatabase: true,
    });
    expect(result.headlines?.politics[0]?.title).toBe(
      "Election campaign reshapes parliamentary politics",
    );
    expect(result.headlines?.ai[0]?.title).toBe(
      "ChatGPT roadmap expands enterprise AI tooling",
    );
    expect(result.clusters?.politics).toHaveLength(1);
    expect(result.clusters?.ai).toHaveLength(1);
    expect(result.coverageSummary).toEqual(
      expect.objectContaining({
        mode: "external-only",
        articleCount: 2,
        clusterCount: 2,
        internalAnalyzedItems: 0,
        externalAnalyzedItems: 2,
        mixedSourceClusterCount: 0,
        dedupeRatio: 0,
        avgSourcesPerCluster: 1,
        visibleCategoryCount: 2,
        missingCategories: ["tech", "finance", "gov", "intel"],
        hasOlderItemsOutsideWindow: false,
        recommendedWindowHours: null,
      }),
    );
  });

  it("filters placeholder and out-of-window snapshot headlines before merging them", async () => {
    processedFindMock.mockReturnValue(createProcessedFindChain([]));
    rawFindMock.mockReturnValue(createRawFindChain([]));

    const service = createService({
      external: {
        isGdeltEnabled: jest.fn().mockReturnValue(true),
      } as any,
      externalSnapshots: {
        getLatestSnapshot: jest.fn().mockResolvedValue({
          stale: false,
          payload: createSnapshotPayload({
            headlinesByCategory: {
              tech: [
                {
                  id: "gdelt-tech-placeholder",
                  title: "No title",
                  link: "https://example.com/no-title",
                  source: "GDELT",
                  timestamp: Date.parse("2026-03-28T11:00:00.000Z"),
                  category: "tech",
                  origin: "gdelt",
                  isAlert: false,
                },
                {
                  id: "gdelt-tech-old",
                  title: "Semiconductor exports face new review",
                  link: "https://example.com/old-tech",
                  source: "GDELT",
                  timestamp: Date.parse("2026-03-27T08:00:00.000Z"),
                  category: "tech",
                  origin: "gdelt",
                  isAlert: false,
                },
                {
                  id: "gdelt-tech-valid",
                  title: "Chip tooling demand rises across cloud vendors",
                  link: "https://example.com/chip-demand",
                  source: "GDELT",
                  timestamp: Date.parse("2026-03-28T10:30:00.000Z"),
                  category: "tech",
                  origin: "gdelt",
                  isAlert: false,
                },
              ],
            },
          }),
        }),
      } as any,
    });

    const result = await service.getInsights("org-1", {
      sections: ["core"],
      windowHours: 24,
    });

    expect(result.headlines?.tech).toHaveLength(1);
    expect(result.headlines?.tech[0]?.title).toBe(
      "Chip tooling demand rises across cloud vendors",
    );
  });

  it("surfaces snapshot warnings and metadata in insights responses", async () => {
    processedFindMock.mockReturnValue(createProcessedFindChain([]));
    rawFindMock.mockReturnValue(createRawFindChain([]));

    const service = createService({
      external: {
        isGdeltEnabled: jest.fn().mockReturnValue(true),
      } as any,
      externalSnapshots: {
        getLatestSnapshot: jest.fn().mockResolvedValue({
          stale: true,
          payload: createSnapshotPayload({
            status: SituationMonitorExternalSnapshotStatus.partial,
            headlinesByCategory: {
              politics: [
                {
                  id: "gdelt-politics-stale",
                  title: "Parliament extends emergency economic debate",
                  link: "https://example.com/politics-stale",
                  source: "GDELT",
                  timestamp: Date.parse("2026-03-28T11:40:00.000Z"),
                  category: "politics",
                  origin: "gdelt",
                  isAlert: false,
                },
              ],
            },
            categoryStates: {
              politics: {
                status: "reused",
                articleCount: 1,
                contentGeneratedAt: "2026-03-28T10:00:00.000Z",
                reasonCode: "gdelt_rate_limited",
              },
            },
            warnings: [
              {
                code: "gdelt_rate_limited",
                message: "GDELT fallback is rate limited right now.",
                detail: "Categories: politics, tech. HTTP 429 Too Many Requests",
              },
            ],
          }),
        }),
      } as any,
    });

    const result = await service.getInsights("org-1", { sections: ["core"] });

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "gdelt_rate_limited",
          source: "gdelt",
        }),
      ]),
    );
    expect(result.externalSnapshot).toEqual(
      expect.objectContaining({
        source: "scheduler",
        status: "partial",
        stale: true,
        partial: true,
        warnings: [
          expect.objectContaining({
            code: "gdelt_rate_limited",
            source: "gdelt",
          }),
        ],
        categories: expect.objectContaining({
          politics: expect.objectContaining({
            status: "reused",
            reasonCode: "gdelt_rate_limited",
            contentGeneratedAt: "2026-03-28T10:00:00.000Z",
          }),
        }),
      }),
    );
  });

  it("stays resilient when no snapshot is available yet", async () => {
    processedFindMock.mockReturnValue(createProcessedFindChain([]));
    rawFindMock.mockReturnValue(createRawFindChain([]));

    const service = createService({
      external: {
        isGdeltEnabled: jest.fn().mockReturnValue(true),
      } as any,
      externalSnapshots: {
        getLatestSnapshot: jest
          .fn()
          .mockResolvedValue({ payload: null, stale: false }),
      } as any,
    });

    const result = await service.getInsights("org-1", { sections: ["core"] });

    expect(result.headlines).toEqual({
      politics: [],
      tech: [],
      finance: [],
      gov: [],
      ai: [],
      intel: [],
    });
    expect(result.externalSnapshot).toEqual(
      expect.objectContaining({
        status: "idle",
        availableCategoryCount: 0,
      }),
    );
  });

  it("builds diagnostics and coverage counts from the full analysis pool", async () => {
    const service = createService({
      external: {
        isGdeltEnabled: jest.fn().mockReturnValue(false),
      } as any,
    });

    const makeHeadline = (index: number, origin: "items" | "gdelt") => ({
      id: `tech-${index}`,
      title: `Tech headline ${index}`,
      titleZh: null,
      link: `https://example.com/tech-${index}`,
      source: origin === "items" ? "Internal" : "GDELT",
      timestamp: Date.parse(
        `2026-01-02T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
      ),
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
        ...Array.from({ length: 10 }, (_, index) =>
          makeHeadline(index + 1, "items"),
        ),
        ...Array.from({ length: 5 }, (_, index) =>
          makeHeadline(index + 11, "gdelt"),
        ),
      ],
      finance: [],
      gov: [],
      ai: [],
      intel: [],
    };

    jest
      .spyOn(service as any, "buildHeadlinesByCategory")
      .mockResolvedValue(headlines);

    const result = await service.getInsights("org-1", { sections: ["core"] });

    expect(result.headlines?.tech).toHaveLength(12);
    expect(result.diagnostics?.categories.tech).toEqual({
      internalCount: 10,
      gdeltFallbackCount: 5,
      totalCount: 15,
      clusterCount: 15,
      mixedSourceClusterCount: 0,
      distinctSourceCount: 2,
    });
    expect(result.clusters?.tech).toHaveLength(6);
    expect(result.coverageSummary).toEqual(
      expect.objectContaining({
        mode: "internal+external",
        articleCount: 15,
        clusterCount: 15,
        internalAnalyzedItems: 10,
        externalAnalyzedItems: 5,
        mixedSourceClusterCount: 0,
        dedupeRatio: 0,
        avgSourcesPerCluster: 1,
        visibleCategoryCount: 1,
        missingCategories: ["politics", "finance", "gov", "ai", "intel"],
        hasOlderItemsOutsideWindow: false,
        recommendedWindowHours: null,
      }),
    );
  });

  it("recommends a broader window when content exists outside the current window", async () => {
    const now = Date.parse("2026-03-28T12:00:00.000Z");
    jest.spyOn(Date, "now").mockReturnValue(now);

    processedFindMock
      .mockReturnValueOnce(createProcessedFindChain([]))
      .mockReturnValueOnce(
        createProcessedFindChain([
          {
            _id: "processed-older-1",
            rawItemId: "raw-older-1",
            result: { title: "Older internal coverage remains relevant" },
            tags: ["situation-monitor", "sm:politics"],
            sortAt: new Date("2026-03-26T12:00:00.000Z"),
            createdAt: new Date("2026-03-26T12:00:00.000Z"),
          },
        ]),
      );
    rawFindMock.mockReturnValue(createRawFindChain([]));

    const service = createService({
      external: {
        isGdeltEnabled: jest.fn().mockReturnValue(true),
      } as any,
      externalSnapshots: {
        getLatestSnapshot: jest.fn().mockResolvedValue({
          stale: false,
          payload: createSnapshotPayload({
            headlinesByCategory: {
              politics: [
                {
                  id: "gdelt-politics-old",
                  title: "Older politics headline",
                  link: "https://example.com/older-politics",
                  source: "GDELT",
                  timestamp: Date.parse("2026-03-25T12:00:00.000Z"),
                  category: "politics",
                  origin: "gdelt",
                  isAlert: false,
                },
              ],
            },
          }),
        }),
      } as any,
    });

    const result = await service.getInsights("org-1", {
      sections: ["core"],
      windowHours: 24,
    });

    expect(result.analyzedItems).toBe(0);
    expect(result.coverageSummary).toEqual(
      expect.objectContaining({
        mode: "empty",
        articleCount: 0,
        clusterCount: 0,
        hasOlderItemsOutsideWindow: true,
        recommendedWindowHours: 168,
      }),
    );
  });

  it("clusters same-event internal and external headlines into mixed-source event cards", async () => {
    const service = createService({
      external: {
        isGdeltEnabled: jest.fn().mockReturnValue(false),
      } as any,
    });

    const headlines = {
      politics: [
        {
          id: "items-1",
          duplicateOf: "dup-1",
          title: "US sanctions package targets regional shipping network",
          link: "https://example.com/sanctions?utm_source=x",
          source: "Internal Desk",
          timestamp: Date.parse("2026-03-28T12:00:00.000Z"),
          category: "politics",
          origin: "items",
          isAlert: false,
          itemMetaId: "meta-1",
          summary: "Internal summary",
          keyPoints: [],
          topics: [],
        },
        {
          id: "gdelt-1",
          title: "U.S. sanctions package targets regional shipping network - Reuters",
          link: "https://example.com/sanctions",
          source: "Reuters",
          timestamp: Date.parse("2026-03-28T12:10:00.000Z"),
          category: "politics",
          origin: "gdelt",
          isAlert: false,
          summary: "External summary",
          keyPoints: [],
          topics: [],
        },
      ],
      tech: [],
      finance: [],
      gov: [],
      ai: [],
      intel: [],
    };

    jest
      .spyOn(service as any, "buildHeadlinesByCategory")
      .mockResolvedValue(headlines);

    const result = await service.getInsights("org-1", { sections: ["core"] });

    expect(result.clusters?.politics).toHaveLength(1);
    expect(result.clusters?.politics[0]).toEqual(
      expect.objectContaining({
        mixedSource: true,
        internalCount: 1,
        externalCount: 1,
        distinctSourceCount: 2,
      }),
    );
    expect(result.coverageSummary).toEqual(
      expect.objectContaining({
        clusterCount: 1,
        mixedSourceClusterCount: 1,
        dedupeRatio: 0.5,
        avgSourcesPerCluster: 2,
      }),
    );
    expect(result.diagnostics?.categories.politics).toEqual(
      expect.objectContaining({
        clusterCount: 1,
        mixedSourceClusterCount: 1,
        distinctSourceCount: 2,
      }),
    );
  });
});
