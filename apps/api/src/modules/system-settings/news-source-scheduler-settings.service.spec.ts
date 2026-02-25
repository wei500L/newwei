import { ConflictException } from "@nestjs/common";

import { NewsSourceSchedulerSettingsService } from "./news-source-scheduler-settings.service";

describe("NewsSourceSchedulerSettingsService", () => {
  const prisma = {
    systemSetting: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
    auditLogOutbox: {
      create: jest.fn(),
    },
  } as any;
  const cache = {
    delByPrefix: jest.fn(),
  } as any;

  let service: NewsSourceSchedulerSettingsService;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.systemSetting.findUnique = jest.fn().mockResolvedValue(null);
    prisma.systemSetting.upsert = jest.fn();
    prisma.auditLog.create = jest.fn().mockResolvedValue(undefined);
    prisma.auditLogOutbox.create = jest.fn().mockResolvedValue(undefined);
    cache.delByPrefix = jest.fn().mockResolvedValue(0);
    service = new NewsSourceSchedulerSettingsService(prisma, cache);
  });

  it("returns default value when db record does not exist", async () => {
    const settings = await service.getSettings();

    expect(settings).toEqual({
      source: "default",
      seedFreshnessWindowDays: 365,
      seedCacheTtlSecondsSitemapRss: 60,
      seedCacheTtlSecondsListDeep: 180,
      seedCacheTtlForceGlobal: false,
    });
  });

  it("throws when persisted value is invalid", async () => {
    prisma.systemSetting.findUnique = jest.fn().mockResolvedValue({
      key: "news_source_scheduler_settings",
      value: {
        seedFreshnessWindowDays: "not-a-number",
      },
    });
    try {
      await service.getSettings();
      throw new Error("expected getSettings to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      const conflict = error as ConflictException;
      expect(conflict.getResponse()).toMatchObject({
        code: "NEWS_SOURCE_SCHEDULER_SETTINGS_INVALID",
        message: "Stored news source scheduler settings are invalid.",
      });
    }
  });

  it("throws when persisted value is out of range", async () => {
    prisma.systemSetting.findUnique = jest.fn().mockResolvedValue({
      key: "news_source_scheduler_settings",
      value: {
        seedFreshnessWindowDays: 4_000,
      },
    });

    try {
      await service.getSettings();
      throw new Error("expected getSettings to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      const conflict = error as ConflictException;
      expect(conflict.getResponse()).toMatchObject({
        code: "NEWS_SOURCE_SCHEDULER_SETTINGS_INVALID",
        message: "Stored news source scheduler settings are invalid.",
      });
    }
  });

  it("returns db override when persisted value is valid", async () => {
    prisma.systemSetting.findUnique = jest.fn().mockResolvedValue({
      key: "news_source_scheduler_settings",
      value: {
        seedFreshnessWindowDays: "30",
        seedCacheTtlSecondsSitemapRss: "90",
        seedCacheTtlSecondsListDeep: 240,
        seedCacheTtlForceGlobal: true,
      },
    });

    const settings = await service.getSettings();

    expect(settings).toEqual({
      source: "db",
      seedFreshnessWindowDays: 30,
      seedCacheTtlSecondsSitemapRss: 90,
      seedCacheTtlSecondsListDeep: 240,
      seedCacheTtlForceGlobal: true,
    });
  });

  it("falls back to defaults for newly added fields when persisted record is old", async () => {
    prisma.systemSetting.findUnique = jest.fn().mockResolvedValue({
      key: "news_source_scheduler_settings",
      value: {
        seedFreshnessWindowDays: 30,
      },
    });

    const settings = await service.getSettings();
    expect(settings).toEqual({
      source: "db",
      seedFreshnessWindowDays: 30,
      seedCacheTtlSecondsSitemapRss: 60,
      seedCacheTtlSecondsListDeep: 180,
      seedCacheTtlForceGlobal: false,
    });
  });

  it("updates settings and writes audit log", async () => {
    await service.updateSettings("org-1", "actor-1", {
      seedFreshnessWindowDays: 45,
      seedCacheTtlSecondsSitemapRss: 75,
      seedCacheTtlSecondsListDeep: 210,
      seedCacheTtlForceGlobal: true,
    });

    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "news_source_scheduler_settings" },
      }),
    );
    expect(cache.delByPrefix).toHaveBeenCalledTimes(4);
    expect(cache.delByPrefix).toHaveBeenCalledWith("news-source:sitemap:");
    expect(cache.delByPrefix).toHaveBeenCalledWith("news-source:rss:");
    expect(cache.delByPrefix).toHaveBeenCalledWith("news-source:list:");
    expect(cache.delByPrefix).toHaveBeenCalledWith("news-source:deep:");
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it("rejects invalid update payload without silently falling back", async () => {
    await expect(
      service.updateSettings("org-1", "actor-1", {
        seedFreshnessWindowDays: 4_000,
        seedCacheTtlSecondsSitemapRss: 75,
        seedCacheTtlSecondsListDeep: 210,
        seedCacheTtlForceGlobal: false,
      }),
    ).rejects.toThrow(
      "seedFreshnessWindowDays must be an integer between 1 and 3650",
    );
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it("rejects invalid sitemap/rss ttl in update payload", async () => {
    await expect(
      service.updateSettings("org-1", "actor-1", {
        seedFreshnessWindowDays: 45,
        seedCacheTtlSecondsSitemapRss: 9,
        seedCacheTtlSecondsListDeep: 210,
        seedCacheTtlForceGlobal: false,
      }),
    ).rejects.toThrow(
      "seedCacheTtlSecondsSitemapRss must be an integer between 10 and 3600",
    );
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it("rejects invalid list/deep ttl in update payload", async () => {
    await expect(
      service.updateSettings("org-1", "actor-1", {
        seedFreshnessWindowDays: 45,
        seedCacheTtlSecondsSitemapRss: 75,
        seedCacheTtlSecondsListDeep: 3_601,
        seedCacheTtlForceGlobal: false,
      }),
    ).rejects.toThrow(
      "seedCacheTtlSecondsListDeep must be an integer between 10 and 3600",
    );
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it("rejects invalid cache ttl strategy toggle in update payload", async () => {
    await expect(
      service.updateSettings("org-1", "actor-1", {
        seedFreshnessWindowDays: 45,
        seedCacheTtlSecondsSitemapRss: 75,
        seedCacheTtlSecondsListDeep: 210,
        seedCacheTtlForceGlobal: "true" as unknown as boolean,
      }),
    ).rejects.toThrow("seedCacheTtlForceGlobal must be a boolean");
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it("does not fail update when cache invalidation throws", async () => {
    cache.delByPrefix = jest.fn().mockRejectedValue(new Error("redis down"));

    await expect(
      service.updateSettings("org-1", "actor-1", {
        seedFreshnessWindowDays: 45,
        seedCacheTtlSecondsSitemapRss: 75,
        seedCacheTtlSecondsListDeep: 210,
        seedCacheTtlForceGlobal: false,
      }),
    ).resolves.toMatchObject({
      source: "db",
      seedFreshnessWindowDays: 45,
      seedCacheTtlSecondsSitemapRss: 75,
      seedCacheTtlSecondsListDeep: 210,
      seedCacheTtlForceGlobal: false,
    });
    expect(prisma.systemSetting.upsert).toHaveBeenCalled();
  });
});
