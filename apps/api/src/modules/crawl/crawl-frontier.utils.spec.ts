import {
  classifyFrontierFailureKind,
  computeFrontierPageTypeBudgets,
  inferFrontierPageType,
  isUtilityFrontierLinkText,
  normalizeCrawlSiteProfileConfig,
  prioritizeFrontierCandidates,
  resolveEffectiveLlmAssistConfig,
  resolveNodeQueueClass,
  scoreFrontierCandidate,
  shouldRejectFrontierUrl,
} from "./crawl-frontier.utils";
import type { CrawlSiteProfileConfig } from "./crawl.types";

describe("crawl-frontier.utils", () => {
  const config: CrawlSiteProfileConfig = {
    blockedDomains: ["ads.example.com"],
    urlPatterns: {
      category: ["https://www.npr.org/sections/*/"],
      list: ["https://www.npr.org/sections/*/?page=*"],
      article: ["https://www.npr.org/20*/*/*/*"],
    },
  };

  it("preserves deeper crawl capacity when maxPages is small", () => {
    expect(
      computeFrontierPageTypeBudgets({
        maxDepth: 3,
        maxPages: 6,
      }),
    ).toEqual({
      home: 1,
      category: 2,
      list: 1,
      article: 2,
    });
  });

  it("classifies section links discovered from list pages as list instead of article", () => {
    expect(
      inferFrontierPageType({
        url: "https://www.npr.org/sections/business",
        parentPageType: "list",
        config,
      }),
    ).toBe("list");
  });

  it("classifies series URLs as non-article hubs instead of articles", () => {
    expect(
      inferFrontierPageType({
        url: "https://www.theguardian.com/politics/series/politics-live-with-andrew-sparrow",
        parentPageType: "list",
        config,
      }),
    ).toBe("list");
  });

  it("still recognizes dated article URLs as articles", () => {
    expect(
      inferFrontierPageType({
        url: "https://www.npr.org/2026/03/18/politics/example-story",
        parentPageType: "list",
        config,
      }),
    ).toBe("article");
  });

  it("recognizes non-zero-padded dated article URLs as articles", () => {
    expect(
      inferFrontierPageType({
        url: "https://www.aljazeera.com/sports/2026/3/18/example-story",
        parentPageType: "home",
        config,
      }),
    ).toBe("article");
  });

  it("treats sitemap candidates with published timestamps as articles even when category patterns are broad", () => {
    expect(
      inferFrontierPageType({
        url: "https://www.reuters.com/business/eu-lawmakers-vote-progress-us-trade-deal-legislation-2026-03-19/",
        parentPageType: "home",
        config: {
          urlPatterns: {
            category: ["https://www.reuters.com/business/*"],
          },
        },
        publishedAtTs: Date.parse("2026-03-19T09:58:37.331Z"),
      }),
    ).toBe("article");
  });

  it("enables effective llm judge defaults when profile does not define llmAssist", () => {
    expect(resolveEffectiveLlmAssistConfig(config, "judge")).toEqual(
      expect.objectContaining({
        enabled: true,
        recallMode: "high_recall",
        minJudgeConfidence: 0.72,
        candidateBudgetByPageType: expect.objectContaining({
          home: 24,
          category: 24,
          list: 16,
          article: 0,
        }),
      }),
    );
    expect(resolveEffectiveLlmAssistConfig(config, "learn")).toBeUndefined();
  });

  it("keeps article detail fetches on the normal queue even when fresh", () => {
    expect(
      resolveNodeQueueClass({
        pageType: "article",
        freshnessScore: 1,
      }),
    ).toBe("normal");
    expect(
      resolveNodeQueueClass({
        pageType: "list",
        freshnessScore: 0.2,
      }),
    ).toBe("hot");
  });

  it("allows same registrable-domain subdomains while rejecting external hosts", () => {
    expect(
      shouldRejectFrontierUrl({
        url: "https://m.npr.org/2026/03/18/world/example-story",
        config,
        requireSameDomainHost: "www.npr.org",
      }),
    ).toBeNull();
    expect(
      shouldRejectFrontierUrl({
        url: "https://www.evil-example.org/story",
        config,
        requireSameDomainHost: "www.npr.org",
      }),
    ).toBe("cross_domain");
  });

  it("respects explicitly allowed hosts and blocked domains", () => {
    expect(
      shouldRejectFrontierUrl({
        url: "https://edition.npr.org/news",
        config: {
          ...config,
          allowedHosts: ["edition.npr.org"],
        },
        requireSameDomainHost: "www.npr.org",
      }),
    ).toBeNull();
    expect(
      shouldRejectFrontierUrl({
        url: "https://ads.example.com/banner",
        config,
        requireSameDomainHost: "www.npr.org",
      }),
    ).toBe("cross_domain");
  });

  it("supports strict host allowlists when allowedDomains are omitted", () => {
    expect(
      shouldRejectFrontierUrl({
        url: "https://www.aljazeera.com/news",
        config: {
          ...config,
          allowedHosts: ["www.aljazeera.com"],
          allowedDomains: undefined,
        },
        requireSameDomainHost: "www.aljazeera.com",
      }),
    ).toBeNull();
    expect(
      shouldRejectFrontierUrl({
        url: "https://liberties.aljazeera.com/en",
        config: {
          ...config,
          allowedHosts: ["www.aljazeera.com"],
          allowedDomains: undefined,
        },
        requireSameDomainHost: "www.aljazeera.com",
      }),
    ).toBe("cross_domain");
  });

  it("supports explicit strict host scope even when allowed domains are present", () => {
    expect(
      shouldRejectFrontierUrl({
        url: "https://www.aljazeera.com/news",
        config: {
          ...config,
          hostScope: "strict_hosts",
          allowedHosts: ["www.aljazeera.com"],
          allowedDomains: ["aljazeera.com"],
        },
        requireSameDomainHost: "www.aljazeera.com",
      }),
    ).toBeNull();
    expect(
      shouldRejectFrontierUrl({
        url: "https://liberties.aljazeera.com/en",
        config: {
          ...config,
          hostScope: "strict_hosts",
          allowedHosts: ["www.aljazeera.com"],
          allowedDomains: ["aljazeera.com"],
        },
        requireSameDomainHost: "www.aljazeera.com",
      }),
    ).toBe("cross_domain");
  });

  it("rejects utility site URLs and utility link text", () => {
    expect(
      shouldRejectFrontierUrl({
        url: "https://www.npr.org/about",
        config,
        requireSameDomainHost: "www.npr.org",
      }),
    ).toBe("utility_url");
    expect(
      shouldRejectFrontierUrl({
        url: "https://www.aljazeera.com/code-of-ethics",
        config,
        requireSameDomainHost: "www.aljazeera.com",
      }),
    ).toBe("utility_url");
    expect(
      shouldRejectFrontierUrl({
        url: "https://apnews.com/video",
        config,
        requireSameDomainHost: "apnews.com",
      }),
    ).toBe("utility_url");
    expect(
      shouldRejectFrontierUrl({
        url: "https://apnews.com/accessibility-statement",
        config,
        requireSameDomainHost: "apnews.com",
      }),
    ).toBe("utility_url");
    expect(
      shouldRejectFrontierUrl({
        url: "https://www.theguardian.com/tabs-popular-0",
        config,
        requireSameDomainHost: "www.theguardian.com",
      }),
    ).toBe("utility_url");
    expect(
      shouldRejectFrontierUrl({
        url: "https://www.theguardian.com/profile/editorial",
        config,
        requireSameDomainHost: "www.theguardian.com",
      }),
    ).toBe("utility_url");
    expect(isUtilityFrontierLinkText("About NPR")).toBe(true);
    expect(isUtilityFrontierLinkText("Community Guidelines")).toBe(true);
    expect(isUtilityFrontierLinkText("Podcasts")).toBe(true);
    expect(isUtilityFrontierLinkText("Accessibility")).toBe(true);
    expect(isUtilityFrontierLinkText("Inside the Guardian")).toBe(true);
    expect(isUtilityFrontierLinkText("Editorial profile")).toBe(true);
    expect(isUtilityFrontierLinkText("Latest politics")).toBe(false);
  });

  it("rejects foreign locale sections when locale scope is configured", () => {
    expect(
      shouldRejectFrontierUrl({
        url: "https://www.bbc.com/zhongwen/articles/c123example",
        config: {
          ...config,
          localeScope: {
            locale: "en-GB",
            acceptLanguages: ["en-GB", "en"],
          },
        },
        requireSameDomainHost: "www.bbc.com",
      }),
    ).toBe("foreign_locale");
    expect(
      shouldRejectFrontierUrl({
        url: "https://arabic.cnn.com/world/article-example",
        config: {
          ...config,
          localeScope: {
            locale: "en-US",
            acceptLanguages: ["en-US", "en"],
          },
        },
        requireSameDomainHost: "edition.cnn.com",
      }),
    ).toBe("foreign_locale");
  });

  it("normalizes llm assist settings for active and shadow profiles", () => {
    const normalized = normalizeCrawlSiteProfileConfig({
      ...config,
      seedDiscovery: {
        strategy: "auto",
        mode: "robots",
        freshnessWindowHours: 72,
        maxSeedUrls: 40,
        topologyBudgetPages: 10,
        topologyBudgetDepth: 2,
        qualityThresholds: {
          minCandidates: 2,
          minArticleRatio: 0.5,
          maxNoiseRatio: 0.25,
          minFreshRatio: 0.4,
        },
      },
      llmAssist: {
        enabled: true,
        recallMode: "high_recall",
        minJudgeConfidence: 0.82,
        shadowEvaluationRuns: 4,
        candidateBudgetByPageType: {
          home: 20,
          category: 18,
          list: 12,
        },
        autoPublishThresholds: {
          minArticleLift: 0.2,
          minNoiseReduction: 0.3,
          minJudgeConfidence: 0.8,
        },
        shadow: {
          role: "shadow",
          shadowOfProfileId: "profile-active",
          state: "evaluating",
          evaluationRunsCompleted: 2,
          consecutivePasses: 1,
        },
      },
    });

    expect(normalized.llmAssist).toEqual(
      expect.objectContaining({
        enabled: true,
        recallMode: "high_recall",
        minJudgeConfidence: 0.82,
        shadowEvaluationRuns: 4,
        candidateBudgetByPageType: expect.objectContaining({
          home: 20,
          category: 18,
          list: 12,
        }),
        autoPublishThresholds: expect.objectContaining({
          minArticleLift: 0.2,
          minNoiseReduction: 0.3,
          minJudgeConfidence: 0.8,
        }),
        shadow: expect.objectContaining({
          role: "shadow",
          shadowOfProfileId: "profile-active",
          state: "evaluating",
          evaluationRunsCompleted: 2,
          consecutivePasses: 1,
        }),
      }),
    );
    expect(normalized.seedDiscovery).toEqual(
      expect.objectContaining({
        strategy: "auto",
        mode: "robots",
        freshnessWindowHours: 72,
        maxSeedUrls: 40,
        topologyBudgetPages: 10,
        topologyBudgetDepth: 2,
        qualityThresholds: expect.objectContaining({
          minCandidates: 2,
          minArticleRatio: 0.5,
          maxNoiseRatio: 0.25,
          minFreshRatio: 0.4,
        }),
      }),
    );
  });

  it("honors explicit locale deny patterns for multilingual portals", () => {
    expect(
      shouldRejectFrontierUrl({
        url: "https://www.bbc.com/mundo/articles/c123example",
        config: {
          ...config,
          localeScope: {
            locale: "en-GB",
            denyUrlPatterns: ["https://www.bbc.com/mundo/*"],
            denyHostPatterns: ["arabic.bbc.com"],
          },
        },
        requireSameDomainHost: "www.bbc.com",
      }),
    ).toBe("foreign_locale");
    expect(
      shouldRejectFrontierUrl({
        url: "https://arabic.bbc.com/news",
        config: {
          ...config,
          localeScope: {
            locale: "en-GB",
            denyUrlPatterns: ["https://www.bbc.com/mundo/*"],
            denyHostPatterns: ["arabic.bbc.com"],
          },
        },
        requireSameDomainHost: "www.bbc.com",
      }),
    ).toBe("foreign_locale");
  });

  it("prefers layered navigation targets over direct article jumps from home", () => {
    const categoryScore = scoreFrontierCandidate({
      url: "https://apnews.com/world-news",
      pageType: "category",
      parentPageType: "home",
      config,
      rawScore: 0.2,
      linkText: "World news",
    });
    const articleScore = scoreFrontierCandidate({
      url: "https://apnews.com/article/example-story",
      pageType: "article",
      parentPageType: "home",
      config,
      rawScore: 0.2,
      linkText: "Breaking story",
    });
    expect(categoryScore).toBeGreaterThan(articleScore);
  });

  it("prefers URLs that stay inside the parent's scoped path", () => {
    const inScopeScore = scoreFrontierCandidate({
      url: "https://www.bbc.com/news/world-asia",
      pageType: "category",
      parentPageType: "home",
      parentUrl: "https://www.bbc.com/news",
      config: {
        ...config,
        urlPatterns: {
          category: ["https://www.bbc.com/news/*"],
          article: ["https://www.bbc.com/news/articles/*"],
        },
      },
      rawScore: 3.5,
      linkText: "World",
    });
    const driftScore = scoreFrontierCandidate({
      url: "https://www.bbc.com/health",
      pageType: "category",
      parentPageType: "home",
      parentUrl: "https://www.bbc.com/news",
      config: {
        ...config,
        urlPatterns: {
          category: ["https://www.bbc.com/news/*"],
          article: ["https://www.bbc.com/news/articles/*"],
        },
      },
      rawScore: 3.8,
      linkText: "Health",
    });
    expect(inScopeScore).toBeGreaterThan(driftScore);
  });

  it("rejects deny keyword and signal matches before crawling them", () => {
    expect(
      shouldRejectFrontierUrl({
        url: "https://www.npr.org/newsletters/daily-briefing",
        config: {
          ...config,
          denyKeywords: ["newsletter"],
        },
        requireSameDomainHost: "www.npr.org",
        linkText: "Daily newsletter",
      }),
    ).toBe("utility_url");
    expect(
      shouldRejectFrontierUrl({
        url: "https://www.npr.org/special-project/partner-content",
        config: {
          ...config,
          pageTypeSignals: {
            deny: {
              patterns: ["partner-content"],
            },
          },
        },
        requireSameDomainHost: "www.npr.org",
      }),
    ).toBe("deny_signal");
  });

  it("prioritizes candidate ordering by parent stage before score", () => {
    expect(
      prioritizeFrontierCandidates({
        parentPageType: "home",
        candidates: [
          {
            url: "https://apnews.com/article/high-score",
            pageType: "article",
            score: 9,
            freshnessScore: 1,
          },
          {
            url: "https://apnews.com/world-news",
            pageType: "category",
            score: 5,
            freshnessScore: 0,
          },
          {
            url: "https://apnews.com/hub/politics",
            pageType: "list",
            score: 4,
            freshnessScore: 0,
          },
        ],
      }).map((entry) => entry.pageType),
    ).toEqual(["category", "list", "article"]);
  });

  it("classifies anti-bot and tunnel failures into stable failure kinds", () => {
    expect(
      classifyFrontierFailureKind(
        "URL blocked by SSRF protection: Hostname www.bbc.com resolves to private IP: 198.18.0.23",
      ),
    ).toBe("ssrf_blocked");
    expect(
      classifyFrontierFailureKind("HTTP 401 protected by DataDome"),
    ).toBe("challenge_detected");
    expect(
      classifyFrontierFailureKind("net::ERR_TUNNEL_CONNECTION_FAILED"),
    ).toBe("network_tunnel_error");
    expect(
      classifyFrontierFailureKind("Page.goto: net::ERR_CONNECTION_CLOSED"),
    ).toBe("network_tunnel_error");
    expect(classifyFrontierFailureKind("plain parse error")).toBeNull();
  });

  it("preserves native deep-crawl fallback settings in normalized config", () => {
    const normalized = normalizeCrawlSiteProfileConfig({
      localeScope: {
        locale: "en-GB",
        acceptLanguages: ["en-GB", "en"],
        denyUrlPatterns: ["https://www.bbc.com/zhongwen/*"],
      },
      nativeOptions: {
        deepCrawlStrategy: {
          type: "BFSDeepCrawlStrategy",
          params: { max_depth: 3 },
        },
        fallbackToLayered: true,
        minAcceptedResults: 2,
        minArticleResults: 1,
      },
    });

    expect(normalized.nativeOptions).toMatchObject({
      deepCrawlStrategy: {
        type: "BFSDeepCrawlStrategy",
        params: { max_depth: 3 },
      },
      fallbackToLayered: true,
      minAcceptedResults: 2,
      minArticleResults: 1,
    });
    expect(normalized.localeScope).toMatchObject({
      locale: "en-GB",
      acceptLanguages: ["en-GB", "en"],
      denyUrlPatterns: ["https://www.bbc.com/zhongwen/*"],
    });
  });
});
