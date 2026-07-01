jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }),
}));

const mockProcessedItemFind = jest.fn();

jest.mock("@modular/mongo", () => ({
  ProcessedItemModel: {
    find: (...args: unknown[]) => mockProcessedItemFind(...args),
  },
}));

jest.mock("../../observability/task-log.writer", () => ({
  writeTaskLogBestEffort: jest.fn(async () => undefined),
}));

import { NewsEventAssignmentMethod } from "@prisma/client";

import { NewsEventsBertopicService } from "../news-events-bertopic.service";

describe("NewsEventsBertopicService", () => {
  const settings = {
    bertopicMinItemsPerGroup: 2,
    bertopicMaxItemsPerRequest: 8,
    bertopicMinTopicSize: 2,
    vectorMinScore: 0.8,
    classificationGateEnabled: true,
    categoryConflictReject: true,
    categorySoftPenalty: 0.15,
    minCategoryConfidenceForGate: 0.4,
    crossLanguagePenalty: 0.1,
  } as any;

  beforeEach(() => {
    jest.resetAllMocks();
    mockProcessedItemFind.mockReturnValue({
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([
        {
          _id: "pi-1",
          summaryEmbedding: [1, 0],
          summaryEmbeddingModel: "embed-1",
        },
        {
          _id: "pi-2",
          summaryEmbedding: [0.99, 0.01],
          summaryEmbeddingModel: "embed-1",
        },
      ]),
    });
  });

  it("routes clustered members through the gated specific-event assignment path", async () => {
    const modelService = {
      clusterTopicsOrThrow: jest.fn().mockResolvedValue({
        clusters: [
          {
            representativeId: "pa-1",
            itemIds: ["pa-1", "pa-2"],
            keywords: ["rates"],
          },
        ],
        outlierIds: [],
        diagnostics: {},
      }),
    } as any;
    const events = {
      assignNewsSignalToEvent: jest
        .fn()
        .mockResolvedValueOnce({ eventId: "evt-1", created: true }),
      assignNewsSignalToSpecificEventWithSettings: jest
        .fn()
        .mockResolvedValue({ eventId: "evt-1", created: true }),
    } as any;
    const failures = {
      recordFailure: jest.fn(),
    } as any;

    const service = new NewsEventsBertopicService(modelService, events, failures);

    const result = await service.processBatch({
      orgId: "org-1",
      settings,
      batch: [
        {
          id: "pa-1",
          articleId: "article-1",
          processedAt: new Date("2026-04-18T00:00:00.000Z"),
          publishedAt: new Date("2026-04-18T00:00:00.000Z"),
          language: "en",
          title: "Rates hold steady",
          summary: "Central bank holds rates steady.",
          category: "finance",
          topics: ["rates"],
          entities: [{ name: "Fed", type: "org", confidence: 0.9 }],
          qualityScore: 0.8,
          cleanedMarkdownRef: "pi-1",
          article: { crawlAt: new Date("2026-04-18T00:00:00.000Z") },
        },
        {
          id: "pa-2",
          articleId: "article-2",
          processedAt: new Date("2026-04-18T00:01:00.000Z"),
          publishedAt: new Date("2026-04-18T00:01:00.000Z"),
          language: "en",
          title: "Markets await next move",
          summary: "Investors wait for the next policy move.",
          category: "finance",
          topics: ["rates"],
          entities: [{ name: "Fed", type: "org", confidence: 0.9 }],
          qualityScore: 0.75,
          cleanedMarkdownRef: "pi-2",
          article: { crawlAt: new Date("2026-04-18T00:01:00.000Z") },
        },
      ],
      processedItemResultById: new Map([
        [
          "pi-1",
          {
            category: "finance",
            category_path: "finance/rates",
            category_confidence: 0.92,
          },
        ],
        [
          "pi-2",
          {
            category: "finance",
            category_path: "finance/rates",
            category_confidence: 0.88,
          },
        ],
      ]),
    });

    expect(result).toEqual({
      processedArticles: 2,
      assigned: 2,
      queuedForManual: 0,
    });
    expect(events.assignNewsSignalToSpecificEventWithSettings).toHaveBeenCalledWith(
      "org-1",
      "evt-1",
      expect.objectContaining({
        processedArticleId: "pa-2",
      }),
      settings,
      expect.objectContaining({
        assignedBy: NewsEventAssignmentMethod.manual,
        similarity: expect.any(Number),
      }),
    );
    expect(events.assignNewsSignalToSpecificEventWithSettings).toHaveBeenCalledTimes(1);
    expect(failures.recordFailure).not.toHaveBeenCalled();
  });
});
