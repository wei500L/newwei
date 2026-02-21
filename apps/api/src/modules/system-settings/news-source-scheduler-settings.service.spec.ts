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

  let service: NewsSourceSchedulerSettingsService;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.systemSetting.findUnique = jest.fn().mockResolvedValue(null);
    prisma.systemSetting.upsert = jest.fn();
    prisma.auditLog.create = jest.fn().mockResolvedValue(undefined);
    prisma.auditLogOutbox.create = jest.fn().mockResolvedValue(undefined);
    service = new NewsSourceSchedulerSettingsService(prisma);
  });

  it("returns default value when db record does not exist", async () => {
    const settings = await service.getSettings();

    expect(settings).toEqual({
      source: "default",
      seedFreshnessWindowDays: 365,
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
      },
    });

    const settings = await service.getSettings();

    expect(settings).toEqual({
      source: "db",
      seedFreshnessWindowDays: 30,
    });
  });

  it("updates settings and writes audit log", async () => {
    await service.updateSettings("org-1", "actor-1", {
      seedFreshnessWindowDays: 45,
    });

    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "news_source_scheduler_settings" },
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it("rejects invalid update payload without silently falling back", async () => {
    await expect(
      service.updateSettings("org-1", "actor-1", {
        seedFreshnessWindowDays: 4_000,
      }),
    ).rejects.toThrow(
      "seedFreshnessWindowDays must be an integer between 1 and 3650",
    );
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });
});
