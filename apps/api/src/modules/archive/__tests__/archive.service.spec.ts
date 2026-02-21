jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }),
}));

import type { ProcessedArticleStatus } from "@prisma/client";

import { ArchiveService } from "../archive.service";
import {
  ArchiveRegion,
  ArchiveVertical,
  ArchiveWeight,
} from "../archive.types";

interface ArchiveRowFixture {
  id: string;
  title: string | null;
  summary: string | null;
  source: string | null;
  publishedAt: Date | null;
  topics: unknown;
  entities: unknown;
  qualityScore: number | null;
  location: string | null;
  processedAt: Date;
  cleanedMarkdownRef: string | null;
  article: {
    id: string;
    orgId: string;
    url: string;
    sourceLabel: string | null;
    crawlAt: Date;
  };
  newsEventItems: Array<{
    eventId: string;
  }>;
  status?: ProcessedArticleStatus;
}

const makeRow = (id: string, publishedAtIso: string): ArchiveRowFixture => ({
  id,
  title: `${id} title`,
  summary: `${id} summary`,
  source: "fixture-source",
  publishedAt: new Date(publishedAtIso),
  topics: ["security"],
  entities: [{ name: "Philippines" }],
  qualityScore: 0.92,
  location: "Philippines",
  processedAt: new Date(publishedAtIso),
  cleanedMarkdownRef: `ref-${id}`,
  article: {
    id: `article-${id}`,
    orgId: "org-1",
    url: `https://example.com/${id}`,
    sourceLabel: "fixture-source",
    crawlAt: new Date(publishedAtIso),
  },
  newsEventItems: [{ eventId: `event-${id}` }],
});

