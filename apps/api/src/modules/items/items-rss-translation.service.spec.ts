import { ProcessedItemModel } from "@modular/mongo";

import { RssTranslationField, RssTranslationProvider } from "../../graphql/dto/item.input";

import { ItemsRssTranslationService } from "./items-rss-translation.service";

jest.mock("@modular/mongo", () => ({
  ProcessedItemModel: {
    find: jest.fn()
  }
}));

function mockProcessedRecords(records: Array<{ itemMetaId: string; result: unknown }>) {
  const lean = jest.fn().mockResolvedValue(
    records.map((record) => ({
      ...record,
      createdAt: new Date("2024-01-01T00:00:00.000Z")
    }))
  );
  const sort = jest.fn().mockReturnValue({ lean });
  (ProcessedItemModel.find as jest.Mock).mockReturnValue({ sort });
}

function createMemoryCache() {
  const store = new Map<string, unknown>();
  return {
    getMany: jest.fn(async (keys: string[]) => keys.map((key) => store.get(key) ?? null)),
    set: jest.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    __store: store
  };
}

describe("ItemsRssTranslationService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns provider unavailable status when DeepLX target language is unsupported", async () => {
    const cache = createMemoryCache();
    const service = new ItemsRssTranslationService(
      cache as any,
      { translateTextsToZhBestEffort: jest.fn() } as any,
      {
        getTranslationMaxConcurrency: jest.fn().mockResolvedValue(2),
        getTranslationRuntimeConfig: jest.fn().mockResolvedValue({
          enabled: true,
          baseUrl: "https://api.deeplx.org",
          apiKey: "secret"
        })
      } as any,
      { getActiveConfig: jest.fn().mockResolvedValue({ model: "model-a" }) } as any,
      { acompletion: jest.fn() } as any
    );

    const statuses = await service.getProviderStatuses("en");
    const deepLx = statuses.find((status) => status.provider === RssTranslationProvider.deeplx);

    expect(deepLx).toMatchObject({
      available: false,
      targetLanguageSupported: false
    });
    expect(deepLx?.message).toContain("supports Chinese");
  });

  it("caches LLM translations and avoids duplicate upstream requests", async () => {
    mockProcessedRecords([
      {
        itemMetaId: "item-1",
        result: {
          title: "Hello world"
        }
      }
    ]);

    const cache = createMemoryCache();
    const acompletion = jest.fn().mockResolvedValue({
      choices: [{ message: { content: "你好，世界" } }]
    });

    const service = new ItemsRssTranslationService(
      cache as any,
      { translateTextsToZhBestEffort: jest.fn() } as any,
      {
        getTranslationMaxConcurrency: jest.fn().mockResolvedValue(2),
        getTranslationRuntimeConfig: jest.fn().mockResolvedValue({
          enabled: true,
          baseUrl: "https://api.deeplx.org",
          apiKey: "secret"
        })
      } as any,
      { getActiveConfig: jest.fn().mockResolvedValue({ model: "test-model", enabled: true }) } as any,
      { acompletion } as any
    );

    const first = await service.translate("org-1", {
      itemIds: ["item-1"],
      provider: RssTranslationProvider.llm,
      targetLanguage: "zh-CN",
      fields: [RssTranslationField.title]
    });
    const second = await service.translate("org-1", {
      itemIds: ["item-1"],
      provider: RssTranslationProvider.llm,
      targetLanguage: "zh-CN",
      fields: [RssTranslationField.title]
    });

    expect(first.translations[0]?.title).toBe("你好，世界");
    expect(second.translations[0]?.title).toBe("你好，世界");
    expect(acompletion).toHaveBeenCalledTimes(1);
  });

  it("translates cleaned markdown in chunks and merges translated chunks", async () => {
    const longParagraph = "A".repeat(1700);
    mockProcessedRecords([
      {
        itemMetaId: "item-2",
        result: {
          cleaned_markdown: `${longParagraph}\n\nSecond paragraph`
        }
      }
    ]);

    const cache = createMemoryCache();
    let callCount = 0;
    const acompletion = jest.fn().mockImplementation(async () => {
      callCount += 1;
      return { choices: [{ message: { content: `段落${callCount}翻译` } }] };
    });

    const service = new ItemsRssTranslationService(
      cache as any,
      { translateTextsToZhBestEffort: jest.fn() } as any,
      {
        getTranslationMaxConcurrency: jest.fn().mockResolvedValue(2),
        getTranslationRuntimeConfig: jest.fn().mockResolvedValue({
          enabled: true,
          baseUrl: "https://api.deeplx.org",
          apiKey: "secret"
        })
      } as any,
      { getActiveConfig: jest.fn().mockResolvedValue({ model: "test-model", enabled: true }) } as any,
      { acompletion } as any
    );

    const result = await service.translate("org-1", {
      itemIds: ["item-2"],
      provider: RssTranslationProvider.llm,
      targetLanguage: "zh-CN",
      fields: [RssTranslationField.cleaned_markdown]
    });

    expect(result.translations[0]?.cleanedMarkdown).toContain("段落1翻译");
    expect(acompletion.mock.calls.length).toBeGreaterThan(1);
  });

  it("throws friendly error when selected provider is unavailable", async () => {
    const cache = createMemoryCache();
    const service = new ItemsRssTranslationService(
      cache as any,
      { translateTextsToZhBestEffort: jest.fn() } as any,
      {
        getTranslationMaxConcurrency: jest.fn().mockResolvedValue(2),
        getTranslationRuntimeConfig: jest.fn().mockResolvedValue({
          enabled: false,
          baseUrl: "https://api.deeplx.org",
          apiKey: "secret"
        })
      } as any,
      { getActiveConfig: jest.fn().mockResolvedValue(null) } as any,
      { acompletion: jest.fn() } as any
    );

    await expect(
      service.translate("org-1", {
        itemIds: ["item-3"],
        provider: RssTranslationProvider.deeplx,
        targetLanguage: "zh-CN",
        fields: [RssTranslationField.title]
      })
    ).rejects.toThrow("DeepLX translation API is disabled");
  });

  it("limits LLM translation concurrency based on Situation Monitor max concurrency", async () => {
    mockProcessedRecords([
      {
        itemMetaId: "item-4",
        result: {
          key_points: ["one", "two", "three", "four", "five", "six"]
        }
      }
    ]);

    const cache = createMemoryCache();
    let active = 0;
    let maxActive = 0;
    const acompletion = jest.fn().mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { choices: [{ message: { content: "ok" } }] };
    });

    const service = new ItemsRssTranslationService(
      cache as any,
      { translateTextsToZhBestEffort: jest.fn() } as any,
      {
        getTranslationMaxConcurrency: jest.fn().mockResolvedValue(1),
        getTranslationRuntimeConfig: jest.fn().mockResolvedValue({
          enabled: true,
          baseUrl: "https://api.deeplx.org",
          apiKey: "secret"
        })
      } as any,
      { getActiveConfig: jest.fn().mockResolvedValue({ model: "test-model", enabled: true }) } as any,
      { acompletion } as any
    );

    await service.translate("org-1", {
      itemIds: ["item-4"],
      provider: RssTranslationProvider.llm,
      targetLanguage: "zh-CN",
      fields: [RssTranslationField.key_points]
    });

    expect(maxActive).toBe(1);
    expect(acompletion).toHaveBeenCalledTimes(6);
  });
});
