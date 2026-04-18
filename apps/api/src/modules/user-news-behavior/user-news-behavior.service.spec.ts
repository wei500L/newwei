import {
  buildUserNewsBehaviorDayKey,
  buildUserNewsBehaviorHashKey,
  buildUserNewsBehaviorProfileCacheKey,
  USER_NEWS_BEHAVIOR_HASH_KINDS,
  USER_NEWS_BEHAVIOR_V2_RETENTION_SECONDS,
} from "./user-news-behavior.constants";
import { UserNewsBehaviorService } from "./user-news-behavior.service";

describe("UserNewsBehaviorService", () => {
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
    const service = new UserNewsBehaviorService(cache as any);

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
    const service = new UserNewsBehaviorService(cache as any);

    const profile = await service.getProfile("org-1", "user-1");

    expect(profile.positive.sources.reuters).toBeGreaterThan(0);
    expect(profile.negative.sources.reuters).toBeGreaterThan(0);
    expect(profile.sources.reuters).toBeGreaterThan(0);
    expect(profile.sources.bloomberg).toBeGreaterThan(0);
    expect(profile.bands.find((band) => band.key === "1d")?.positive.sources.reuters).toBeGreaterThan(0);
    expect(profile.bands.find((band) => band.key === "7d")?.negative.sources.reuters).toBeGreaterThan(0);
    expect(profile.meta.legacyFallbackUsed).toBe(true);
    expect(cache.set).toHaveBeenCalledTimes(1);
  });

  it("clears legacy and v2 profile keys", async () => {
    const cache = {
      delMany: jest.fn().mockResolvedValue(1),
    };
    const service = new UserNewsBehaviorService(cache as any);

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
  });
});
