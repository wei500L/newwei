import { createHash } from "node:crypto";

import { SituationMonitorTranslationService } from "../situation-monitor-translation.service";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const TRANSLATION_CACHE_KEY_PREFIX = "situation-monitor:translation:v1:zh-cn";

describe("SituationMonitorTranslationService", () => {
  it("applies zh fields for additional situation monitor strings (best-effort)", async () => {
    const cacheStore = new Map<string, string>();
    const cacheMock = {
      get: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
        cacheStore.set(key, value);
      }),
    } as any;

    const llmMock = {
      acompletion: jest.fn(),
    } as any;

    const settingsMock = {
      getTranslationMaxConcurrency: jest.fn(async () => 2),
    } as any;

    const service = new SituationMonitorTranslationService(cacheMock, llmMock, settingsMock);

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

    expect(settingsMock.getTranslationMaxConcurrency).toHaveBeenCalledTimes(1);
    expect(llmMock.acompletion).not.toHaveBeenCalled();
  });
});

