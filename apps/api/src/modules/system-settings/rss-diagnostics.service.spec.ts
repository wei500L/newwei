import { Types } from "mongoose";

import { RssDiagnosticsService } from "./rss-diagnostics.service";

const mockProcessedItemFind = jest.fn();
const mockProcessedItemCountDocuments = jest.fn();
const mockProcessedItemAggregate = jest.fn();
const mockProcessedItemBulkWrite = jest.fn();
const mockRawItemFind = jest.fn();

jest.mock("@modular/mongo", () => ({
  ProcessedItemModel: {
    find: (...args: unknown[]) => mockProcessedItemFind(...args),
    countDocuments: (...args: unknown[]) =>
      mockProcessedItemCountDocuments(...args),
    aggregate: (...args: unknown[]) => mockProcessedItemAggregate(...args),
    bulkWrite: (...args: unknown[]) => mockProcessedItemBulkWrite(...args),
  },
  RawItemModel: {
    find: (...args: unknown[]) => mockRawItemFind(...args),
  },
}));

beforeEach(() => {
  mockProcessedItemFind.mockReset();
  mockProcessedItemCountDocuments.mockReset();
  mockProcessedItemAggregate.mockReset();
  mockProcessedItemBulkWrite.mockReset();
  mockRawItemFind.mockReset();
});

describe("RssDiagnosticsService.backfillProcessedItemSourceId", () => {
  it("returns empty summary when there are no candidates", async () => {
    mockProcessedItemFind.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });

    const prisma = {
      itemMeta: { findMany: jest.fn() },
      pipelineJob: { findMany: jest.fn() },
      crawlResult: { findMany: jest.fn() },
      newsSource: { findMany: jest.fn() },
    };
    const snapshots = {
      invalidate: jest.fn().mockResolvedValue(0),
      getOrCreate: jest.fn(
        async ({ loader }: { loader: () => Promise<unknown> }) => ({
          payload: await loader(),
        }),
      ),
    };

    const service = new RssDiagnosticsService(
      prisma as any,
      {
        newsSourceSchedulerConfig: { enabled: true },
      } as any,
      snapshots as any,
    );

    const result = await service.backfillProcessedItemSourceId("org-1", {
      dryRun: true,
      limit: 100,
    });

    expect(result).toEqual({
      dryRun: true,
      limit: 100,
      scanned: 0,
      matched: 0,
      updated: 0,
      unresolved: 0,
      unresolvedSamples: [],
    });
  });

  it("resolves sourceId from raw metadata in dry-run mode", async () => {
    const processedId = new Types.ObjectId();
    const rawId = new Types.ObjectId();

    mockProcessedItemFind.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        {
          _id: processedId,
          rawItemId: rawId,
          itemMetaId: "meta-1",
          pipelineJobId: null,
        },
      ]),
    });
    mockRawItemFind.mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        {
          _id: rawId,
          payload: {
            metadata: {
              sourceId: "source-1",
            },
          },
        },
      ]),
    });

    const prisma = {
      itemMeta: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: "meta-1", externalId: "crawlResult:result-1" },
          ]),
      },
      pipelineJob: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      crawlResult: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      newsSource: {
        findMany: jest.fn().mockResolvedValue([{ id: "source-1" }]),
      },
    };
    const snapshots = {
      invalidate: jest.fn().mockResolvedValue(0),
      getOrCreate: jest.fn(
        async ({ loader }: { loader: () => Promise<unknown> }) => ({
          payload: await loader(),
        }),
      ),
    };

    const service = new RssDiagnosticsService(
      prisma as any,
      {
        newsSourceSchedulerConfig: { enabled: true },
      } as any,
      snapshots as any,
    );

    const result = await service.backfillProcessedItemSourceId("org-1", {
      dryRun: true,
      limit: 100,
    });

    expect(result.scanned).toBe(1);
    expect(result.matched).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.unresolved).toBe(0);
  });
});
