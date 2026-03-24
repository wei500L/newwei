import { UserSettingsService } from "../user-settings.service";

const prismaMock = {
  userSetting: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
} as any;

describe("UserSettingsService", () => {
  let service: UserSettingsService;
  let persisted: Map<string, { value: any; updatedAt: Date }>;

  beforeEach(() => {
    jest.resetAllMocks();
    persisted = new Map();

    prismaMock.userSetting.upsert = jest.fn(async (args: any) => {
      const key = args.where?.orgId_userId_key?.key ?? args.create?.key;
      const value = args.create?.value ?? args.update?.value;
      const updatedAt = new Date();
      persisted.set(key, { value, updatedAt });
      return { key, value, updatedAt };
    });

    prismaMock.userSetting.findMany = jest.fn(async (args: any) => {
      const keys: string[] = args.where?.key?.in ?? [];
      return keys.flatMap((key) => {
        const record = persisted.get(key);
        if (!record) {
          return [];
        }
        return [{ key, value: record.value, updatedAt: record.updatedAt }];
      });
    });

    prismaMock.userSetting.findUnique = jest.fn(async (args: any) => {
      const key: string = args.where?.orgId_userId_key?.key;
      const record = persisted.get(key);
      if (!record) {
        return null;
      }
      return { key, value: record.value, updatedAt: record.updatedAt };
    });

    service = new UserSettingsService(prismaMock);
  });

  it("returns null payload when no situation monitor records exist", async () => {
    const response = await service.getSituationMonitorUiSettings("org-1", "user-1");
    expect(response.monitors).toBeNull();
    expect(response.layout).toBeNull();
    expect(response.settings).toBeNull();
    expect(response.updatedAt).toEqual({});
  });

  it("normalizes and stores situation monitor monitors", async () => {
    const response = await service.updateSituationMonitorUiSettings("org-1", "user-1", {
      monitors: [
        {
          name: " Supply chain disruption ",
          keywords: ["tariff", "Tariff", "logistics, port"],
          enabled: true,
          color: "#FFF",
          createdAt: 123,
        },
        { name: "", keywords: ["ignored"] },
        { name: "Missing keywords", keywords: [] },
      ],
    });

    expect(response.monitors?.length).toBe(1);
    expect(response.monitors?.[0]?.name).toBe("Supply chain disruption");
    expect(response.monitors?.[0]?.keywords).toEqual(["tariff", "Tariff", "logistics", "port"]);
    expect(response.monitors?.[0]?.enabled).toBe(true);
    expect(response.monitors?.[0]?.color).toBe("#fff");
  });

  it("defaults situation monitor settings scope to all when missing", async () => {
    const response = await service.updateSituationMonitorUiSettings("org-1", "user-1", {
      settings: {
        windowHours: 24,
      },
    });

    expect(response.settings).toEqual({
      windowHours: 24,
      scope: "all",
      autoRefresh: true,
      resetLayoutOnPreset: false,
      translateToZh: false,
    });
  });

  it("normalizes invalid situation monitor scope to all and preserves tagged", async () => {
    const invalidResponse = await service.updateSituationMonitorUiSettings("org-1", "user-1", {
      settings: {
        windowHours: 6,
        scope: "unexpected",
        autoRefresh: false,
        resetLayoutOnPreset: true,
        translateToZh: true,
      },
    });

    expect(invalidResponse.settings).toEqual({
      windowHours: 6,
      scope: "all",
      autoRefresh: false,
      resetLayoutOnPreset: true,
      translateToZh: true,
    });

    const taggedResponse = await service.updateSituationMonitorUiSettings("org-1", "user-1", {
      settings: {
        scope: "tagged",
      },
    });

    expect(taggedResponse.settings?.scope).toBe("tagged");
  });

  it("returns null payload when no war map settings exist", async () => {
    const response = await service.getWarMapUiSettings("org-1", "user-1");
    expect(response.settings).toBeNull();
    expect(response.updatedAt).toEqual({});
  });

  it("normalizes war map settings and merges defaults", async () => {
    const response = await service.updateWarMapUiSettings("org-1", "user-1", {
      settings: {
        layerVisibility: {
          hotspots: false,
          conflictZones: false,
          monitors: false,
          nonsense: true,
        },
      },
    });

    expect(response.settings?.layerVisibility.hotspots).toBe(false);
    expect(response.settings?.layerVisibility.conflicts).toBe(false);
    expect(response.settings?.layerVisibility.waterways).toBe(true);
    expect(response.settings?.layerVisibility.monitors).toBe(false);
    expect(response.settings?.activePreset).toBe("global");
    expect(response.settings?.timeRangePreset).toBe("7d");
    expect(response.settings?.viewState.zoom).toBeGreaterThan(0);
  });

  it("returns null payload when no newsnow settings exist", async () => {
    const response = await service.getNewsnowUiSettings("org-1", "user-1");
    expect(response.settings).toBeNull();
    expect(response.updatedAt).toEqual({});
  });

  it("normalizes and persists newsnow settings", async () => {
    const response = await service.updateNewsnowUiSettings("org-1", "user-1", {
      settings: {
        focusSources: ["weibo", "weibo", " bad source "],
        columnOrders: {
          hottest: ["weibo", "hackernews", "bad source", "hackernews"],
          "bad column name": ["weibo"],
        },
        hideCrossSourceDuplicates: 1,
        sortMode: "smart",
        sourceAffinity: {
          weibo: {
            score: 123,
            openOriginalCount: 2.8,
            openEventCount: 1,
            openItemCount: 0,
            refreshCount: 4,
            focusCount: 5,
            accumulatedDwellMs: 9_999,
            lastInteractedAt: 1739900000000,
          },
          "bad source": {
            score: 1,
          },
        },
      },
    });

    expect(response.settings?.focusSources).toEqual(["weibo"]);
    expect(response.settings?.columnOrders).toEqual({
      hottest: ["weibo", "hackernews"],
    });
    expect(response.settings?.hideCrossSourceDuplicates).toBe(true);
    expect(response.settings?.sortMode).toBe("smart");
    expect(response.settings?.sourceAffinity.weibo?.score).toBe(100);
    expect(response.settings?.sourceAffinity.weibo?.openOriginalCount).toBe(3);
    expect(response.settings?.sourceAffinity).not.toHaveProperty("bad source");
  });

  it("returns null payload when no rss reader settings exist", async () => {
    const response = await service.getRssReaderUiSettings("org-1", "user-1");
    expect(response.settings).toBeNull();
    expect(response.updatedAt).toEqual({});
  });

  it("normalizes and persists rss reader settings", async () => {
    const response = await service.updateRssReaderUiSettings("org-1", "user-1", {
      settings: {
        selectedSourceIds: [" source-a ", "source-a", "source-b"],
        sourceLanguageFilters: [" en ", "zh-cn", "EN"],
        translationEnabled: 1,
        translationProvider: "llm",
        targetLanguage: " en ",
        showOriginalContent: true,
      },
    });

    expect(response.settings).toEqual({
      selectedSourceIds: ["source-a", "source-b"],
      sourceLanguageFilters: ["EN", "ZH-CN"],
      translationEnabled: false,
      translationProvider: "llm",
      targetLanguage: "en",
      showOriginalContent: true,
    });
  });
});
