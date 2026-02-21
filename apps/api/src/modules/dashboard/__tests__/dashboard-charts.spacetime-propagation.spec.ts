const mongoFindMock = jest.fn();

jest.mock("@modular/mongo", () => ({
  ProcessedItemModel: {
    find: mongoFindMock,
  },
}));

import { DashboardChartsService } from "../dashboard-charts.service";

const ORG_ID = "org-1";
const EVENT_ID = "evt-1";

const PI_1 = "65f1c2d3e4f5a6b7c8d9e0f1";
const PI_2 = "65f1c2d3e4f5a6b7c8d9e0f2";
const PI_3 = "65f1c2d3e4f5a6b7c8d9e0f3";
const PI_4 = "65f1c2d3e4f5a6b7c8d9e0f4";

const asObjectId = (value: string) => ({ toHexString: () => value });

const mongoCursorFromDocs = (docs: unknown[]) => ({
  lean: () => ({
    exec: async () => docs,
  }),
});

const makeSignalRow = (options: {
  processedItemId?: string | null;
  cleanedMarkdownRef?: string | null;
  processedArticleId: string;
  source: string;
  url: string;
  publishedAt: string;
  processedAt?: string;
  crawlAt?: string;
}) => ({
  processedItemId: options.processedItemId ?? null,
  createdAt: new Date(options.publishedAt),
  processedArticle: {
    id: options.processedArticleId,
    cleanedMarkdownRef: options.cleanedMarkdownRef ?? null,
    title: options.processedArticleId,
    publishedAt: new Date(options.publishedAt),
    processedAt: new Date(options.processedAt ?? options.publishedAt),
    article: {
      url: options.url,
      sourceLabel: options.source,
      crawlAt: new Date(options.crawlAt ?? options.publishedAt),
    },
  },
});

