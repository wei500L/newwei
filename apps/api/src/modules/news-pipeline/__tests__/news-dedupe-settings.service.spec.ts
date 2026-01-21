import { NewsDedupeSettingsService } from "../news-dedupe-settings.service";

describe("NewsDedupeSettingsService", () => {
  const prismaMock = {
    systemSetting: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
  };

  const cacheMock = {
    wrap: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  };

  const pipelineConfigMock = {
    get config() {
      return {
        pipeline: {
          summaryDedupThreshold: 0.9,
        },
      };
    },
  };

  beforeEach(() => {
    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue(null);
    prismaMock.systemSetting.upsert = jest.fn().mockResolvedValue(null);
    prismaMock.auditLog.create = jest.fn().mockResolvedValue(null);
    cacheMock.wrap = jest.fn(async (_key: string, _ttl: number, loader: () => Promise<any>) => loader());
    cacheMock.get = jest.fn().mockResolvedValue(null);
    cacheMock.set = jest.fn().mockResolvedValue(undefined);
    cacheMock.del = jest.fn().mockResolvedValue(undefined);
  });

  it("returns fallback defaults when no record exists", async () => {
    const service = new NewsDedupeSettingsService(
      prismaMock as any,
      cacheMock as any,
      pipelineConfigMock as any,
    );

    const settings = await service.getSettings("org-1");

    expect(settings).toEqual({ defaultThreshold: 0.9, categoryThresholds: [] });
    expect(prismaMock.systemSetting.findUnique).toHaveBeenCalledWith({
      where: { key: "news_dedupe_settings:org-1" },
    });
  });

  it("normalizes and upserts category overrides", async () => {
    const service = new NewsDedupeSettingsService(
      prismaMock as any,
      cacheMock as any,
      pipelineConfigMock as any,
    );

    const result = await service.updateSettings("org-1", "user-1", {
      defaultThreshold: 1.2,
      categoryThresholds: [
        { category: " Finance ", threshold: 0.93 },
        { category: "finance", threshold: 0.91 },
        { category: "", threshold: 0.95 },
        { category: "Tech", threshold: 2 },
      ],
    });

    expect(result.defaultThreshold).toBe(1);
    expect(result.categoryThresholds).toEqual(
      expect.arrayContaining([
        { category: "finance", threshold: 0.91 },
        { category: "Tech", threshold: 1 },
      ]),
    );
    expect(result.categoryThresholds).toHaveLength(2);

    expect(prismaMock.systemSetting.upsert).toHaveBeenCalledWith({
      where: { key: "news_dedupe_settings:org-1" },
      update: {
        value: result,
        updatedById: "user-1",
        description: "News dedupe settings (org=org-1)",
      },
      create: {
        key: "news_dedupe_settings:org-1",
        value: result,
        updatedById: "user-1",
        description: "News dedupe settings (org=org-1)",
      },
    });
  });

  it("resolves the strictest threshold among category/topics", async () => {
    const service = new NewsDedupeSettingsService(
      prismaMock as any,
      cacheMock as any,
      pipelineConfigMock as any,
    );

    const resolved = service.resolveBaseThreshold(
      {
        defaultThreshold: 0.9,
        categoryThresholds: [
          { category: "finance", threshold: 0.92 },
          { category: "news", threshold: 0.88 },
        ],
      },
      { category: "Finance", topics: ["news"] },
    );

    expect(resolved).toEqual({ threshold: 0.92, matchedCategory: "finance" });
  });
});

