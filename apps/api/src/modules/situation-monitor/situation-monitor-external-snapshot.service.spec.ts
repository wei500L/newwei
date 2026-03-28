import { SituationMonitorExternalSnapshotStatus } from "@prisma/client";

import { SituationMonitorExternalSnapshotService } from "./situation-monitor-external-snapshot.service";

describe("SituationMonitorExternalSnapshotService", () => {
  const cache = {
    get: jest.fn(),
    set: jest.fn(),
    withLock: jest.fn(),
  };
  const prisma = {
    situationMonitorExternalSnapshot: {
      create: jest.fn(),
      deleteMany: jest.fn(),
      findFirst: jest.fn(),
    },
  };
  const external = {
    isGdeltEnabled: jest.fn(),
    fetchGdeltCategoryHeadlines: jest.fn(),
  };

  let service: SituationMonitorExternalSnapshotService;

  beforeEach(() => {
    jest.resetAllMocks();
    cache.get.mockResolvedValue(null);
    cache.set.mockResolvedValue(undefined);
    cache.withLock.mockImplementation(
      async (_key: string, _ttlMs: number, runner: () => Promise<unknown>) =>
        await runner(),
    );
    prisma.situationMonitorExternalSnapshot.create.mockResolvedValue(undefined);
    prisma.situationMonitorExternalSnapshot.deleteMany.mockResolvedValue({
      count: 0,
    });
    prisma.situationMonitorExternalSnapshot.findFirst.mockResolvedValue(null);
    external.isGdeltEnabled.mockReturnValue(true);
    external.fetchGdeltCategoryHeadlines.mockResolvedValue({ headlines: [] });
    service = new SituationMonitorExternalSnapshotService(
      cache as never,
      prisma as never,
      external as never,
    );
    jest.spyOn(service as never, "delay" as never).mockResolvedValue(undefined);
  });

  it("skips scheduled work when GDELT snapshots are disabled", async () => {
    external.isGdeltEnabled.mockReturnValue(false);

    await service.refreshScheduled();

    expect(cache.withLock).not.toHaveBeenCalled();
  });

  it("rebuilds a partial snapshot and reuses previous category data when a fetch fails", async () => {
    const previousPayload = {
      source: "scheduler",
      scope: "gdelt_global",
      variantKey: "default",
      status: SituationMonitorExternalSnapshotStatus.completed,
      generatedAt: "2026-03-28T11:00:00.000Z",
      expiresAt: "2026-03-28T11:20:00.000Z",
      partial: false,
      warnings: [],
      diagnostics: {
        requestedCategories: 6,
        fetchedCategories: ["politics"],
        reusedCategories: [],
        failedCategories: [],
        totalHeadlines: 1,
      },
      headlinesByCategory: {
        politics: [
          {
            id: "cached-politics",
            title: "Cached politics headline",
            link: "https://example.com/cached-politics",
            source: "GDELT",
            timestamp: Date.parse("2026-03-28T10:45:00.000Z"),
            category: "politics",
            origin: "gdelt",
            isAlert: false,
          },
        ],
        tech: [],
        finance: [],
        gov: [],
        ai: [],
        intel: [],
      },
    };
    cache.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(previousPayload);
    external.fetchGdeltCategoryHeadlines.mockImplementation(
      async (category: string, _limit: number, options?: { bypassCache?: boolean }) => {
        if (category === "politics") {
          return {
            headlines: [],
            warning: {
              code: "gdelt_rate_limited",
              message: "GDELT fallback is rate limited right now.",
              detail: "HTTP 429 Too Many Requests",
            },
          };
        }
        if (category === "tech") {
          return {
            headlines: [
              {
                id: "fresh-tech",
                title: "Chip exports tighten across cloud vendors",
                link: "https://example.com/fresh-tech",
                source: "GDELT",
                timestamp: Date.parse("2026-03-28T12:00:00.000Z"),
                category: "tech",
                origin: "gdelt",
                isAlert: false,
              },
            ],
          };
        }
        return { headlines: [] };
      },
    );

    const result = await service.forceRefresh();

    expect(external.fetchGdeltCategoryHeadlines).toHaveBeenNthCalledWith(
      1,
      "politics",
      20,
      { bypassCache: true },
    );
    expect(prisma.situationMonitorExternalSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: SituationMonitorExternalSnapshotStatus.partial,
        }),
      }),
    );
    expect(cache.set).toHaveBeenCalledTimes(2);
    expect(result).toEqual(
      expect.objectContaining({
        status: SituationMonitorExternalSnapshotStatus.partial,
        availableCategoryCount: 2,
        warningCount: 1,
      }),
    );
  });

  it("restores the latest snapshot from history when caches are empty", async () => {
    const payload = {
      source: "scheduler",
      scope: "gdelt_global",
      variantKey: "default",
      status: SituationMonitorExternalSnapshotStatus.completed,
      generatedAt: "2026-03-28T12:00:00.000Z",
      expiresAt: "2026-03-28T12:20:00.000Z",
      partial: false,
      warnings: [],
      diagnostics: {
        requestedCategories: 6,
        fetchedCategories: ["finance"],
        reusedCategories: [],
        failedCategories: [],
        totalHeadlines: 1,
      },
      headlinesByCategory: {
        politics: [],
        tech: [],
        finance: [
          {
            id: "finance-1",
            title: "Treasury yields extend their move higher",
            link: "https://example.com/finance-1",
            source: "GDELT",
            timestamp: Date.parse("2026-03-28T12:00:00.000Z"),
            category: "finance",
            origin: "gdelt",
            isAlert: false,
          },
        ],
        gov: [],
        ai: [],
        intel: [],
      },
    };
    prisma.situationMonitorExternalSnapshot.findFirst.mockResolvedValue({
      payload,
      generatedAt: new Date(payload.generatedAt),
      createdAt: new Date(payload.generatedAt),
    });

    const result = await service.getStatusSummary();

    expect(prisma.situationMonitorExternalSnapshot.findFirst).toHaveBeenCalled();
    expect(cache.set).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        status: SituationMonitorExternalSnapshotStatus.completed,
        availableCategoryCount: 1,
        warningCount: 0,
      }),
    );
  });
});
