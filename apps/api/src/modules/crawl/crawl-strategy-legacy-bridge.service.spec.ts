import { CrawlStrategyLegacyBridgeService } from "./crawl-strategy-legacy-bridge.service";

describe("CrawlStrategyLegacyBridgeService", () => {
  const service = new CrawlStrategyLegacyBridgeService();

  it("maps profile strategy into workflow nodes and settings", () => {
    const definition = service.buildWorkflowFromProfile(
      {
        name: "Example Profile",
        description: "Profile description",
        executionMode: "hybrid",
        config: {
          blockedDomains: ["cdn.example.com"],
          allowedHosts: ["news.example.com"],
          denyKeywords: ["sports"],
          keywords: ["finance"],
          priorityKeywords: ["market"],
          freshnessRules: {
            recentHours: 12,
            weekHours: 96,
            monthHours: 480,
          },
          layeredOptions: {
            maxDepth: 4,
            maxPages: 88,
            scoreThreshold: 0.35,
          },
          crawlOptions: {
            check_robots_txt: false,
          },
        },
      },
      "https://news.example.com",
    );

    expect(definition.settings.executionMode).toBe("hybrid");
    expect(definition.settings.maxDepth).toBe(4);
    expect(definition.settings.maxPages).toBe(88);
    expect(definition.settings.robotsPolicy).toBe("ignore");

    const urlFilter = definition.nodes.find((node) => node.type === "url-filter");
    const freshness = definition.nodes.find(
      (node) => node.type === "freshness-scorer",
    );
    const budget = definition.nodes.find(
      (node) => node.type === "budget-control",
    );

    expect(urlFilter?.config).toEqual(
      expect.objectContaining({
        blockedDomains: ["cdn.example.com"],
        allowedHosts: ["news.example.com"],
        denyKeywords: ["sports"],
      }),
    );
    expect(freshness?.config).toEqual(
      expect.objectContaining({
        recentHours: 12,
        weekHours: 96,
        monthHours: 480,
      }),
    );
    expect(budget?.config).toEqual(
      expect.objectContaining({
        maxDepth: 4,
        maxPages: 88,
        minScore: 0.35,
      }),
    );
  });

  it("maps deep news source seed into deep-discovery workflow node", () => {
    const definition = service.buildWorkflowFromNewsSource({
      url: "https://example.com/news",
      config: {
        keywords: ["policy", "economy"],
        seed: {
          enabled: true,
          mode: "deep",
          domain: "https://example.com",
          pattern: "/news/*",
          query: "macro economy",
          maxUrls: 120,
          maxNewUrlsPerRun: 30,
          scoreThreshold: 0.25,
          deep: {
            maxPages: 140,
            maxDepth: 3,
          },
        },
      },
      crawlOptions: {
        headless: true,
      },
    });

    const discovery = definition.nodes.find(
      (node) => node.type === "deep-discovery",
    );
    const scorer = definition.nodes.find((node) => node.type === "url-scorer");
    const budget = definition.nodes.find(
      (node) => node.type === "budget-control",
    );

    expect(discovery?.config).toEqual(
      expect.objectContaining({
        seedUrl: "https://example.com/news",
        domain: "https://example.com",
        pattern: "/news/*",
        query: "macro economy",
        maxUrls: 120,
      }),
    );
    expect(scorer?.config).toEqual(
      expect.objectContaining({
        keywordBoosts: ["policy", "economy"],
      }),
    );
    expect(budget?.config).toEqual(
      expect.objectContaining({
        keepTopK: 30,
        minScore: 0.25,
      }),
    );
  });
});
