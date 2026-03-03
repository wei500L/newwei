import { BadRequestException } from "@nestjs/common";

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

import { NewsClassificationSettingsService } from "../news-classification-settings.service";

describe("NewsClassificationSettingsService", () => {
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

  let service: NewsClassificationSettingsService;

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
    service = new NewsClassificationSettingsService(prismaMock, cacheMock);
  });

  it("returns fallback defaults when no record exists", async () => {
    const settings = await service.getSettings("org-1");

    expect(prismaMock.systemSetting.findUnique).toHaveBeenCalledWith({
      where: { key: "news_classification_settings:org-1" },
    });
    expect(settings).toEqual(
      expect.objectContaining({
        enabled: true,
        strictFail: true,
        enableLlm: true,
        enableEmbedding: true,
        enableRerank: true,
        taxonomyVersion: "news-taxonomy-v1",
      }),
    );
    expect(settings.taxonomy.length).toBeGreaterThan(0);
  });

  it("rejects duplicated taxonomy paths", async () => {
    await expect(
      service.updateSettings("org-1", "admin-1", {
        taxonomy: [
          {
            path: "tech/ai/model-release",
            displayName: "Model Release",
            description: "Model launch updates",
            legacyCategory: "ai",
            keywords: ["model"],
            synonyms: ["launch"],
          },
          {
            path: "tech/ai/model-release",
            displayName: "Model Release Duplicate",
            description: "Duplicate path",
            legacyCategory: "ai",
            keywords: ["model"],
            synonyms: ["duplicate"],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects invalid taxonomy path format", async () => {
    await expect(
      service.updateSettings("org-1", "admin-1", {
        taxonomy: [
          {
            path: "Tech / AI / Model Release",
            displayName: "Invalid Path",
            description: "Path contains spaces and uppercase characters",
            legacyCategory: "ai",
            keywords: ["model"],
            synonyms: ["launch"],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects enabling classification with all layers disabled", async () => {
    await expect(
      service.updateSettings("org-1", "admin-1", {
        enabled: true,
        enableLlm: false,
        enableEmbedding: false,
        enableRerank: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("updates settings even when cache write fails", async () => {
    cacheMock.set = jest.fn(async () => {
      throw new Error("cache unavailable");
    });

    const result = await service.updateSettings("org-1", "admin-1", {
      enabled: false,
    });

    expect(result.enabled).toBe(false);
    expect(prismaMock.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "news_classification_settings:org-1" },
      }),
    );
  });
});