describe("ArchiveService", () => {
  const classifierResult = {
    region: ArchiveRegion.APAC,
    vertical: ArchiveVertical.EAST_SEA,
    countryCode: "PHL",
    countryLabel: "Philippines",
    entityTags: ["Philippines"],
  };

  it("throws when embedding model is unavailable", async () => {
    const prisma = {
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([makeRow("row-1", "2025-05-28T02:00:00.000Z")]),
      },
      newsEvent: { findFirst: jest.fn() },
    };
    const liteLlm = {
      getEmbeddingModel: jest.fn().mockResolvedValue(null),
      embedding: jest.fn(),
      rerank: jest.fn().mockResolvedValue({ results: [] }),
    };
    const vectorClient = { searchBestEffort: jest.fn() };
    const classifier = { classify: jest.fn().mockReturnValue(classifierResult) };
    const service = new ArchiveService(
      prisma as any,
      liteLlm as any,
      vectorClient as any,
      classifier as any,
    );

    let thrown: unknown;
    try {
      await service.getDigest("org-1", {
        anchorDate: new Date("2025-05-28T00:00:00.000Z"),
        region: ArchiveRegion.APAC,
        search: "菲律宾",
        weights: [
          ArchiveWeight.ONE,
          ArchiveWeight.TWO,
          ArchiveWeight.THREE,
          ArchiveWeight.FOUR,
          ArchiveWeight.FIVE,
        ],
        limitPerVertical: 20,
      });
    } catch (error) {
      thrown = error;
    }

    const response = (
      thrown as { getResponse?: () => { code?: string } } | undefined
    )?.getResponse?.();
    expect(response?.code).toBe("ARCHIVE_EMBEDDING_UNAVAILABLE");
    expect(liteLlm.embedding).not.toHaveBeenCalled();
    expect(vectorClient.searchBestEffort).not.toHaveBeenCalled();
    expect(prisma.processedArticle.findMany).not.toHaveBeenCalled();
  });

  it("throws when embedding response has no usable vector", async () => {
    const prisma = {
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([makeRow("row-2", "2025-05-27T02:00:00.000Z")]),
      },
      newsEvent: { findFirst: jest.fn() },
    };
    const liteLlm = {
      getEmbeddingModel: jest.fn().mockResolvedValue("embedding-model"),
      embedding: jest.fn().mockResolvedValue({
        model: "embedding-model",
        data: [{}],
      }),
      rerank: jest.fn().mockResolvedValue({ results: [] }),
    };
    const vectorClient = { searchBestEffort: jest.fn() };
    const classifier = { classify: jest.fn().mockReturnValue(classifierResult) };
    const service = new ArchiveService(
      prisma as any,
      liteLlm as any,
      vectorClient as any,
      classifier as any,
    );

    let thrown: unknown;
    try {
      await service.getDigest("org-1", {
        anchorDate: new Date("2025-05-28T00:00:00.000Z"),
        region: ArchiveRegion.APAC,
        search: "south china sea",
        weights: [ArchiveWeight.FIVE],
        limitPerVertical: 20,
      });
    } catch (error) {
      thrown = error;
    }

    const response = (
      thrown as { getResponse?: () => { code?: string } } | undefined
    )?.getResponse?.();
    expect(response?.code).toBe("ARCHIVE_EMBEDDING_INVALID_RESPONSE");
    expect(vectorClient.searchBestEffort).not.toHaveBeenCalled();
    expect(prisma.processedArticle.findMany).not.toHaveBeenCalled();
  });

  it("throws when vector service is unavailable", async () => {
    const prisma = {
      processedArticle: {
        findMany: jest.fn(),
      },
      newsEvent: { findFirst: jest.fn() },
    };
    const liteLlm = {
      getEmbeddingModel: jest.fn().mockResolvedValue("embedding-model"),
      embedding: jest.fn().mockResolvedValue({
        model: "embedding-model",
        data: [{ embedding: [0.1, 0.2] }],
      }),
      rerank: jest.fn(),
    };
    const vectorClient = { searchBestEffort: jest.fn().mockResolvedValue(null) };
    const classifier = { classify: jest.fn().mockReturnValue(classifierResult) };
    const service = new ArchiveService(
      prisma as any,
      liteLlm as any,
      vectorClient as any,
      classifier as any,
    );

    let thrown: unknown;
    try {
      await service.getDigest("org-1", {
        anchorDate: new Date("2025-05-28T00:00:00.000Z"),
        region: ArchiveRegion.APAC,
        search: "south china sea",
        weights: [ArchiveWeight.FIVE],
        limitPerVertical: 20,
      });
    } catch (error) {
      thrown = error;
    }

    const response = (
      thrown as { getResponse?: () => { code?: string } } | undefined
    )?.getResponse?.();
    expect(response?.code).toBe("ARCHIVE_VECTOR_UNAVAILABLE");
    expect(prisma.processedArticle.findMany).not.toHaveBeenCalled();
  });

  it("throws when rerank fails instead of silently reordering", async () => {
    const row = makeRow("row-3", "2025-05-27T02:00:00.000Z");
    const prisma = {
      processedArticle: {
        findMany: jest.fn().mockResolvedValue([row]),
      },
      newsEvent: { findFirst: jest.fn() },
    };
    const liteLlm = {
      getEmbeddingModel: jest.fn().mockResolvedValue("embedding-model"),
      embedding: jest.fn().mockResolvedValue({
        model: "embedding-model",
        data: [{ embedding: [0.1, 0.2] }],
      }),
      rerank: jest.fn().mockRejectedValue(new Error("rerank down")),
    };
    const vectorClient = {
      searchBestEffort: jest
        .fn()
        .mockResolvedValue([{ processedItemId: row.cleanedMarkdownRef, score: 0.92 }]),
    };
    const classifier = { classify: jest.fn().mockReturnValue(classifierResult) };
    const service = new ArchiveService(
      prisma as any,
      liteLlm as any,
      vectorClient as any,
      classifier as any,
    );

    let thrown: unknown;
    try {
      await service.getDigest("org-1", {
        anchorDate: new Date("2025-05-28T00:00:00.000Z"),
        region: ArchiveRegion.APAC,
        search: "south china sea",
        weights: [ArchiveWeight.FIVE],
        limitPerVertical: 20,
      });
    } catch (error) {
      thrown = error;
    }

    const response = (
      thrown as { getResponse?: () => { code?: string } } | undefined
    )?.getResponse?.();
    expect(response?.code).toBe("ARCHIVE_RERANK_FAILED");
  });

  it("paginates calendar queries and aggregates all matching rows", async () => {
    const firstBatch = Array.from({ length: 600 }, (_, index) =>
      makeRow(
        `row-${index + 1}`,
        `2025-05-${String((index % 28) + 1).padStart(2, "0")}T08:00:00.000Z`,
      ),
    );
    const secondBatch = [makeRow("row-601", "2025-05-28T08:00:00.000Z")];
    const prisma = {
      processedArticle: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(firstBatch)
          .mockResolvedValueOnce(secondBatch),
      },
      newsEvent: { findFirst: jest.fn() },
    };
    const liteLlm = {
      getEmbeddingModel: jest.fn(),
      embedding: jest.fn(),
      rerank: jest.fn(),
    };
    const vectorClient = { searchBestEffort: jest.fn() };
    const classifier = { classify: jest.fn().mockReturnValue(classifierResult) };
    const service = new ArchiveService(
      prisma as any,
      liteLlm as any,
      vectorClient as any,
      classifier as any,
    );

    const result = await service.getCalendar("org-1", {
      month: "2025-05",
      region: ArchiveRegion.APAC,
    });

    const total = result.reduce((sum, day) => sum + day.count, 0);
    expect(total).toBe(601);
    expect(prisma.processedArticle.findMany).toHaveBeenCalledTimes(2);
  });
});
