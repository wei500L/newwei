import {
  NewsExtractionPipelineMode,
  NewsExtractionProviderId,
  NewsExtractionSettingsService,
} from "../news-extraction-settings.service";

describe("NewsExtractionSettingsService", () => {
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
    set: jest.fn(),
    del: jest.fn(),
  };

  beforeEach(() => {
    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue(null);
    prismaMock.systemSetting.upsert = jest.fn().mockResolvedValue(null);
    prismaMock.auditLog.create = jest.fn().mockResolvedValue(null);
    cacheMock.wrap = jest.fn(
      async (_key: string, _ttl: number, loader: () => Promise<unknown>) =>
        loader(),
    );
    cacheMock.set = jest.fn().mockResolvedValue(undefined);
    cacheMock.del = jest.fn().mockResolvedValue(undefined);
  });

  it("returns fallback defaults when no record exists", async () => {
    const service = new NewsExtractionSettingsService(
      prismaMock as any,
      cacheMock as any,
    );

    const settings = await service.getSettings("org-1");

    expect(settings).toEqual({
      pipelineMode: NewsExtractionPipelineMode.staged,
      preflightGate: {
        enabled: true,
        minWordCount: 120,
        minQualityScore: 0.35,
        rejectBotChallenge: true,
        rejectListLike: true,
      },
      postCleanGate: {
        enabled: true,
        minQualityScore: 0.35,
        minCleanedChars: 400,
        requireSummary: true,
      },
      capabilities: {
        entities: true,
        sentiment: true,
        kg: true,
      },
      providers: {
        clean: NewsExtractionProviderId.llm,
        entities: NewsExtractionProviderId.llm,
        sentiment: NewsExtractionProviderId.llm,
        kg: NewsExtractionProviderId.llm,
      },
    });
  });

  it("preserves explicitly configured legacy mode", async () => {
    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue({
      value: {
        pipelineMode: NewsExtractionPipelineMode.legacy,
      },
    });
    const service = new NewsExtractionSettingsService(
      prismaMock as any,
      cacheMock as any,
    );

    const settings = await service.getSettings("org-1");

    expect(settings.pipelineMode).toBe(NewsExtractionPipelineMode.legacy);
    expect(settings.preflightGate).toEqual({
      enabled: true,
      minWordCount: 120,
      minQualityScore: 0.35,
      rejectBotChallenge: true,
      rejectListLike: true,
    });
  });

  it("normalizes staged settings and clamps invalid numeric values", async () => {
    const service = new NewsExtractionSettingsService(
      prismaMock as any,
      cacheMock as any,
    );

    const settings = await service.updateSettings("org-1", "user-1", {
      pipelineMode: NewsExtractionPipelineMode.staged,
      preflightGate: {
        minWordCount: -10,
        minQualityScore: 2,
        rejectBotChallenge: false,
      },
      postCleanGate: {
        minQualityScore: 2,
        minCleanedChars: 200_000,
        requireSummary: false,
      },
      capabilities: {
        entities: false,
      },
      providers: {
        clean: "external_http" as unknown as NewsExtractionProviderId,
      },
    });

    expect(settings).toEqual({
      pipelineMode: NewsExtractionPipelineMode.staged,
      preflightGate: {
        enabled: true,
        minWordCount: 0,
        minQualityScore: 1,
        rejectBotChallenge: false,
        rejectListLike: true,
      },
      postCleanGate: {
        enabled: true,
        minQualityScore: 1,
        minCleanedChars: 100_000,
        requireSummary: false,
      },
      capabilities: {
        entities: false,
        sentiment: true,
        kg: true,
      },
      providers: {
        clean: NewsExtractionProviderId.llm,
        entities: NewsExtractionProviderId.llm,
        sentiment: NewsExtractionProviderId.llm,
        kg: NewsExtractionProviderId.llm,
      },
    });

    expect(prismaMock.systemSetting.upsert).toHaveBeenCalledWith({
      where: { key: "news_extraction_settings:org-1" },
      update: {
        value: settings,
        updatedById: "user-1",
        description: "News extraction settings (org=org-1)",
      },
      create: {
        key: "news_extraction_settings:org-1",
        value: settings,
        updatedById: "user-1",
        description: "News extraction settings (org=org-1)",
      },
    });
  });

  it("normalizes legacy external_http providers from stored settings to llm", async () => {
    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue({
      value: {
        providers: {
          clean: "external_http",
          entities: "external_http",
          sentiment: "external_http",
          kg: "external_http",
        },
      },
    });
    const service = new NewsExtractionSettingsService(
      prismaMock as any,
      cacheMock as any,
    );

    const settings = await service.getSettings("org-1");

    expect(settings.providers).toEqual({
      clean: NewsExtractionProviderId.llm,
      entities: NewsExtractionProviderId.llm,
      sentiment: NewsExtractionProviderId.llm,
      kg: NewsExtractionProviderId.llm,
    });
  });
});
