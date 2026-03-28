import axios from "axios";
import { createHash } from "node:crypto";

import { SituationMonitorTranslationService } from "../situation-monitor-translation.service";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const TRANSLATION_CACHE_KEY_PREFIX = "situation-monitor:translation:v3:zh-cn:multi";

describe("SituationMonitorTranslationService", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("translates plain text lists via shared situation monitor translation pipeline", async () => {
    const cacheStore = new Map<string, string>();
    const cacheMock = {
      get: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
      set: jest.fn(async () => undefined),
    } as any;
    const settingsMock = {
      getTranslationRuntimeConfig: jest.fn(async () => ({
        provider: "deeplx",
        maxConcurrency: 2,
        enabled: true,
        baseUrl: "https://api.deeplx.org",
        apiKey: "test-key",
        fallbackEnabled: false,
        fallbackBaseUrl: undefined,
        timeoutMs: 15_000,
        maxRetries: 1,
      })),
    } as any;
    const axiosPostSpy = jest.spyOn(axios, "post");
    const service = new SituationMonitorTranslationService(cacheMock, settingsMock);

    cacheStore.set(
      `${TRANSLATION_CACHE_KEY_PREFIX}:${sha256("Example headline")}`,
      "示例标题",
    );

    const result = await service.translateTextsToZhBestEffort(["Example headline"]);

    expect(result.get("Example headline")).toBe("示例标题");
    expect(settingsMock.getTranslationRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(axiosPostSpy).not.toHaveBeenCalled();
  });

  it("applies zh fields for additional situation monitor strings (best-effort)", async () => {
    const cacheStore = new Map<string, string>();
    const axiosPostSpy = jest.spyOn(axios, "post");
    const cacheMock = {
      get: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
        cacheStore.set(key, value);
      }),
    } as any;

    const settingsMock = {
      getTranslationRuntimeConfig: jest.fn(async () => ({
        provider: "deeplx",
        maxConcurrency: 2,
        enabled: true,
        baseUrl: "https://api.deeplx.org",
        apiKey: "test-key",
        fallbackEnabled: false,
        fallbackBaseUrl: undefined,
        timeoutMs: 15_000,
        maxRetries: 1,
      })),
    } as any;

    const service = new SituationMonitorTranslationService(cacheMock, settingsMock);

    const fedTitle = "Federal Reserve issues FOMC statement";
    const fedDesc = "Federal Reserve issues FOMC statement";
    const fedTypeLabel = "Monetary Policy";
    const correlationName = "Russia Ukraine";
    const correlationPrediction = "Topic gaining mainstream traction";
    const correlationStatus = "5 SIGNALS";
    const narrativeName = "Immigration";
    const narrativeStatus = "MONITORING";
    const mainCharacterStatus = "Trump (36 mentions)";
    const headlineTitle = "Example headline";

    const toCacheKey = (text: string) => `${TRANSLATION_CACHE_KEY_PREFIX}:${sha256(text.trim())}`;
    const seed = (text: string, zh: string) => {
      cacheStore.set(toCacheKey(text), zh);
    };

    seed(fedTitle, "美联储发布FOMC声明");
    seed(fedDesc, "美联储发布FOMC声明");
    seed(fedTypeLabel, "货币政策");
    seed(correlationName, "俄乌");
    seed(correlationPrediction, "话题正在进入主流");
    seed(correlationStatus, "5 个信号");
    seed(narrativeName, "移民");
    seed(narrativeStatus, "监控中");
    seed(mainCharacterStatus, "Trump（提及 36 次）");
    seed(headlineTitle, "示例标题");

    const insights: any = {
      generatedAt: new Date().toISOString(),
      windowHours: 24,
      maxItems: 400,
      analyzedItems: 0,
      clusters: {
        politics: [
          {
            id: "cluster-1",
            category: "politics",
            lead: {
              id: "headline-1",
              title: headlineTitle,
              summary: headlineTitle,
              link: "https://example.com",
              source: "X",
              timestamp: Date.now(),
              origin: "items",
              category: "politics",
              isAlert: false,
            },
            items: [
              {
                id: "headline-1",
                title: headlineTitle,
                summary: headlineTitle,
                link: "https://example.com",
                source: "X",
                timestamp: Date.now(),
                origin: "items",
                category: "politics",
                isAlert: false,
              },
            ],
            internalCount: 1,
            externalCount: 0,
            distinctSourceCount: 1,
            latestTimestamp: Date.now(),
            isAlert: false,
            mixedSource: false,
          },
        ],
      },
      fed: {
        hasFredApiKey: true,
        indicators: [],
        moneyPrinter: null,
        news: [
          {
            id: "fed-1",
            title: fedTitle,
            link: "https://example.com",
            description: fedDesc,
            pubDate: "Tue, 27 Jan 2026 00:00:00 GMT",
            timestamp: Date.now(),
            type: "monetary",
            typeLabel: fedTypeLabel,
            isPowellRelated: false,
            hasVideo: false,
          },
        ],
      },
      correlation: {
        emergingPatterns: [
          {
            id: "topic-1",
            name: correlationName,
            category: "Conflict",
            count: 1,
            level: "emerging",
            sources: [],
            headlines: [{ title: headlineTitle, link: "https://example.com", source: "X" }],
          },
        ],
        momentumSignals: [],
        crossSourceCorrelations: [],
        predictiveSignals: [
          {
            id: "topic-1",
            name: correlationName,
            category: "Conflict",
            score: 20,
            confidence: 80,
            prediction: correlationPrediction,
            level: "high",
            headlines: [{ title: headlineTitle, link: "https://example.com", source: "X" }],
          },
        ],
      },
      correlationSummary: { totalSignals: 5, status: correlationStatus },
      narrative: {
        emergingFringe: [],
        fringeToMainstream: [],
        disinfoSignals: [],
        narrativeWatch: [
          {
            id: "narrative-1",
            name: narrativeName,
            category: "Society",
            severity: "watch",
            count: 1,
            fringeCount: 0,
            alternativeCount: 0,
            mainstreamCount: 0,
            sources: [],
            headlines: [{ title: headlineTitle, link: "https://example.com", source: "X" }],
            keywords: [],
          },
        ],
      },
      narrativeSummary: { total: 0, status: narrativeStatus },
      mainCharacterSummary: { name: "Trump", count: 36, status: mainCharacterStatus },
    };

    const result = await service.applyZhTranslationsBestEffort(insights);
    expect(result.applied).toBe(true);

    const fed = insights.fed.news[0];
    expect(fed.titleZh).toBe("美联储发布FOMC声明");
    expect(fed.descriptionZh).toBe("美联储发布FOMC声明");
    expect(fed.typeLabelZh).toBe("货币政策");

    expect(insights.correlation.emergingPatterns[0].nameZh).toBe("俄乌");
    expect(insights.correlation.predictiveSignals[0].nameZh).toBe("俄乌");
    expect(insights.correlation.predictiveSignals[0].predictionZh).toBe("话题正在进入主流");
    expect(insights.correlationSummary.statusZh).toBe("5 个信号");

    expect(insights.narrative.narrativeWatch[0].nameZh).toBe("移民");
    expect(insights.narrativeSummary.statusZh).toBe("监控中");
    expect(insights.mainCharacterSummary.statusZh).toBe("Trump（提及 36 次）");
    expect(insights.clusters.politics[0].lead.titleZh).toBe("示例标题");
    expect(insights.clusters.politics[0].items[0].titleZh).toBe("示例标题");

    expect(settingsMock.getTranslationRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(axiosPostSpy).not.toHaveBeenCalled();
  });

  it("calls DeepLX and writes cache for missing translations", async () => {
    const cacheStore = new Map<string, string>();
    const cacheMock = {
      get: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
        cacheStore.set(key, value);
      }),
    } as any;
    const axiosPostSpy = jest.spyOn(axios, "post").mockResolvedValue({
      status: 200,
      data: { code: 200, data: "示例标题" },
    } as any);

    const settingsMock = {
      getTranslationRuntimeConfig: jest.fn(async () => ({
        provider: "deeplx",
        maxConcurrency: 2,
        enabled: true,
        baseUrl: "https://api.deeplx.org",
        apiKey: "test-key",
        fallbackEnabled: false,
        fallbackBaseUrl: undefined,
        timeoutMs: 15_000,
        maxRetries: 0,
      })),
    } as any;

    const service = new SituationMonitorTranslationService(cacheMock, settingsMock);
    const insights: any = {
      generatedAt: new Date().toISOString(),
      windowHours: 24,
      maxItems: 400,
      analyzedItems: 0,
      headlines: {
        conflict: [{ title: "Example headline" }],
      },
    };

    const result = await service.applyZhTranslationsBestEffort(insights);
    expect(result).toEqual({ applied: true });
    expect(insights.headlines.conflict[0].titleZh).toBe("示例标题");
    expect(axiosPostSpy).toHaveBeenCalledWith(
      "https://api.deeplx.org/test-key/translate",
      { text: "Example headline", source_lang: "auto", target_lang: "ZH" },
      expect.objectContaining({ timeout: 15_000 }),
    );
    expect(cacheMock.set).toHaveBeenCalledTimes(1);
  });

  it("returns best-effort error when translation API is disabled", async () => {
    const cacheMock = {
      get: jest.fn(async () => null),
      set: jest.fn(async () => undefined),
    } as any;
    const settingsMock = {
      getTranslationRuntimeConfig: jest.fn(async () => ({
        provider: "deeplx",
        maxConcurrency: 2,
        enabled: false,
        baseUrl: "https://api.deeplx.org",
        apiKey: "test-key",
        fallbackEnabled: false,
        fallbackBaseUrl: undefined,
        timeoutMs: 15_000,
        maxRetries: 0,
      })),
    } as any;
    const axiosPostSpy = jest.spyOn(axios, "post");

    const service = new SituationMonitorTranslationService(cacheMock, settingsMock);
    const insights: any = {
      generatedAt: new Date().toISOString(),
      windowHours: 24,
      maxItems: 400,
      analyzedItems: 0,
      headlines: {
        conflict: [{ title: "Example headline" }],
      },
    };

    const result = await service.applyZhTranslationsBestEffort(insights);
    expect(result.applied).toBe(false);
    expect(result.error).toBe("Translation APIs are disabled");
    expect(axiosPostSpy).not.toHaveBeenCalled();
  });

  it("falls back to backup translation API when DeepLX fails", async () => {
    const cacheStore = new Map<string, string>();
    const cacheMock = {
      get: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
        cacheStore.set(key, value);
      }),
    } as any;

    const axiosPostSpy = jest.spyOn(axios, "post");
    axiosPostSpy
      .mockResolvedValueOnce({ status: 500, data: { error: "upstream failure" } } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: { translations: [{ detected_source_lang: "en", text: "示例标题" }] },
      } as any);

    const settingsMock = {
      getTranslationRuntimeConfig: jest.fn(async () => ({
        provider: "deeplx",
        maxConcurrency: 2,
        enabled: true,
        baseUrl: "https://api.deeplx.org",
        apiKey: "test-key",
        fallbackEnabled: true,
        fallbackBaseUrl: "https://translates.shisihua.dpdns.org/backup/v1",
        timeoutMs: 15_000,
        maxRetries: 0,
      })),
    } as any;

    const service = new SituationMonitorTranslationService(cacheMock, settingsMock);
    const insights: any = {
      generatedAt: new Date().toISOString(),
      windowHours: 24,
      maxItems: 400,
      analyzedItems: 0,
      headlines: {
        conflict: [{ title: "Example headline" }],
      },
    };

    const result = await service.applyZhTranslationsBestEffort(insights);
    expect(result).toEqual({ applied: true });
    expect(insights.headlines.conflict[0].titleZh).toBe("示例标题");

    expect(axiosPostSpy).toHaveBeenNthCalledWith(
      1,
      "https://api.deeplx.org/test-key/translate",
      { text: "Example headline", source_lang: "auto", target_lang: "ZH" },
      expect.objectContaining({ timeout: 15_000 })
    );
    expect(axiosPostSpy).toHaveBeenNthCalledWith(
      2,
      "https://translates.shisihua.dpdns.org/backup/v1",
      { source_lang: "en", target_lang: "zh-CN", text_list: ["Example headline"] },
      expect.objectContaining({ timeout: 15_000 })
    );
  });

  it("uses backup translation API when DeepLX is disabled but fallback is configured", async () => {
    const cacheStore = new Map<string, string>();
    const cacheMock = {
      get: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
        cacheStore.set(key, value);
      }),
    } as any;

    const axiosPostSpy = jest.spyOn(axios, "post").mockResolvedValue({
      status: 200,
      data: { translations: [{ detected_source_lang: "ja", text: "日本银行维持了政策。" }] },
    } as any);

    const settingsMock = {
      getTranslationRuntimeConfig: jest.fn(async () => ({
        provider: "deeplx",
        maxConcurrency: 2,
        enabled: false,
        baseUrl: "https://api.deeplx.org",
        apiKey: "test-key",
        fallbackEnabled: true,
        fallbackBaseUrl: "https://translates.shisihua.dpdns.org/backup/v1",
        timeoutMs: 15_000,
        maxRetries: 0,
      })),
    } as any;

    const service = new SituationMonitorTranslationService(cacheMock, settingsMock);
    const insights: any = {
      generatedAt: new Date().toISOString(),
      windowHours: 24,
      maxItems: 400,
      analyzedItems: 0,
      headlines: {
        conflict: [{ title: "日本銀行は政策を維持した。" }],
      },
    };

    const result = await service.applyZhTranslationsBestEffort(insights);
    expect(result).toEqual({ applied: true });
    expect(insights.headlines.conflict[0].titleZh).toBe("日本银行维持了政策。");
    expect(axiosPostSpy).toHaveBeenCalledTimes(1);
    expect(axiosPostSpy).toHaveBeenCalledWith(
      "https://translates.shisihua.dpdns.org/backup/v1",
      { source_lang: "ja", target_lang: "zh-CN", text_list: ["日本銀行は政策を維持した。"] },
      expect.objectContaining({ timeout: 15_000 })
    );
  });
});
