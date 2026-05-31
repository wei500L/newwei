import {
  buildUserNewsBehaviorDayKey,
  buildUserNewsBehaviorHashKey,
  buildUserNewsBehaviorProfileCacheKey,
  computeUserNewsBehaviorDecayWeight,
  USER_NEWS_BEHAVIOR_HASH_KINDS,
  USER_NEWS_BEHAVIOR_V2_RETENTION_SECONDS,
} from "./user-news-behavior.constants";
import { UserNewsBehaviorService } from "./user-news-behavior.service";

describe("UserNewsBehaviorService", () => {
  const roundScore = (value: number) => Number(value.toFixed(4));

  const createPrismaMock = () => ({
    $transaction: jest.fn(async (operations: unknown[]) => Promise.all(operations as Promise<unknown>[])),
    userNewsBehaviorAggregate: {
      upsert: jest.fn().mockResolvedValue(undefined),
      count: jest.fn().mockResolvedValue(0),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    userNewsSimilaritySnapshot: {
      upsert: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  });

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-04-18T12:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("records positive events into the v2 day bucket", async () => {
    const cache = {
      hincrby: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = createPrismaMock();
    const service = new UserNewsBehaviorService(cache as any, prisma as any);

    await service.record({
      orgId: "org-1",
      userId: "user-1",
      type: "share",
      itemId: "item-1",
      source: "reuters",
      topics: ["AI"],
      entities: ["OpenAI"],
      url: "https://www.reuters.com/world/story",
    });

    const dayKey = buildUserNewsBehaviorDayKey({
      orgId: "org-1",
      userId: "user-1",
      dayKey: "20260418",
    });

    expect(cache.hincrby).toHaveBeenCalledWith(dayKey, "p:actions:share", 1);
    expect(cache.hincrby).toHaveBeenCalledWith(dayKey, "p:sources:reuters", 4);
    expect(cache.hincrby).toHaveBeenCalledWith(dayKey, "p:items:item-1", 4);
    expect(cache.hincrby).toHaveBeenCalledWith(dayKey, "p:topics:ai", 4);
    expect(cache.hincrby).toHaveBeenCalledWith(dayKey, "p:entities:openai", 4);
    expect(cache.hincrby).toHaveBeenCalledWith(
      dayKey,
      "p:domains:reuters.com",
      4,
    );
    expect(cache.expire).toHaveBeenCalledWith(
      dayKey,
      USER_NEWS_BEHAVIOR_V2_RETENTION_SECONDS,
    );
    expect(cache.del).toHaveBeenCalledWith(
      buildUserNewsBehaviorProfileCacheKey({
        orgId: "org-1",
        userId: "user-1",
      }),
    );
    expect(prisma.userNewsBehaviorAggregate.upsert).toHaveBeenCalled();
    expect(prisma.userNewsSimilaritySnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { dirty: true },
      }),
    );
    expect(prisma.userNewsSimilaritySnapshot.updateMany).toHaveBeenCalledWith({
      where: {
        orgId: "org-1",
        userId: { not: "user-1" },
      },
      data: {
        dirty: true,
      },
    });
  });

  it("aggregates positive, negative, and legacy fallback scores", async () => {
    const hgetall = jest.fn(async (key: string) => {
      const data: Record<string, Record<string, string>> = {
        [buildUserNewsBehaviorDayKey({
          orgId: "org-1",
          userId: "user-1",
          dayKey: "20260418",
        })]: {
          "p:actions:view": "1",
          "p:sources:reuters": "4",
        },
        [buildUserNewsBehaviorDayKey({
          orgId: "org-1",
          userId: "user-1",
          dayKey: "20260415",
        })]: {
          "n:actions:not_interested": "1",
          "n:sources:reuters": "4",
        },
        [buildUserNewsBehaviorDayKey({
          orgId: "org-1",
          userId: "user-1",
          dayKey: "20260304",
        })]: {
          "p:topics:ai": "4",
        },
        [buildUserNewsBehaviorHashKey({
          orgId: "org-1",
          userId: "user-1",
          kind: "sources",
        })]: {
          bloomberg: "3",
        },
      };
      return data[key] ?? {};
    });
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      hgetall,
    };
    const service = new UserNewsBehaviorService(cache as any, createPrismaMock() as any);

    const profile = await service.getProfile("org-1", "user-1");
    const todaySourceScore = roundScore(
      Math.log1p(4) * computeUserNewsBehaviorDecayWeight(0),
    );
    const threeDayNegativeSourceScore = roundScore(
      Math.log1p(4) * computeUserNewsBehaviorDecayWeight(3),
    );
    const fortyFiveDayTopicScore = roundScore(
      Math.log1p(4) * computeUserNewsBehaviorDecayWeight(45),
    );

    expect(profile.positive.sources.reuters).toBe(todaySourceScore);
    expect(profile.negative.sources.reuters).toBe(threeDayNegativeSourceScore);
    expect(profile.sources.reuters).toBeGreaterThan(0);
    expect(profile.sources.bloomberg).toBeGreaterThan(0);
    expect(profile.topics.ai).toBe(fortyFiveDayTopicScore);
    expect(
      profile.bands.find((band) => band.key === "1d")?.positive.sources.reuters,
    ).toBe(todaySourceScore);
    expect(
      profile.bands.find((band) => band.key === "7d")?.negative.sources.reuters,
    ).toBe(threeDayNegativeSourceScore);
    expect(
      profile.bands.find((band) => band.key === "90d")?.positive.topics.ai,
    ).toBe(fortyFiveDayTopicScore);
    expect(profile.bands.find((band) => band.key === "90d")?.weight).toBe(
      roundScore(
        Array.from({ length: 60 }, (_, index) =>
          computeUserNewsBehaviorDecayWeight(index + 30),
        ).reduce((sum, value) => sum + value, 0) / 60,
      ),
    );
    expect(profile.meta.legacyFallbackUsed).toBe(true);
    expect(profile.meta.decayPolicy).toEqual({
      strategy: "exponential_half_life",
      halfLifeDays: 90,
      windowDays: 90,
    });
    expect(cache.set).toHaveBeenCalledTimes(1);
  });

  it("clears legacy and v2 profile keys", async () => {
    const cache = {
      delMany: jest.fn().mockResolvedValue(1),
    };
    const prisma = createPrismaMock();
    const service = new UserNewsBehaviorService(cache as any, prisma as any);

    await service.clearProfile("org-1", "user-1");

    const deletedKeys = cache.delMany.mock.calls[0]?.[0] as string[];
    expect(deletedKeys).toEqual(
      expect.arrayContaining([
        ...USER_NEWS_BEHAVIOR_HASH_KINDS.map((kind) =>
          buildUserNewsBehaviorHashKey({ orgId: "org-1", userId: "user-1", kind }),
        ),
        buildUserNewsBehaviorDayKey({
          orgId: "org-1",
          userId: "user-1",
          dayKey: "20260418",
        }),
        buildUserNewsBehaviorProfileCacheKey({
          orgId: "org-1",
          userId: "user-1",
        }),
      ]),
    );
    expect(prisma.userNewsBehaviorAggregate.deleteMany).toHaveBeenCalledWith({
      where: { orgId: "org-1", userId: "user-1" },
    });
    expect(prisma.userNewsSimilaritySnapshot.deleteMany).toHaveBeenCalledWith({
      where: { orgId: "org-1", userId: "user-1" },
    });
    expect(prisma.userNewsSimilaritySnapshot.updateMany).toHaveBeenCalledWith({
      where: {
        orgId: "org-1",
        userId: { not: "user-1" },
      },
      data: {
        dirty: true,
      },
    });
  });

  it("builds a collaborative profile from similar-user aggregates", async () => {
    const prisma = createPrismaMock();
    prisma.userNewsBehaviorAggregate.count.mockResolvedValue(1);
    prisma.userNewsSimilaritySnapshot.findUnique
      .mockResolvedValueOnce({
        dirty: false,
        computedAt: new Date("2026-04-18T11:00:00.000Z"),
        neighbors: [
          { userId: "user-2", similarity: 0.8, sharedSignals: 4 },
          { userId: "user-3", similarity: 0.5, sharedSignals: 3 },
        ],
      });
    prisma.userNewsBehaviorAggregate.findMany.mockResolvedValue([
      {
        userId: "user-2",
        signalType: "topic",
        signalKey: "ai",
        score: 4,
        lastInteractedAt: new Date("2026-04-18T10:00:00.000Z"),
      },
      {
        userId: "user-2",
        signalType: "item",
        signalKey: "item-1",
        score: 3,
        lastInteractedAt: new Date("2026-04-18T10:00:00.000Z"),
      },
      {
        userId: "user-3",
        signalType: "domain",
        signalKey: "example.com",
        score: 2,
        lastInteractedAt: new Date("2026-04-17T12:00:00.000Z"),
      },
    ]);
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      hgetall: jest.fn().mockResolvedValue({}),
      withLock: jest.fn(),
    };
    const service = new UserNewsBehaviorService(cache as any, prisma as any);

    const profile = await service.getCollaborativeProfile("org-1", "user-1");

    expect(profile.neighbors).toHaveLength(2);
    expect(profile.topics.ai).toBeGreaterThan(0);
    expect(profile.items["item-1"]).toBeGreaterThan(0);
    expect(profile.domains["example.com"]).toBe(
      roundScore(roundScore(2 * computeUserNewsBehaviorDecayWeight(1)) * 0.5),
    );
    expect(profile.degraded).toBe(false);
  });
});
