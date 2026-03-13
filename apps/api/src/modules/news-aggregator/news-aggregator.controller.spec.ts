import { BadRequestException } from "@nestjs/common"

import { NewsAggregatorController } from "./news-aggregator.controller"

describe("NewsAggregatorController", () => {
  const newsAggregatorService = {
    fetchSource: jest.fn(),
    fetchBatch: jest.fn(),
    getMetadata: jest.fn(),
    resolveByUrl: jest.fn(),
    getPersonalizedSourceOrderForUser: jest.fn(),
  }
  const hottestAnalysisService = {
    getHottestAnalysis: jest.fn(),
  }
  const domesticOpinionIndexService = {
    getDomesticOpinionIndex: jest.fn(),
  }

  let controller: NewsAggregatorController

  beforeEach(() => {
    jest.resetAllMocks()
    controller = new NewsAggregatorController(
      newsAggregatorService as any,
      hottestAnalysisService as any,
      domesticOpinionIndexService as any,
    )
  })

  it.each(["true", "1", "yes", "y", "on"])(
    "passes forceRefresh=true when query is %s",
    async (queryValue) => {
      newsAggregatorService.fetchSource.mockResolvedValue({
        status: "success",
        id: "baidu",
        updatedTime: Date.now(),
        items: [],
      })

      await controller.getSource("baidu", queryValue)

      expect(newsAggregatorService.fetchSource).toHaveBeenCalledWith("baidu", true)
    },
  )

  it.each([undefined, "", "false", "0", "no", "n", "off"])(
    "passes forceRefresh=false when query is %s",
    async (queryValue) => {
      newsAggregatorService.fetchSource.mockResolvedValue({
        status: "success",
        id: "baidu",
        updatedTime: Date.now(),
        items: [],
      })

      await controller.getSource("baidu", queryValue)

      expect(newsAggregatorService.fetchSource).toHaveBeenCalledWith("baidu", false)
    },
  )

  it("throws when forceRefresh query is invalid", async () => {
    expect(() => controller.getSource("baidu", "maybe")).toThrow(BadRequestException)
    expect(newsAggregatorService.fetchSource).not.toHaveBeenCalled()
  })

  it("throws when source id format is invalid", async () => {
    expect(() => controller.getSource("bad id", "true")).toThrow(BadRequestException)
    expect(newsAggregatorService.fetchSource).not.toHaveBeenCalled()
  })

  it("propagates upstream fetch errors without controller fallback", async () => {
    const upstreamError = new Error("upstream unavailable")
    newsAggregatorService.fetchSource.mockRejectedValue(upstreamError)

    await expect(controller.getSource("baidu", "true")).rejects.toBe(upstreamError)
  })

  it("delegates resolve endpoint with normalized URL", async () => {
    newsAggregatorService.resolveByUrl.mockResolvedValue({
      matched: true,
      itemId: "item-1",
      eventId: "event-1",
      confidence: 1,
      matchedUrl: "https://example.com/news/a",
    })

    await controller.resolveByUrl("https://example.com/news/a")

    expect(newsAggregatorService.resolveByUrl).toHaveBeenCalledWith("https://example.com/news/a")
  })

  it("rejects non-http URL for resolve endpoint", () => {
    expect(() => controller.resolveByUrl("ftp://example.com/news/a")).toThrow(BadRequestException)
    expect(newsAggregatorService.resolveByUrl).not.toHaveBeenCalled()
  })

  it("rejects malformed URL for resolve endpoint", () => {
    expect(() => controller.resolveByUrl("not-a-url")).toThrow(BadRequestException)
    expect(newsAggregatorService.resolveByUrl).not.toHaveBeenCalled()
  })

  it.each([undefined, "", "false", "0", "no", "n", "off"])(
    "delegates hottest analysis with forceRefresh=false for query %s",
    async (queryValue) => {
      hottestAnalysisService.getHottestAnalysis.mockResolvedValue({
        generatedAt: new Date().toISOString(),
        cached: false,
        sourcesAnalyzed: 1,
        itemsAnalyzed: 1,
        bySource: {},
        candidates: [],
        errors: [],
      })

      await controller.getHottestAnalysis(
        { id: "user-1", orgId: "org-1", permissions: ["items.read"] } as any,
        queryValue,
      )

      expect(hottestAnalysisService.getHottestAnalysis).toHaveBeenCalledWith({
        orgId: "org-1",
        userId: "user-1",
        forceRefresh: false,
        allowAutoBridge: false,
      })
    },
  )

  it("delegates hottest analysis with forceRefresh=true", async () => {
    hottestAnalysisService.getHottestAnalysis.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      cached: false,
      sourcesAnalyzed: 1,
      itemsAnalyzed: 1,
      bySource: {},
      candidates: [],
      errors: [],
    })

    await controller.getHottestAnalysis(
      { id: "user-1", orgId: "org-1", permissions: ["items.read", "items.write"] } as any,
      "true",
    )

    expect(hottestAnalysisService.getHottestAnalysis).toHaveBeenCalledWith({
      orgId: "org-1",
      userId: "user-1",
      forceRefresh: true,
      allowAutoBridge: true,
    })
  })

  it("delegates domestic opinion index query with optional hours", async () => {
    domesticOpinionIndexService.getDomesticOpinionIndex.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      latest: null,
      trend: [],
      topKeywords: [],
      topCandidates: [],
    })

    await controller.getDomesticOpinionIndex(
      { id: "user-1", orgId: "org-1", permissions: ["items.read"] } as any,
      "48",
    )

    expect(domesticOpinionIndexService.getDomesticOpinionIndex).toHaveBeenCalledWith("org-1", {
      hours: 48,
    })
  })

  it("rejects invalid domestic opinion hours query", () => {
    expect(() =>
      controller.getDomesticOpinionIndex(
        { id: "user-1", orgId: "org-1", permissions: ["items.read"] } as any,
        "0",
      ),
    ).toThrow(BadRequestException)
    expect(domesticOpinionIndexService.getDomesticOpinionIndex).not.toHaveBeenCalled()
  })

  it("delegates personalized order request for authenticated users", async () => {
    newsAggregatorService.getPersonalizedSourceOrderForUser.mockResolvedValue({
      columnKey: "hottest",
      sortMode: "smart",
      sourceIds: ["weibo", "hackernews"],
      sourceScores: { weibo: 0.8, hackernews: 0.2 },
      computedAt: new Date().toISOString(),
    })

    await controller.getPersonalizedSourcesOrder(
      { id: "user-1", orgId: "org-1" } as any,
      {
        column: "hottest",
        sources: ["weibo", "hackernews", "bad source"],
        settings: { sortMode: "smart" },
      },
    )

    expect(newsAggregatorService.getPersonalizedSourceOrderForUser).toHaveBeenCalledWith({
      orgId: "org-1",
      userId: "user-1",
      columnKey: "hottest",
      sourceIds: ["weibo", "hackernews"],
      settingsOverride: { sortMode: "smart" },
    })
  })

  it("rejects personalized order when column is missing", () => {
    expect(() =>
      controller.getPersonalizedSourcesOrder(
        { id: "user-1", orgId: "org-1" } as any,
        { sources: ["weibo"] },
      ),
    ).toThrow(BadRequestException)
    expect(newsAggregatorService.getPersonalizedSourceOrderForUser).not.toHaveBeenCalled()
  })

  it("rejects personalized order when settings is not an object", () => {
    expect(() =>
      controller.getPersonalizedSourcesOrder(
        { id: "user-1", orgId: "org-1" } as any,
        { column: "hottest", sources: ["weibo"], settings: "invalid" as any },
      ),
    ).toThrow(BadRequestException)
    expect(newsAggregatorService.getPersonalizedSourceOrderForUser).not.toHaveBeenCalled()
  })
})
