import { PublicPortalService } from "./public-portal.service";

const prismaMock = {
  systemSetting: {
    findUnique: jest.fn(),
  },
  org: {
    findFirst: jest.fn(),
  },
  newsEvent: {
    findMany: jest.fn(),
  },
} as unknown as any;

const newsEventsMock = {
  getEventHeatMap: jest.fn(),
  getEventAuthorityMap: jest.fn(),
} as unknown as any;

const newsEventBriefsMock = {} as unknown as any;

function createEventRow(params: {
  id: string;
  topic?: string | null;
  entity?: string | null;
  language?: string | null;
  lastAt?: string;
  startAt?: string;
  itemCount?: number;
}) {
  return {
    id: params.id,
    orgId: "org-1",
    title: `Title ${params.id}`,
    summary: `Summary ${params.id}`,
    primaryTopic: params.topic ?? null,
    primaryEntity: params.entity ?? null,
    language: params.language ?? "en",
    startAt: new Date(params.startAt ?? params.lastAt ?? "2026-04-18T00:00:00.000Z"),
    lastAt: new Date(params.lastAt ?? "2026-04-18T00:00:00.000Z"),
    representativeProcessedArticleId: null,
    _count: {
      items: params.itemCount ?? 3,
    },
  };
}

describe("PublicPortalService", () => {
  let service: PublicPortalService;

  beforeEach(() => {
    jest.resetAllMocks();

    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue({
      value: "public-org",
    });
    prismaMock.org.findFirst = jest.fn().mockResolvedValue({
      id: "org-1",
      slug: "public-org",
      name: "Public Org",
    });
    prismaMock.newsEvent.findMany = jest.fn();

    newsEventsMock.getEventHeatMap = jest
      .fn()
      .mockImplementation(async (_orgId: string, eventIds: string[]) => {
        return new Map(
          eventIds.map((eventId) => [eventId, { breaking: false, heatScore: 0 }]),
        );
      });
    newsEventsMock.getEventAuthorityMap = jest
      .fn()
      .mockImplementation(async (_orgId: string, eventIds: string[]) => {
        return new Map(
          eventIds.map((eventId) => [
            eventId,
            {
              sourceType: "authoritative",
              credibilityScore: 80,
              uniqueSourceCount: 2,
              authoritativeSourceCount: 2,
              blogSourceCount: 0,
              corroborated: true,
            },
          ]),
        );
      });

    service = new PublicPortalService(
      prismaMock,
      newsEventsMock,
      newsEventBriefsMock,
    );
  });

  it("keeps localized topics in separate portal channels", async () => {
    prismaMock.newsEvent.findMany.mockResolvedValue([
      createEventRow({
        id: "evt-cn-1",
        topic: "中东局势",
        lastAt: "2026-04-18T12:00:00.000Z",
      }),
      createEventRow({
        id: "evt-ua-1",
        topic: "Украина",
        lastAt: "2026-04-18T11:00:00.000Z",
      }),
      createEventRow({
        id: "evt-cn-2",
        topic: "中东局势",
        lastAt: "2026-04-18T10:00:00.000Z",
      }),
    ]);

    const result = await service.getHome();

    expect(result.channels).toEqual([
      expect.objectContaining({
        topic: "中东局势",
        topicSlug: "中东局势",
        storyCount: 2,
      }),
      expect.objectContaining({
        topic: "Украина",
        topicSlug: "украина",
        storyCount: 1,
      }),
    ]);
  });

  it("filters localized channel pages by the preserved unicode slug", async () => {
    prismaMock.newsEvent.findMany.mockResolvedValue([
      createEventRow({
        id: "evt-cn-1",
        topic: "中东局势",
        lastAt: "2026-04-18T12:00:00.000Z",
      }),
      createEventRow({
        id: "evt-ua-1",
        topic: "Украина",
        lastAt: "2026-04-18T11:00:00.000Z",
      }),
    ]);

    const result = await service.getChannel("中东局势");

    expect(result.topicSlug).toBe("中东局势");
    expect(result.stories).toEqual([
      expect.objectContaining({
        id: "evt-cn-1",
        topic: "中东局势",
        topicSlug: "中东局势",
      }),
    ]);
  });

  it("keeps scanning batches until it finds stories for the requested topic", async () => {
    const firstBatch = Array.from({ length: 96 }, (_, index) =>
      createEventRow({
        id: `evt-busy-${index + 1}`,
        topic: "Politics",
        lastAt: `2026-04-18T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
      }),
    );
    const secondBatch = [
      createEventRow({
        id: "evt-energy-1",
        topic: "Energy",
        lastAt: "2026-04-17T23:59:00.000Z",
      }),
    ];

    prismaMock.newsEvent.findMany
      .mockResolvedValueOnce(firstBatch)
      .mockResolvedValueOnce(secondBatch);

    const result = await service.getChannel("Energy");

    expect(result.stories).toEqual([
      expect.objectContaining({
        id: "evt-energy-1",
        topic: "Energy",
        topicSlug: "energy",
      }),
    ]);
    expect(prismaMock.newsEvent.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        take: 96,
      }),
    );
    expect(prismaMock.newsEvent.findMany.mock.calls[0]?.[0]).not.toHaveProperty("skip");
    expect(prismaMock.newsEvent.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        take: 96,
        where: expect.objectContaining({
          OR: [
            { lastAt: { lt: firstBatch[firstBatch.length - 1]!.lastAt } },
            {
              lastAt: firstBatch[firstBatch.length - 1]!.lastAt,
              startAt: { lt: firstBatch[firstBatch.length - 1]!.startAt },
            },
            {
              lastAt: firstBatch[firstBatch.length - 1]!.lastAt,
              startAt: firstBatch[firstBatch.length - 1]!.startAt,
              id: { lt: firstBatch[firstBatch.length - 1]!.id },
            },
          ],
        }),
      }),
    );
    expect(prismaMock.newsEvent.findMany.mock.calls[1]?.[0]).not.toHaveProperty("skip");
  });
});
