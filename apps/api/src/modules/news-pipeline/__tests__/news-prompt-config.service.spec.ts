import {
  DEFAULT_NEWS_PROMPT_CONFIG,
  NewsPromptConfigService,
} from "../news-prompt-config.service";

describe("NewsPromptConfigService", () => {
  const prismaMock = {
    systemSetting: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
  };

  beforeEach(() => {
    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue(null);
    prismaMock.systemSetting.upsert = jest.fn().mockResolvedValue(null);
    prismaMock.auditLog.create = jest.fn().mockResolvedValue(null);
  });

  it("returns defaults when no record exists", async () => {
    const service = new NewsPromptConfigService(prismaMock as any);

    const config = await service.getConfig();

    expect(config).toEqual(DEFAULT_NEWS_PROMPT_CONFIG);
    expect(config.entitySystemPromptTemplate).toBeTruthy();
    expect(config.sentimentSystemPromptTemplate).toBeTruthy();
    expect(config.kgSystemPromptTemplate).toBeTruthy();
    expect(prismaMock.systemSetting.findUnique).toHaveBeenCalledWith({
      where: { key: "news_pipeline_prompt_config" },
    });
  });

  it("upserts normalized settings with actor metadata", async () => {
    const service = new NewsPromptConfigService(prismaMock as any);

    const result = await service.updateConfig("org-1", "user-1", {
      version: " custom-v1 ",
      systemPromptTemplate: "System {{language_hint}} ",
      userPromptTemplate: "User {{url}}  ",
      entityUserPromptTemplate: "Entity {{title}}  ",
      sentimentUserPromptTemplate: "Sentiment {{summary}}  ",
      kgUserPromptTemplate: "KG {{markdown}}  ",
    });

    expect(result.version).toBe("custom-v1");
    expect(result.systemPromptTemplate).toBe("System {{language_hint}}");
    expect(result.entityUserPromptTemplate).toBe("Entity {{title}}");
    expect(result.sentimentUserPromptTemplate).toBe("Sentiment {{summary}}");
    expect(result.kgUserPromptTemplate).toBe("KG {{markdown}}");
    expect(prismaMock.systemSetting.upsert).toHaveBeenCalledWith({
      where: { key: "news_pipeline_prompt_config" },
      update: {
        value: result,
        updatedById: "user-1",
        description:
          "Configurable prompt templates for the news cleaning pipeline.",
      },
      create: {
        key: "news_pipeline_prompt_config",
        value: result,
        updatedById: "user-1",
        description:
          "Configurable prompt templates for the news cleaning pipeline.",
      },
    });
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgId: "org-1",
          actorId: "user-1",
          action: "update",
          resource: "news_pipeline_prompt",
        }),
      }),
    );
  });
});
