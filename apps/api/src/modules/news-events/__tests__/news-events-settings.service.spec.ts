jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.mock("../../audit/audit-log.writer", () => ({
  writeAuditLogBestEffort: jest.fn(async () => undefined),
}));

import { NewsEventsSettingsService } from "../news-events-settings.service";

describe("NewsEventsSettingsService", () => {
  const prismaMock = {
    systemSetting: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  } as any;

  let cacheState: unknown | null;
  const cacheMock = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  } as any;

  let service: NewsEventsSettingsService;

  beforeEach(() => {
    jest.resetAllMocks();
    cacheState = null;
    cacheMock.get = jest.fn(async () => cacheState);
    cacheMock.set = jest.fn(async (_key: string, value: unknown) => {
      cacheState = value;
    });
    cacheMock.del = jest.fn(async () => {
      cacheState = null;
    });
    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue(null);
    prismaMock.systemSetting.upsert = jest.fn().mockResolvedValue(undefined);
    service = new NewsEventsSettingsService(prismaMock, cacheMock);
  });

  it("returns defaults with timeline threshold settings when no record exists", async () => {
    const settings = await service.getSettings("org-1");

    expect(prismaMock.systemSetting.findUnique).toHaveBeenCalledWith({
      where: { key: "news_event_settings:org-1" },
    });
    expect(settings).toEqual(
      expect.objectContaining({
        clusteringMode: "vector",
        bertopicMinItemsPerGroup: 8,
        bertopicMaxItemsPerRequest: 64,
        bertopicMinTopicSize: 4,
        classificationGateEnabled: true,
        categoryConflictReject: true,
        categorySoftPenalty: 0.15,
        minCategoryConfidenceForGate: 0.4,
        timelineLowConfidenceThreshold: 0.5,
        timelineHighConfidenceThreshold: 0.8,
        timelineDriftKlThreshold: 0.35,
        timelineMinBucketItemsForDrift: 3,
        timelineCrossCategoryWarningShare: 0.3,
        timelineMaxCategoryDistributionItems: 16,
        timelineMaxPhaseSummaries: 8,
        timelinePresetCustomDistanceThreshold: 0.22,
      }),
    );
  });

  it("fills new timeline settings with defaults when loading legacy records", async () => {
    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue({
      value: {
        enabled: true,
        ingestionEnabled: true,
        timelineEnabled: true,
        clusteringMode: "bertopic_primary",
        bertopicMinItemsPerGroup: 12,
        maxBatchSize: 120,
        backfillDays: 14,
        lookbackDays: 10,
        timelineMaxEventsPerRun: 40,
        vectorMinScore: 0.86,
        crossLanguagePenalty: 0.2,
        cacheTtlSeconds: 120,
      },
    });

    const settings = await service.getSettings("org-legacy");

    expect(settings).toEqual(
      expect.objectContaining({
        enabled: true,
        ingestionEnabled: true,
        timelineEnabled: true,
        clusteringMode: "bertopic_primary",
        bertopicMinItemsPerGroup: 12,
        bertopicMaxItemsPerRequest: 64,
        bertopicMinTopicSize: 4,
        maxBatchSize: 120,
        backfillDays: 14,
        lookbackDays: 10,
        timelineMaxEventsPerRun: 40,
        vectorMinScore: 0.86,
        crossLanguagePenalty: 0.2,
        classificationGateEnabled: true,
        categoryConflictReject: true,
        timelineLowConfidenceThreshold: 0.5,
        timelineHighConfidenceThreshold: 0.8,
        timelineDriftKlThreshold: 0.35,
        timelinePresetCustomDistanceThreshold: 0.22,
      }),
    );
  });

  it("clamps and normalizes timeline settings on update", async () => {
    const updated = await service.updateSettings("org-1", "admin-1", {
      enabled: true,
      ingestionEnabled: true,
      timelineEnabled: true,
      clusteringMode: "bertopic_primary",
      bertopicMinItemsPerGroup: 1,
      bertopicMaxItemsPerRequest: 999,
      bertopicMinTopicSize: 1,
      forceAuthoritativeMode: true,
      forceMinAuthoritativeSources: 9,
      maxBatchSize: 999,
      backfillDays: -5,
      lookbackDays: 999,
      timelineMaxEventsPerRun: 0,
      vectorMinScore: 1.9,
      crossLanguagePenalty: -0.3,
      classificationGateEnabled: true,
      categoryConflictReject: false,
      categorySoftPenalty: 1.7,
      minCategoryConfidenceForGate: -2,
      timelineLowConfidenceThreshold: 0.95,
      timelineHighConfidenceThreshold: 0.2,
      timelineDriftKlThreshold: 9,
      timelineMinBucketItemsForDrift: 99,
      timelineCrossCategoryWarningShare: 3,
      timelineMaxCategoryDistributionItems: 1,
      timelineMaxPhaseSummaries: 30,
      timelinePresetCustomDistanceThreshold: 99,
      cacheTtlSeconds: 99999,
    });

    expect(updated).toEqual(
      expect.objectContaining({
        clusteringMode: "bertopic_primary",
        bertopicMinItemsPerGroup: 2,
        bertopicMaxItemsPerRequest: 500,
        bertopicMinTopicSize: 2,
        forceMinAuthoritativeSources: 5,
        maxBatchSize: 500,
        backfillDays: 1,
        lookbackDays: 180,
        timelineMaxEventsPerRun: 1,
        vectorMinScore: 1,
        crossLanguagePenalty: 0,
        categorySoftPenalty: 1,
        minCategoryConfidenceForGate: 0,
        timelineLowConfidenceThreshold: 0.2,
        timelineHighConfidenceThreshold: 0.95,
        timelineDriftKlThreshold: 5,
        timelineMinBucketItemsForDrift: 50,
        timelineCrossCategoryWarningShare: 1,
        timelineMaxCategoryDistributionItems: 4,
        timelineMaxPhaseSummaries: 20,
        timelinePresetCustomDistanceThreshold: 7,
        cacheTtlSeconds: 3600,
      }),
    );

    expect(prismaMock.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "news_event_settings:org-1" },
      }),
    );
    expect(cacheMock.set).toHaveBeenCalled();
  });
});