describe("DashboardChartsService.getSpacetimePropagation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mongoFindMock.mockReturnValue(mongoCursorFromDocs([]));
  });

  it("resolves duplicate edges from cleanedMarkdownRef even when newsEventItem.processedItemId is empty", async () => {
    const rows = [
      makeSignalRow({
        processedItemId: null,
        cleanedMarkdownRef: `s3://bucket/cleaned/${PI_1}.md`,
        processedArticleId: "pa1",
        source: "SourceA",
        url: "https://a.example.com/a1",
        publishedAt: "2026-01-10T10:00:00.000Z",
      }),
      makeSignalRow({
        processedItemId: "",
        cleanedMarkdownRef: `ref://${PI_2}/snapshot`,
        processedArticleId: "pa2",
        source: "SourceB",
        url: "https://b.example.com/b1",
        publishedAt: "2026-01-10T11:00:00.000Z",
      }),
      makeSignalRow({
        processedItemId: PI_3,
        cleanedMarkdownRef: PI_3,
        processedArticleId: "pa3",
        source: "SourceC",
        url: "https://c.example.com/c1",
        publishedAt: "2026-01-10T12:00:00.000Z",
      }),
    ];

    const prisma = {
      newsEventItem: {
        findMany: jest.fn().mockResolvedValue(rows),
      },
    } as any;

    mongoFindMock.mockReturnValue(
      mongoCursorFromDocs([
        { _id: asObjectId(PI_1), duplicateOf: null, duplicateSimilarity: null },
        {
          _id: asObjectId(PI_2),
          duplicateOf: asObjectId(PI_1),
          duplicateSimilarity: 0.92,
        },
        { _id: asObjectId(PI_3), duplicateOf: null, duplicateSimilarity: null },
      ]),
    );

    const service = new DashboardChartsService(
      prisma,
      {} as any,
      { get: jest.fn(), set: jest.fn() } as any,
    );

    const result = await service.getSpacetimePropagation(
      {
        start: new Date("2026-01-01T00:00:00.000Z"),
        end: new Date("2026-01-31T23:59:59.999Z"),
      } as any,
      ORG_ID,
      { eventId: EVENT_ID },
    );

    expect(prisma.newsEventItem.findMany).toHaveBeenCalledTimes(1);
    expect(mongoFindMock).toHaveBeenCalledTimes(1);

    const [filterArg] = mongoFindMock.mock.calls[0] as Array<
      Record<string, unknown>
    >;
    const ids = (((filterArg._id as { $in?: unknown }).$in ?? []) as string[])
      .slice()
      .sort();
    expect(ids).toEqual([PI_1, PI_2, PI_3].sort());

    const edgeKinds = result.edges.map(
      (edge) => `${edge.kind}:${edge.source}->${edge.target}`,
    );
    expect(edgeKinds).toContain("duplicate:SourceA->SourceB");
    expect(edgeKinds).toContain("time:SourceB->SourceC");
    expect(edgeKinds).toContain("time:SourceA->SourceC");
  });

  it("builds time fallback edges from multiple predecessor sources within the same window", async () => {
    const prisma = {
      newsEventItem: {
        findMany: jest.fn().mockResolvedValue([
          makeSignalRow({
            processedItemId: PI_1,
            cleanedMarkdownRef: PI_1,
            processedArticleId: "pa1",
            source: "SourceA",
            url: "https://a.example.com/a1",
            publishedAt: "2026-01-10T10:00:00.000Z",
          }),
          makeSignalRow({
            processedItemId: PI_2,
            cleanedMarkdownRef: PI_2,
            processedArticleId: "pa2",
            source: "SourceB",
            url: "https://b.example.com/b1",
            publishedAt: "2026-01-10T10:30:00.000Z",
          }),
          makeSignalRow({
            processedItemId: PI_3,
            cleanedMarkdownRef: PI_3,
            processedArticleId: "pa3",
            source: "SourceC",
            url: "https://c.example.com/c1",
            publishedAt: "2026-01-10T11:00:00.000Z",
          }),
        ]),
      },
    } as any;

    const service = new DashboardChartsService(
      prisma,
      {} as any,
      { get: jest.fn(), set: jest.fn() } as any,
    );

    const result = await service.getSpacetimePropagation(
      {
        start: new Date("2026-01-01T00:00:00.000Z"),
        end: new Date("2026-01-31T23:59:59.999Z"),
      } as any,
      ORG_ID,
      { eventId: EVENT_ID, windowHours: "12" },
    );

    const edgeKinds = result.edges.map(
      (edge) => `${edge.kind}:${edge.source}->${edge.target}`,
    );
    expect(edgeKinds).toContain("time:SourceA->SourceB");
    expect(edgeKinds).toContain("time:SourceB->SourceC");
    expect(edgeKinds).toContain("time:SourceA->SourceC");
    expect(edgeKinds.some((edge) => edge.startsWith("duplicate:"))).toBe(
      false,
    );
  });

  it("supports propagation windows beyond 72 hours", async () => {
    const prisma = {
      newsEventItem: {
        findMany: jest.fn().mockResolvedValue([
          makeSignalRow({
            processedItemId: PI_1,
            cleanedMarkdownRef: PI_1,
            processedArticleId: "pa1",
            source: "SourceA",
            url: "https://a.example.com/a1",
            publishedAt: "2026-01-01T00:00:00.000Z",
          }),
          makeSignalRow({
            processedItemId: PI_4,
            cleanedMarkdownRef: PI_4,
            processedArticleId: "pa4",
            source: "SourceB",
            url: "https://b.example.com/b1",
            publishedAt: "2026-01-10T00:00:00.000Z",
          }),
        ]),
      },
    } as any;

    const service = new DashboardChartsService(
      prisma,
      {} as any,
      { get: jest.fn(), set: jest.fn() } as any,
    );

    const result = await service.getSpacetimePropagation(
      {
        start: new Date("2026-01-01T00:00:00.000Z"),
        end: new Date("2026-01-31T23:59:59.999Z"),
      } as any,
      ORG_ID,
      { eventId: EVENT_ID, windowHours: "240" },
    );

    expect(result.windowHours).toBe(240);
    const edgeKinds = result.edges.map(
      (edge) => `${edge.kind}:${edge.source}->${edge.target}`,
    );
    expect(edgeKinds).toContain("time:SourceA->SourceB");
  });

  it("does not extract pseudo ObjectId from longer hex tokens", async () => {
    const prisma = {
      newsEventItem: {
        findMany: jest.fn().mockResolvedValue([
          makeSignalRow({
            processedItemId: null,
            cleanedMarkdownRef: `s3://bucket/cleaned/${PI_1}a.md`,
            processedArticleId: "pa1",
            source: "SourceA",
            url: "https://a.example.com/a1",
            publishedAt: "2026-01-10T10:00:00.000Z",
          }),
          makeSignalRow({
            processedItemId: null,
            cleanedMarkdownRef: `ref://${PI_2}/snapshot`,
            processedArticleId: "pa2",
            source: "SourceB",
            url: "https://b.example.com/b1",
            publishedAt: "2026-01-10T11:00:00.000Z",
          }),
        ]),
      },
    } as any;

    mongoFindMock.mockReturnValue(
      mongoCursorFromDocs([
        {
          _id: asObjectId(PI_2),
          duplicateOf: asObjectId(PI_1),
          duplicateSimilarity: 0.91,
        },
      ]),
    );

    const service = new DashboardChartsService(
      prisma,
      {} as any,
      { get: jest.fn(), set: jest.fn() } as any,
    );

    const result = await service.getSpacetimePropagation(
      {
        start: new Date("2026-01-01T00:00:00.000Z"),
        end: new Date("2026-01-31T23:59:59.999Z"),
      } as any,
      ORG_ID,
      { eventId: EVENT_ID },
    );

    const [filterArg] = mongoFindMock.mock.calls[0] as Array<
      Record<string, unknown>
    >;
    const ids = (((filterArg._id as { $in?: unknown }).$in ?? []) as string[])
      .slice()
      .sort();
    expect(ids).toEqual([PI_2]);

    const edgeKinds = result.edges.map(
      (edge) => `${edge.kind}:${edge.source}->${edge.target}`,
    );
    expect(edgeKinds).not.toContain("duplicate:SourceA->SourceB");
    expect(edgeKinds).toContain("time:SourceA->SourceB");
  });

  it("limits time fallback predecessors per signal when configured", async () => {
    const prisma = {
      newsEventItem: {
        findMany: jest.fn().mockResolvedValue([
          makeSignalRow({
            processedItemId: PI_1,
            cleanedMarkdownRef: PI_1,
            processedArticleId: "pa1",
            source: "SourceA",
            url: "https://a.example.com/a1",
            publishedAt: "2026-01-10T10:00:00.000Z",
          }),
          makeSignalRow({
            processedItemId: PI_2,
            cleanedMarkdownRef: PI_2,
            processedArticleId: "pa2",
            source: "SourceB",
            url: "https://b.example.com/b1",
            publishedAt: "2026-01-10T10:10:00.000Z",
          }),
          makeSignalRow({
            processedItemId: PI_3,
            cleanedMarkdownRef: PI_3,
            processedArticleId: "pa3",
            source: "SourceC",
            url: "https://c.example.com/c1",
            publishedAt: "2026-01-10T10:20:00.000Z",
          }),
          makeSignalRow({
            processedItemId: PI_4,
            cleanedMarkdownRef: PI_4,
            processedArticleId: "pa4",
            source: "SourceD",
            url: "https://d.example.com/d1",
            publishedAt: "2026-01-10T10:30:00.000Z",
          }),
        ]),
      },
    } as any;

    const service = new DashboardChartsService(
      prisma,
      {} as any,
      { get: jest.fn(), set: jest.fn() } as any,
    );

    const result = await service.getSpacetimePropagation(
      {
        start: new Date("2026-01-01T00:00:00.000Z"),
        end: new Date("2026-01-31T23:59:59.999Z"),
      } as any,
      ORG_ID,
      { eventId: EVENT_ID, windowHours: "12", maxPredecessorsPerSignal: "2" },
    );

    const edgeKinds = result.edges.map(
      (edge) => `${edge.kind}:${edge.source}->${edge.target}`,
    );
    expect(edgeKinds).toContain("time:SourceC->SourceD");
    expect(edgeKinds).toContain("time:SourceB->SourceD");
    expect(edgeKinds).not.toContain("time:SourceA->SourceD");
  });
});
