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

    expect(settings).toEqual(expect.objectContaining({
      defaultThreshold: 0.9,
      scopedThresholds: [],
      useEmbeddings: true,
      llmJudgeInstructions: null,
      llmJudgeModel: null,
      llmJudgeMaxComparisons: 12,
      llmJudgeCandidateChars: 1200,
      llmJudgePromptVersion: expect.any(String),
      llmJudgeSystemPromptTemplate: expect.any(String),
      llmJudgeUserPromptTemplate: expect.any(String),
    }));
    expect(settings.llmJudgePromptVersion).toBeTruthy();
    expect(settings.llmJudgeSystemPromptTemplate).toBeTruthy();
    expect(settings.llmJudgeUserPromptTemplate).toBeTruthy();
    expect(prismaMock.systemSetting.findUnique).toHaveBeenCalledWith({
      where: { key: "news_dedupe_settings:org-1" },
    });
  });

  it("normalizes and upserts scoped overrides", async () => {
    const service = new NewsDedupeSettingsService(
      prismaMock as any,
      cacheMock as any,
      pipelineConfigMock as any,
    );

    const result = await service.updateSettings("org-1", "user-1", {
      defaultThreshold: 1.2,
      useEmbeddings: false,
      llmJudgeInstructions: "Be extra strict.",
      llmJudgeModel: "openai/gpt-4o-mini",
      llmJudgeMaxComparisons: 5,
      llmJudgeCandidateChars: 1500,
      llmJudgePromptVersion: "news-dedupe-judge-v2",
      llmJudgeSystemPromptTemplate:
        "SYSTEM {{language_hint}} {{additional_instructions}} Output JSON only.",
      llmJudgeUserPromptTemplate:
        "USER threshold={{threshold}} A={{summary_a}} B={{summary_b}}",
      scopedThresholds: [
        {
          sourceId: " source-a ",
          language: "EN",
          categoryPath: "finance/markets",
          threshold: 0.93,
        },
        {
          sourceId: "source-a",
          language: "en",
          categoryPath: " finance/markets ",
          threshold: 0.91,
        },
        {
          sourceId: null,
          language: " zh ",
          categoryPath: null,
          threshold: 0.89,
        },
        {
          sourceId: null,
          language: null,
          categoryPath: "Tech",
          threshold: 2,
        },
      ],
    });

    expect(result.defaultThreshold).toBe(1);
    expect(result.scopedThresholds).toEqual(
      expect.arrayContaining([
        {
          sourceId: "source-a",
          language: "en",
          categoryPath: "finance/markets",
          threshold: 0.91,
        },
        { sourceId: null, language: "zh", categoryPath: null, threshold: 0.89 },
        { sourceId: null, language: null, categoryPath: "Tech", threshold: 1 },
      ]),
    );
    expect(result.scopedThresholds).toHaveLength(3);
    expect(result.useEmbeddings).toBe(false);

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

  it("resolves threshold with source/language/categoryPath priority", async () => {
    const service = new NewsDedupeSettingsService(
      prismaMock as any,
      cacheMock as any,
      pipelineConfigMock as any,
    );

    const resolved = service.resolveBaseThreshold(
      {
        defaultThreshold: 0.9,
        scopedThresholds: [
          {
            sourceId: "source-a",
            language: "en",
            categoryPath: "finance/markets",
            threshold: 0.95,
          },
          {
            sourceId: "source-a",
            language: "en",
            categoryPath: null,
            threshold: 0.93,
          },
          {
            sourceId: "source-a",
            language: null,
            categoryPath: null,
            threshold: 0.92,
          },
          {
            sourceId: null,
            language: "en",
            categoryPath: "finance/markets",
            threshold: 0.91,
          },
          {
            sourceId: null,
            language: "en",
            categoryPath: null,
            threshold: 0.9,
          },
          {
            sourceId: null,
            language: null,
            categoryPath: "finance/markets",
            threshold: 0.89,
          },
        ],
        useEmbeddings: true,
        llmJudgeInstructions: null,
        llmJudgeModel: null,
        llmJudgeMaxComparisons: 12,
        llmJudgeCandidateChars: 1200,
        llmJudgePromptVersion: "news-dedupe-judge-v1",
        llmJudgeSystemPromptTemplate: "system prompt",
        llmJudgeUserPromptTemplate: "user prompt",
      },
      {
        sourceId: "source-a",
        language: "EN",
        categoryPath: "finance/markets",
      },
    );

    expect(resolved).toEqual(
      expect.objectContaining({
        threshold: 0.95,
        matchedScope: expect.objectContaining({
          sourceId: "source-a",
          language: "en",
          categoryPath: "finance/markets",
        }),
      }),
    );
  });
});
