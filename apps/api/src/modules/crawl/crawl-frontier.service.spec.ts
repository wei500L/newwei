/* eslint-disable @typescript-eslint/no-explicit-any */
import { CrawlFrontierService } from "./crawl-frontier.service";

describe("CrawlFrontierService", () => {
  const createService = (frontierLlm?: Record<string, unknown>) => {
    const prisma = {
      crawlFrontierRun: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      crawlFrontierNode: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      },
      crawlTask: {
        findUnique: jest.fn(),
      },
    } as any;
    const profiles = {
      getProfile: jest.fn(),
      findProfileForUrl: jest.fn(),
    } as any;
    const queueService = {
      enqueueFrontierNode: jest.fn().mockResolvedValue(undefined),
    } as any;
    const metadataService = {
      discoverSitemap: jest.fn().mockResolvedValue({
        candidates: [],
        diagnostics: {
          discoveryMode: "robots",
          seedMethod: "none",
          robotsDiscoveredSitemaps: [],
          attemptedSitemaps: [],
          fetchedSitemaps: [],
          parsedSitemaps: 0,
          candidateCount: 0,
        },
      }),
    } as any;
    const service = new CrawlFrontierService(
      prisma,
      profiles,
      {} as any,
      {} as any,
      queueService,
      metadataService,
      frontierLlm as any,
    );
    return {
      service,
      prisma,
      profiles,
      queueService,
      metadataService,
      frontierLlm,
    };
  };

  it("caps shallow category expansion so article budget remains available", async () => {
    const { service, prisma, queueService } = createService();
    prisma.crawlFrontierNode.findMany.mockResolvedValue([
      {
        canonicalUrl: "https://www.npr.org/sections/news/",
        urlFingerprint: "seed",
        pageType: "home",
      },
    ]);
    prisma.crawlFrontierNode.create.mockImplementation(async ({ data }: any) => ({
      id: `node-${data.url}`,
      ...data,
    }));
    jest.spyOn(service as any, "extractCandidates").mockReturnValue({
      candidates: [
        {
          url: "https://www.npr.org/sections/a",
          pageType: "category",
          score: 5,
          freshnessScore: 0,
          metadata: {},
        },
        {
          url: "https://www.npr.org/sections/b",
          pageType: "category",
          score: 4,
          freshnessScore: 0,
          metadata: {},
        },
        {
          url: "https://www.npr.org/sections/c",
          pageType: "category",
          score: 3,
          freshnessScore: 0,
          metadata: {},
        },
        {
          url: "https://www.npr.org/sections/d",
          pageType: "category",
          score: 2,
          freshnessScore: 0,
          metadata: {},
        },
      ],
      diagnostics: {
        candidateStats: {
          scanned: 4,
          unique: 4,
          accepted: 4,
          selected: 4,
          rejected: 0,
          trimmed: 0,
        },
        rejectionCounts: {},
        acceptedPageTypeCounts: {
          home: 0,
          category: 4,
          list: 0,
          article: 0,
        },
        warningFlags: [],
        syntheticListActivated: false,
      },
    });

    await (service as any).discoverChildNodes({
      node: {
        id: "seed-node",
        orgId: "org-1",
        url: "https://www.npr.org/sections/news/",
        pageType: "home",
        depth: 0,
      },
      runId: "run-1",
      taskId: "task-1",
      maxDepth: 3,
      maxPages: 6,
      profile: {
        config: {
          layeredOptions: {
            paginationKeepCount: 2,
          },
          urlPatterns: {
            category: ["https://www.npr.org/sections/*"],
          },
        },
      },
      results: [],
    });

    expect(prisma.crawlFrontierNode.create).toHaveBeenCalledTimes(2);
    expect(
      prisma.crawlFrontierNode.create.mock.calls.map(
        ([entry]: [Record<string, any>]) => entry.data.url,
      ),
    ).toEqual([
      "https://www.npr.org/sections/a",
      "https://www.npr.org/sections/b",
    ]);
    expect(queueService.enqueueFrontierNode).toHaveBeenCalledTimes(2);
  });

  it("filters utility links and self-equivalent URLs during candidate extraction", () => {
    const { service } = createService();

    const extraction = (service as any).extractCandidates(
      {
        id: "seed-node",
        orgId: "org-1",
        url: "https://www.npr.org/sections/news/",
        pageType: "home",
        depth: 0,
      },
      {
        keywords: ["news"],
        allowedDomains: ["npr.org"],
        layeredOptions: {
          scoreThreshold: 0.25,
          maxChildrenPerNode: 10,
        },
        urlPatterns: {
          home: ["https://www.npr.org/sections/news/"],
          category: ["https://www.npr.org/sections/*/"],
          article: ["https://www.npr.org/20*/*/*/*"],
        },
      },
      [
        {
          url: "https://www.npr.org/sections/news/",
          links: {
            internal: [
              {
                href: "https://www.npr.org/about",
                text: "About NPR",
                totalScore: 0.9,
              },
              {
                href: "https://www.npr.org/sections/news",
                text: "News",
                totalScore: 0.9,
              },
              {
                href: "https://www.npr.org/2026/03/18/politics/example-story",
                text: "Politics update",
                totalScore: 0.6,
              },
            ],
          },
        },
      ],
    );

    expect(extraction.candidates).toHaveLength(1);
    expect(extraction.candidates[0]).toMatchObject({
      url: "https://www.npr.org/2026/03/18/politics/example-story",
      pageType: "article",
    });
  });

  it("orders home candidates to prefer category expansion before direct articles", () => {
    const { service } = createService();

    const extraction = (service as any).extractCandidates(
      {
        id: "seed-node",
        orgId: "org-1",
        url: "https://apnews.com/",
        pageType: "home",
        depth: 0,
      },
      {
        keywords: ["news", "world"],
        allowedDomains: ["apnews.com"],
        layeredOptions: {
          scoreThreshold: 0.1,
          maxChildrenPerNode: 10,
        },
        urlPatterns: {
          home: ["https://apnews.com/"],
          category: ["https://apnews.com/world-news"],
          article: ["https://apnews.com/article/*"],
        },
      },
      [
        {
          url: "https://apnews.com/",
          links: {
            internal: [
              {
                href: "https://apnews.com/article/example-story",
                text: "Breaking story",
                totalScore: 0.3,
              },
              {
                href: "https://apnews.com/world-news",
                text: "World news",
                totalScore: 0.2,
              },
            ],
          },
        },
      ],
    );

    expect(
      extraction.candidates.map((entry: { url: string }) => entry.url),
    ).toEqual([
      "https://apnews.com/world-news",
      "https://apnews.com/article/example-story",
    ]);
  });

  it("applies dom scopes and exclusion pruning to category/list crawl options", () => {
    const { service } = createService();

    const categoryOptions = (service as any).buildLayeredCrawlOptions(
      {
        localeScope: {
          locale: "en-GB",
          acceptLanguages: ["en-GB", "en"],
          denyUrlPatterns: ["https://www.aljazeera.com/arabic/*"],
        },
        priorityKeywords: ["breaking", "war", "markets"],
        urlPatterns: {
          category: ["https://www.aljazeera.com/news/*"],
          article: ["https://www.aljazeera.com/*/20*/*/*/*"],
          exclude: ["https://www.aljazeera.com/podcasts/*"],
        },
        domLinkScopes: ["main", "article", "[role='main']"],
        domLinkExcludeSelectors: ["nav", ".sidebar", ".newsletter"],
      },
      "category",
    );

    const homeOptions = (service as any).buildLayeredCrawlOptions(
      {
        domLinkScopes: ["main", "article", "[role='main']"],
        domLinkExcludeSelectors: ["nav", ".sidebar", ".newsletter"],
      },
      "home",
    );

    expect(categoryOptions.cssSelector).toBe("main, article, [role='main']");
    expect(categoryOptions.jsCode).toHaveLength(1);
    expect(categoryOptions.jsCode?.[0]).toContain("document.querySelectorAll");
    expect(categoryOptions.jsCode?.[0]).toContain(".sidebar");
    expect(categoryOptions.waitForSelector).toBe("main, article, [role='main']");
    expect(categoryOptions.linkPreview).toMatchObject({
      includeInternal: true,
      includeExternal: false,
      query: "breaking war markets",
      includePatterns: expect.arrayContaining([
        "https://www.aljazeera.com/news/*",
        "https://www.aljazeera.com/*/20*/*/*/*",
      ]),
      excludePatterns: expect.arrayContaining([
        "https://www.aljazeera.com/podcasts/*",
        "https://www.aljazeera.com/arabic/*",
      ]),
    });
    expect(categoryOptions.markdownFilter).toMatchObject({
      type: "bm25",
      userQuery: "breaking war markets",
      language: "english",
    });
    expect(categoryOptions.locale).toBe("en-GB");
    expect(categoryOptions.browserHeaders).toEqual(
      expect.arrayContaining([
        {
          name: "Accept-Language",
          value: "en-GB,en",
        },
      ]),
    );
    expect(categoryOptions.userAgentGenerator).toMatchObject({
      locale: "en-GB",
    });
    expect(homeOptions.cssSelector).toBeUndefined();
    expect(homeOptions.jsCode).toBeUndefined();
    expect(homeOptions.linkPreview).toBeUndefined();
  });

  it("preserves manual locale and markdown controls over auto defaults", () => {
    const { service } = createService();

    const options = (service as any).buildLayeredCrawlOptions(
      {
        localeScope: {
          locale: "en-US",
          acceptLanguages: ["en-US", "en"],
        },
        priorityKeywords: ["breaking", "markets"],
        crawlOptions: {
          locale: "fr-FR",
          markdownFilter: {
            type: "pruning",
            minWordThreshold: 42,
          },
          browserHeaders: [
            {
              name: "Accept-Language",
              value: "fr-FR,fr",
            },
          ],
        },
      },
      "list",
    );

    expect(options.locale).toBe("fr-FR");
    expect(options.markdownFilter).toMatchObject({
      type: "pruning",
      minWordThreshold: 42,
    });
    expect(options.browserHeaders).toEqual(
      expect.arrayContaining([
        {
          name: "Accept-Language",
          value: "fr-FR,fr",
        },
      ]),
    );
  });

  it("synthesizes native filter chain and scorer for hybrid deep crawl", () => {
    const { service } = createService();

    const native = (service as any).resolveNativeCrawlComponents(
      {
        hostScope: "strict_hosts",
        allowedHosts: ["www.aljazeera.com"],
        blockedDomains: ["liberties.aljazeera.com"],
        priorityKeywords: ["breaking", "war", "markets"],
        urlPatterns: {
          category: ["https://www.aljazeera.com/news/*"],
          article: ["https://www.aljazeera.com/*/20*/*/*/*"],
        },
        layeredOptions: {
          maxDepth: 3,
          maxPages: 24,
        },
        nativeOptions: {
          deepCrawlStrategy: {
            type: "BFSDeepCrawlStrategy",
          },
          fallbackToLayered: true,
          minAcceptedResults: 2,
          minArticleResults: 1,
        },
      },
      "https://www.aljazeera.com/",
    );

    expect(native.filterChainSynthesized).toBe(true);
    expect(native.urlScorerSynthesized).toBe(true);
    expect(native.filterChain).toMatchObject({
      type: "FilterChain",
    });
    expect(native.urlScorer).toMatchObject({
      type: "KeywordRelevanceScorer",
      params: {
        keywords: expect.arrayContaining(["breaking", "war", "markets"]),
      },
    });
    expect(native.deepCrawlStrategy).toMatchObject({
      type: "BFSDeepCrawlStrategy",
      params: expect.objectContaining({
        max_depth: 3,
        max_pages: 24,
        filter_chain: expect.objectContaining({
          type: "FilterChain",
        }),
        url_scorer: expect.objectContaining({
          type: "KeywordRelevanceScorer",
        }),
      }),
    });
  });

  it("auto-resolves native strategy to best-first for freshness-sensitive profiles", () => {
    const { service } = createService();

    const native = (service as any).resolveNativeCrawlComponents(
      {
        hostScope: "strict_hosts",
        allowedHosts: ["www.theguardian.com"],
        priorityKeywords: ["breaking", "live", "war", "markets", "election"],
        freshnessRules: {
          recentHours: 24,
          weekHours: 168,
          monthHours: 720,
        },
        urlPatterns: {
          article: ["https://www.theguardian.com/*/20*/*/*/*"],
        },
        layeredOptions: {
          maxDepth: 3,
          maxPages: 32,
          scoreThreshold: 0.45,
        },
        nativeOptions: {
          deepCrawlStrategy: {
            type: "auto",
          },
        },
      },
      "https://www.theguardian.com/world",
    );

    expect(native.strategyAutoResolved).toBe(true);
    expect(native.strategyResolvedFrom).toBe("auto");
    expect(native.deepCrawlStrategy).toMatchObject({
      type: "BestFirstCrawlingStrategy",
      params: expect.objectContaining({
        max_depth: 3,
        max_pages: 32,
      }),
    });
  });

  it("creates layered child nodes before direct articles even when articles score higher", async () => {
    const { service, prisma, queueService } = createService();
    prisma.crawlFrontierNode.findMany.mockResolvedValue([
      {
        canonicalUrl: "https://apnews.com/",
        urlFingerprint: "seed",
        pageType: "home",
      },
    ]);
    prisma.crawlFrontierNode.create.mockImplementation(async ({ data }: any) => ({
      id: `node-${data.url}`,
      ...data,
    }));
    jest.spyOn(service as any, "extractCandidates").mockReturnValue({
      candidates: [
        {
          url: "https://apnews.com/article/top-story",
          pageType: "article",
          score: 10,
          freshnessScore: 1,
          metadata: {},
        },
        {
          url: "https://apnews.com/world-news",
          pageType: "category",
          score: 5,
          freshnessScore: 0,
          metadata: {},
        },
        {
          url: "https://apnews.com/hub/politics",
          pageType: "list",
          score: 4,
          freshnessScore: 0,
          metadata: {},
        },
      ],
      diagnostics: {
        candidateStats: {
          scanned: 3,
          unique: 3,
          accepted: 3,
          selected: 3,
          rejected: 0,
          trimmed: 0,
        },
        rejectionCounts: {},
        acceptedPageTypeCounts: {
          home: 0,
          category: 1,
          list: 1,
          article: 1,
        },
        warningFlags: [],
        syntheticListActivated: false,
      },
    });

    await (service as any).discoverChildNodes({
      node: {
        id: "seed-node",
        orgId: "org-1",
        url: "https://apnews.com/",
        pageType: "home",
        depth: 0,
      },
      runId: "run-1",
      taskId: "task-1",
      maxDepth: 3,
      maxPages: 8,
      profile: {
        config: {
          layeredOptions: {
            paginationKeepCount: 2,
          },
          urlPatterns: {
            category: ["https://apnews.com/world-news"],
            list: ["https://apnews.com/hub/*"],
            article: ["https://apnews.com/article/*"],
          },
        },
      },
      results: [],
    });

    expect(
      prisma.crawlFrontierNode.create.mock.calls.map(
        ([entry]: [Record<string, any>]) => entry.data.pageType,
      ),
    ).toEqual(["category", "list", "article"]);
    expect(queueService.enqueueFrontierNode).toHaveBeenCalledTimes(3);
  });

  it("activates synthetic list metadata when home only exposes direct articles", () => {
    const { service } = createService();

    const extraction = (service as any).extractCandidates(
      {
        id: "seed-node",
        orgId: "org-1",
        url: "https://example.com/",
        pageType: "home",
        depth: 0,
      },
      {
        allowedDomains: ["example.com"],
        layeredOptions: {
          scoreThreshold: 0.1,
          maxChildrenPerNode: 10,
        },
        urlPatterns: {
          article: ["https://example.com/2026/*"],
        },
      },
      [
        {
          url: "https://example.com/",
          links: {
            internal: [
              {
                href: "https://example.com/2026/03/18/world/direct-story",
                text: "World direct story",
                totalScore: 0.7,
              },
            ],
          },
        },
      ],
    );

    expect(extraction.diagnostics.syntheticListActivated).toBe(true);
    expect(extraction.diagnostics.warningFlags).toContain(
      "synthetic_list_activated",
    );
    expect(extraction.candidates[0]?.metadata).toMatchObject({
      syntheticList: true,
      discoveryPath: ["home", "synthetic_list", "article"],
    });
  });

  it("marks root-only runs without frontier expansion as failed", async () => {
    const { service, prisma } = createService();
    prisma.crawlFrontierRun.findUnique.mockResolvedValue({
      id: "run-1",
      status: "running",
      lastError: null,
    });
    prisma.crawlFrontierNode.findMany.mockResolvedValue([
      {
        status: "completed",
        pageType: "home",
        rejectionReason: null,
      },
    ]);

    await (service as any).refreshRunStatus("run-1");

    expect(prisma.crawlFrontierRun.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: expect.objectContaining({
        status: "failed",
        lastError: "no_frontier_candidates_discovered",
        nodeCount: 1,
        pageCount: 1,
        articleCount: 0,
      }),
    });
  });

  it("clears stale run lastError after a clean completion", async () => {
    const { service, prisma } = createService();
    prisma.crawlFrontierRun.findUnique.mockResolvedValue({
      id: "run-2",
      status: "running",
      lastError: "old transient failure",
      metadata: {},
    });
    prisma.crawlFrontierNode.findMany.mockResolvedValue([
      {
        status: "completed",
        pageType: "home",
        depth: 0,
        rejectionReason: null,
        lastError: null,
        metadata: {
          candidateStats: {
            scanned: 5,
            unique: 4,
            accepted: 3,
            selected: 2,
            rejected: 1,
            trimmed: 0,
          },
          warningFlags: [],
        },
      },
      {
        status: "completed",
        pageType: "article",
        depth: 3,
        rejectionReason: null,
        lastError: null,
        metadata: {
          failureKind: "challenge_detected",
          warningFlags: ["challenge_detected"],
        },
      },
    ]);

    await (service as any).refreshRunStatus("run-2");

    expect(prisma.crawlFrontierRun.update).toHaveBeenCalledWith({
      where: { id: "run-2" },
      data: expect.objectContaining({
        status: "completed",
        lastError: null,
        pageCount: 2,
        articleCount: 1,
        metadata: expect.objectContaining({
          failureKind: null,
          warningFlags: ["challenge_detected"],
        }),
      }),
    });
  });

  it("lifts llm parse failures into run-level warning flags and root diagnosis", async () => {
    const { service, prisma } = createService();
    prisma.crawlFrontierRun.findUnique.mockResolvedValue({
      id: "run-llm",
      status: "running",
      lastError: null,
      metadata: {},
    });
    prisma.crawlFrontierNode.findMany.mockResolvedValue([
      {
        status: "completed",
        pageType: "home",
        depth: 0,
        rejectionReason: null,
        lastError: null,
        metadata: {
          llmJudgeEnabled: true,
          llmJudgeAttempted: true,
          llmJudgeParsed: false,
          candidateStats: {
            scanned: 8,
            unique: 6,
            accepted: 4,
            selected: 3,
            rejected: 3,
            trimmed: 1,
          },
          warningFlags: [],
        },
      },
    ]);

    await (service as any).refreshRunStatus("run-llm");

    expect(prisma.crawlFrontierRun.update).toHaveBeenCalledWith({
      where: { id: "run-llm" },
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          warningFlags: ["llm_judge_parse_failed"],
          rootDiagnosis: expect.objectContaining({
            llmJudgeAttempted: true,
            llmJudgeParsed: false,
            warningFlags: ["llm_judge_parse_failed"],
          }),
        }),
      }),
    });
  });

  it("demotes hot timeout frontier retries to the normal queue instead of failing immediately", async () => {
    const { service, prisma, queueService, profiles } = createService();
    const nodeRecord = {
      id: "node-timeout",
      runId: "run-timeout",
      parentNodeId: null,
      orgId: "org-1",
      url: "https://www.reuters.com/world/example",
      canonicalUrl: null,
      urlFingerprint: null,
      pageType: "list",
      depth: 1,
      queueClass: "hot",
      status: "queued",
      score: null,
      freshnessScore: null,
      attempts: 0,
      queuedAt: new Date(),
      crawledAt: null,
      crawlResultId: null,
      rejectionReason: null,
      lastError: null,
      metadata: {},
      discoveredAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      run: {
        id: "run-timeout",
        orgId: "org-1",
        seedUrl: "https://www.reuters.com/",
        crawlTaskId: "task-1",
        profileId: "profile-1",
        executionMode: "layered",
        status: "queued",
        maxDepth: 3,
        maxPages: 12,
        startedAt: null,
      },
    };
    prisma.crawlFrontierNode.findUnique.mockResolvedValue(nodeRecord);
    prisma.crawlTask.findUnique.mockResolvedValue({
      id: "task-1",
      orgId: "org-1",
    });
    profiles.getProfile.mockResolvedValue({
      id: "profile-1",
      orgId: "org-1",
      name: "Reuters",
      description: null,
      matchHost: "www.reuters.com",
      isActive: true,
      executionMode: "layered",
      version: 1,
      createdById: "user-1",
      updatedById: "user-1",
      publishedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      config: {},
    });
    prisma.crawlFrontierRun.findUnique.mockResolvedValue({
      id: "run-timeout",
      status: "running",
      lastError: null,
      metadata: {},
    });
    prisma.crawlFrontierNode.findMany.mockResolvedValue([
      {
        status: "queued",
        pageType: "list",
        depth: 1,
        rejectionReason: null,
        lastError: null,
        metadata: {
          warningFlags: ["retry_demoted_to_normal"],
        },
      },
    ]);
    jest
      .spyOn(service as any, "executeNode")
      .mockRejectedValue(new Error("crawl4ai request timed out after 60000ms"));

    await expect(
      service.processQueuedNode("node-timeout", "org-1", 60_000),
    ).resolves.toEqual({
      inserted: 0,
      skipped: 0,
    });

    expect(prisma.crawlFrontierNode.update).toHaveBeenCalledWith({
      where: { id: "node-timeout" },
      data: expect.objectContaining({
        status: "queued",
        queueClass: "normal",
        lastError: null,
        metadata: expect.anything(),
      }),
    });
    expect(queueService.enqueueFrontierNode).toHaveBeenCalledWith({
      orgId: "org-1",
      taskId: "task-1",
      frontierRunId: "run-timeout",
      frontierNodeId: "node-timeout",
      priorityClass: "normal",
    });
  });

  it("uses llm-assisted frontier judgments to drop noisy candidates and retag page types", async () => {
    const frontierLlm = {
      judgeCandidates: jest.fn().mockResolvedValue({
        candidates: [
          {
            url: "https://example.com/section/world",
            pageType: "list",
            score: 6.1,
            freshnessScore: 0.3,
            metadata: {
              judgeMethod: "llm",
              judgeConfidence: 0.91,
              judgeReason: "section landing page",
            },
          },
          {
            url: "https://example.com/2026/03/18/world/story-a",
            pageType: "article",
            score: 6.6,
            freshnessScore: 1,
            metadata: {
              judgeMethod: "llm",
              judgeConfidence: 0.95,
              judgeReason: "dated article url",
            },
          },
        ],
        diagnostics: {
          llmJudgeAttempted: true,
          llmJudgeDropped: 1,
          llmJudgeRetyped: 1,
        },
      }),
    };
    const { service, prisma, queueService } = createService(frontierLlm);
    prisma.crawlFrontierNode.findMany.mockResolvedValue([
      {
        canonicalUrl: "https://example.com/",
        urlFingerprint: "seed",
        pageType: "home",
      },
    ]);
    prisma.crawlFrontierNode.create.mockImplementation(async ({ data }: any) => ({
      id: `node-${data.url}`,
      ...data,
    }));
    jest.spyOn(service as any, "extractCandidates").mockReturnValue({
      candidates: [
        {
          url: "https://example.com/section/world",
          pageType: "category",
          score: 5,
          freshnessScore: 0.2,
          metadata: {
            linkText: "World",
          },
        },
        {
          url: "https://example.com/profile/editorial",
          pageType: "list",
          score: 4.8,
          freshnessScore: 0,
          metadata: {
            linkText: "Editorial profile",
          },
        },
        {
          url: "https://example.com/2026/03/18/world/story-a",
          pageType: "list",
          score: 5.8,
          freshnessScore: 1,
          metadata: {
            linkText: "Story A",
          },
        },
      ],
      diagnostics: {
        candidateStats: {
          scanned: 3,
          unique: 3,
          accepted: 3,
          selected: 3,
          rejected: 0,
          trimmed: 0,
        },
        rejectionCounts: {},
        acceptedPageTypeCounts: {
          home: 0,
          category: 1,
          list: 2,
          article: 0,
        },
        warningFlags: [],
        syntheticListActivated: false,
      },
    });

    const diagnostics = await (service as any).discoverChildNodes({
      node: {
        id: "seed-node",
        orgId: "org-1",
        url: "https://example.com/",
        pageType: "home",
        depth: 0,
      },
      runId: "run-1",
      taskId: "task-1",
      maxDepth: 3,
      maxPages: 8,
      profile: {
        id: "profile-1",
        orgId: "org-1",
        name: "Example",
        description: null,
        matchHost: "example.com",
        isActive: true,
        executionMode: "layered",
        version: 1,
        createdById: "user-1",
        updatedById: "user-1",
        publishedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        config: {
          llmAssist: {
            enabled: true,
          },
          layeredOptions: {
            paginationKeepCount: 2,
          },
        },
      },
      results: [],
    });

    expect(frontierLlm.judgeCandidates).toHaveBeenCalledTimes(1);
    expect(prisma.crawlFrontierNode.create).toHaveBeenCalledTimes(2);
    expect(
      prisma.crawlFrontierNode.create.mock.calls.map(
        ([entry]: [Record<string, any>]) => [entry.data.url, entry.data.pageType],
      ),
    ).toEqual([
      ["https://example.com/section/world", "list"],
      ["https://example.com/2026/03/18/world/story-a", "article"],
    ]);
    expect(queueService.enqueueFrontierNode).toHaveBeenCalledTimes(2);
    expect(diagnostics).toEqual(
      expect.objectContaining({
        llmJudgeAttempted: true,
        llmJudgeDropped: 1,
        llmJudgeRetyped: 1,
      }),
    );
  });

  it("uses synthesized llm-assisted frontier defaults when profile omits llmAssist", async () => {
    const frontierLlm = {
      judgeCandidates: jest.fn().mockResolvedValue({
        candidates: [
          {
            url: "https://example.com/2026/03/18/world/story-a",
            pageType: "article",
            score: 3.2,
            freshnessScore: 0.9,
            metadata: {
              judgeMethod: "llm",
              judgeConfidence: 0.81,
            },
          },
        ],
        diagnostics: {
          llmJudgeEnabled: true,
          llmJudgeAttempted: true,
          llmJudgeJudged: 1,
          warningFlags: [],
        },
      }),
    };
    const { service, prisma, queueService } = createService(frontierLlm);
    prisma.crawlFrontierNode.findMany.mockResolvedValue([
      {
        canonicalUrl: "https://example.com/",
        urlFingerprint: "seed",
        pageType: "home",
      },
    ]);
    prisma.crawlFrontierNode.create.mockImplementation(async ({ data }: any) => ({
      id: `node-${data.url}`,
      ...data,
    }));
    jest.spyOn(service as any, "extractCandidates").mockReturnValue({
      candidates: [
        {
          url: "https://example.com/world/story-a-2026-03-19/",
          pageType: "category",
          score: 2.4,
          freshnessScore: 0.9,
          metadata: {},
        },
      ],
      diagnostics: {
        candidateStats: {
          scanned: 1,
          unique: 1,
          accepted: 1,
          selected: 1,
          rejected: 0,
          trimmed: 0,
        },
        rejectionCounts: {},
        acceptedPageTypeCounts: {
          home: 0,
          category: 1,
          list: 0,
          article: 0,
        },
        warningFlags: [],
        syntheticListActivated: false,
      },
    });

    await (service as any).discoverChildNodes({
      node: {
        id: "seed-node",
        orgId: "org-1",
        url: "https://example.com/",
        pageType: "home",
        depth: 0,
      },
      runId: "run-1",
      taskId: "task-1",
      maxDepth: 3,
      maxPages: 8,
      profile: {
        id: "profile-1",
        orgId: "org-1",
        name: "Example",
        description: null,
        matchHost: "example.com",
        isActive: true,
        executionMode: "layered",
        version: 1,
        createdById: "user-1",
        updatedById: "user-1",
        publishedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        config: {
          layeredOptions: {
            paginationKeepCount: 2,
          },
        },
      },
      results: [],
    });

    expect(frontierLlm.judgeCandidates).toHaveBeenCalledTimes(1);
    expect(frontierLlm.judgeCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          llmAssist: expect.objectContaining({
            enabled: true,
            recallMode: "high_recall",
          }),
        }),
      }),
    );
    expect(prisma.crawlFrontierNode.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          pageType: "article",
        }),
      }),
    );
    expect(queueService.enqueueFrontierNode).toHaveBeenCalledTimes(1);
  });

  it("discovers sitemap seed candidates via metadata service and queues article nodes", async () => {
    const { service, prisma, queueService, metadataService } = createService();
    metadataService.discoverSitemap.mockResolvedValue({
      candidates: [
        {
          url: "https://www.reuters.com/world/europe/2026/03/18/example-one/",
          publishedAtTs: Date.parse("2026-03-18T06:00:00Z"),
          crawledAtTs: Date.parse("2026-03-18T06:05:00Z"),
        },
        {
          url: "https://www.reuters.com/world/asia-pacific/2026/03/18/example-two/",
          publishedAtTs: Date.parse("2026-03-18T07:00:00Z"),
          crawledAtTs: Date.parse("2026-03-18T07:05:00Z"),
        },
      ],
      diagnostics: {
        discoveryMode: "robots",
        seedMethod: "robots",
        robotsDiscoveredSitemaps: [
          "https://www.reuters.com/arc/outboundfeeds/news-sitemap-index/?outputType=xml",
        ],
        attemptedSitemaps: [
          "https://www.reuters.com/arc/outboundfeeds/news-sitemap-index/?outputType=xml",
        ],
        fetchedSitemaps: [
          "https://www.reuters.com/arc/outboundfeeds/news-sitemap-index/?outputType=xml",
        ],
        parsedSitemaps: 1,
        candidateCount: 2,
      },
    });
    prisma.crawlFrontierNode.findMany.mockResolvedValue([
      {
        canonicalUrl: "https://www.reuters.com/",
        urlFingerprint: "seed",
        pageType: "home",
      },
    ]);
    prisma.crawlFrontierNode.create.mockImplementation(async ({ data }: any) => ({
      id: `node-${data.url}`,
      ...data,
    }));

    const discovered = await (service as any).discoverSeedNodes({
      node: {
        id: "seed-node",
        orgId: "org-1",
        url: "https://www.reuters.com/",
        pageType: "home",
        depth: 0,
      },
      run: {
        id: "run-1",
        seedUrl: "https://www.reuters.com/",
        maxDepth: 3,
        maxPages: 10,
      },
      profile: {
        id: "profile-1",
        orgId: "org-1",
        name: "Reuters",
        description: null,
        matchHost: "www.reuters.com",
        isActive: true,
        executionMode: "layered",
        version: 1,
        createdById: "user-1",
        updatedById: "user-1",
        publishedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        config: {
          seedDiscovery: {
            strategy: "auto",
            mode: "robots",
            maxSeedUrls: 20,
            qualityThresholds: {
              minCandidates: 1,
              minArticleRatio: 0.4,
              maxNoiseRatio: 0.5,
              minFreshRatio: 0.2,
            },
          },
          freshnessRules: {
            recentHours: 24,
            weekHours: 168,
            monthHours: 720,
          },
          urlPatterns: {
            article: ["https://www.reuters.com/*/*/20*/*/*/*"],
          },
          layeredOptions: {
            paginationKeepCount: 2,
          },
        },
      },
      taskId: "task-1",
    });

    expect(metadataService.discoverSitemap).toHaveBeenCalledTimes(1);
    expect(prisma.crawlFrontierNode.create).toHaveBeenCalledTimes(2);
    expect(queueService.enqueueFrontierNode).toHaveBeenCalledTimes(2);
    expect(discovered?.diagnostics).toEqual(
      expect.objectContaining({
        seedOrigin: "sitemap",
        seedMethod: "robots",
        fallbackStage: "seed",
      }),
    );
  });
});
