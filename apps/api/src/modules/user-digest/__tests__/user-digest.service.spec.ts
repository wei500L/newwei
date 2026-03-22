import { UserDigestService } from "../user-digest.service";

describe("UserDigestService", () => {
  it("returns default preference when missing", async () => {
    const prisma = {
      userSetting: {
        findUnique: jest.fn().mockResolvedValue(null)
      }
    };
    const contentSubscriptions = {
      getDigestPreferenceValues: jest.fn().mockResolvedValue({
        focusTopics: [],
        focusEntities: [],
      }),
    };

    const service = new UserDigestService(prisma as any, contentSubscriptions as any);
    const pref = await service.getPreference("org-1", "user-1");

    expect(pref).toEqual(
      expect.objectContaining({
        version: 1,
        windowDays: 3,
        maxEvents: 8,
        includeIndicators: true,
        maxIndicatorsPerEvent: 5
      })
    );
  });

  it("upserts normalized preference on update", async () => {
    const prisma = {
      userSetting: {
        findUnique: jest.fn().mockResolvedValue({
          value: {
            focusEntities: ["  ACME  ", "", "ACME", "MegaCorp"],
            windowDays: 999,
            maxEvents: 0,
            includeIndicators: false,
            maxIndicatorsPerEvent: 200
          }
        }),
        upsert: jest.fn().mockResolvedValue(null)
      }
    };
    const contentSubscriptions = {
      replaceSubscriptionsFromDigestPreference: jest.fn().mockResolvedValue(undefined),
      getDigestPreferenceValues: jest.fn().mockResolvedValue({
        focusEntities: ["ACME", "MegaCorp"],
        focusTopics: ["macro", "policy"],
      }),
    };

    const service = new UserDigestService(prisma as any, contentSubscriptions as any);
    const pref = await service.updatePreference("org-1", "user-1", {
      focusTopics: ["  macro  ", "policy"],
      includeIndicators: true
    });

    expect(pref.focusEntities).toEqual(["ACME", "MegaCorp"]);
    expect(pref.focusTopics).toEqual(["macro", "policy"]);
    expect(pref.windowDays).toBe(30);
    expect(pref.maxEvents).toBe(1);
    expect(pref.includeIndicators).toBe(true);
    expect(pref.maxIndicatorsPerEvent).toBe(50);
    expect(contentSubscriptions.replaceSubscriptionsFromDigestPreference).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      { focusTopics: ["  macro  ", "policy"] },
    );

    expect(prisma.userSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          key: "ai:digest:preference:v1"
        }),
        update: expect.objectContaining({
          value: expect.any(Object)
        })
      })
    );
  });

  it("projects focus arrays from content subscriptions on read", async () => {
    const prisma = {
      userSetting: {
        findUnique: jest.fn().mockResolvedValue({
          value: {
            focusEntities: ["stale entity"],
            focusTopics: ["stale topic"],
            windowDays: 5,
          },
        }),
      },
    };
    const contentSubscriptions = {
      getDigestPreferenceValues: jest.fn().mockResolvedValue({
        focusEntities: ["NVIDIA"],
        focusTopics: ["AI chips"],
      }),
    };

    const service = new UserDigestService(prisma as any, contentSubscriptions as any);
    const pref = await service.getPreference("org-1", "user-1");

    expect(pref.focusEntities).toEqual(["NVIDIA"]);
    expect(pref.focusTopics).toEqual(["AI chips"]);
    expect(pref.windowDays).toBe(5);
  });

  it("batch loads sentiments and indicator associations when generating a digest", async () => {
    const prisma = {
      userSetting: {
        findUnique: jest.fn().mockResolvedValue({
          value: {
            windowDays: 3,
            maxEvents: 2,
            includeIndicators: true,
            maxIndicatorsPerEvent: 2,
          },
        }),
      },
      newsEvent: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "event-1",
            title: "Event 1",
            summary: "Summary 1",
            primaryTopic: "macro",
            primaryEntity: "ACME",
            startAt: new Date("2026-01-01T00:00:00.000Z"),
            lastAt: new Date("2026-01-02T00:00:00.000Z"),
            _count: { items: 4 },
            representativeProcessedArticle: { article: { url: "https://example.com/1" } },
          },
          {
            id: "event-2",
            title: "Event 2",
            summary: "Summary 2",
            primaryTopic: "macro",
            primaryEntity: "ACME",
            startAt: new Date("2026-01-01T12:00:00.000Z"),
            lastAt: new Date("2026-01-02T12:00:00.000Z"),
            _count: { items: 2 },
            representativeProcessedArticle: { article: { url: "https://example.com/2" } },
          },
        ]),
      },
      topicSentimentSnapshot: {
        findMany: jest.fn().mockResolvedValue([
          {
            topic: "macro",
            bucketStart: new Date("2026-01-02T00:00:00.000Z"),
            totalDocs: 20,
            avgScore: 0.4,
            negativeRatio: 0.1,
          },
        ]),
      },
      entitySentimentSnapshot: {
        findMany: jest.fn().mockResolvedValue([
          {
            entityName: "ACME",
            bucketStart: new Date("2026-01-02T00:00:00.000Z"),
            totalDocs: 12,
            avgScore: 0.2,
            negativeRatio: 0.25,
          },
        ]),
      },
      newsIndicatorAssociation: {
        findMany: jest.fn().mockResolvedValue([
          {
            scopeType: "topic",
            scopeKey: "macro",
            featureMetric: "volume",
            lagDays: 1,
            correlation: 0.8,
            pValue: 0.05,
            indicatorItem: {
              slug: "gdp",
              displayName: "GDP",
            },
            backtests: [],
          },
          {
            scopeType: "entity",
            scopeKey: "ACME",
            featureMetric: "volume",
            lagDays: 2,
            correlation: 0.7,
            pValue: 0.1,
            indicatorItem: {
              slug: "sales",
              displayName: "Sales",
            },
            backtests: [],
          },
        ]),
      },
    };
    const contentSubscriptions = {
      getDigestPreferenceValues: jest.fn().mockResolvedValue({
        focusTopics: ["macro"],
        focusEntities: ["ACME"],
      }),
    };

    const service = new UserDigestService(prisma as any, contentSubscriptions as any);
    const digest = await service.generateDigest("org-1", "user-1");

    expect(prisma.newsEvent.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.topicSentimentSnapshot.findMany).toHaveBeenCalledWith({
      where: { orgId: "org-1", topic: { in: ["macro"] } },
      orderBy: [{ topic: "asc" }, { bucketStart: "desc" }],
      select: { topic: true, bucketStart: true, totalDocs: true, avgScore: true, negativeRatio: true },
    });
    expect(prisma.entitySentimentSnapshot.findMany).toHaveBeenCalledWith({
      where: { orgId: "org-1", entityName: { in: ["ACME"] } },
      orderBy: [{ entityName: "asc" }, { bucketStart: "desc" }, { entityType: "asc" }],
      select: { entityName: true, bucketStart: true, totalDocs: true, avgScore: true, negativeRatio: true },
    });
    expect(prisma.newsIndicatorAssociation.findMany).toHaveBeenCalledTimes(1);
    expect(digest.events).toHaveLength(2);
    expect(digest.events[0]?.topicSentiment).toMatchObject({ avgScore: 0.4 });
    expect(digest.events[0]?.entitySentiment).toMatchObject({ avgScore: 0.2 });
    expect(digest.events[0]?.indicatorAssociations).toHaveLength(2);
    expect(digest.events[1]?.indicatorAssociations).toHaveLength(2);
  });
});
