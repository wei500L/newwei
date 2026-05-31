import { ConflictException } from "@nestjs/common";

import { MultiTenantSchedulerSettingsService } from "./multi-tenant-scheduler-settings.service";

describe("MultiTenantSchedulerSettingsService", () => {
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

  let service: MultiTenantSchedulerSettingsService;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.systemSetting.findUnique = jest.fn().mockResolvedValue(null);
    prisma.systemSetting.upsert = jest.fn().mockResolvedValue(undefined);
    prisma.auditLog.create = jest.fn().mockResolvedValue(undefined);
    prisma.auditLogOutbox.create = jest.fn().mockResolvedValue(undefined);
    service = new MultiTenantSchedulerSettingsService(prisma);
  });

  it("returns default value when db record does not exist", async () => {
    await expect(service.getSettings()).resolves.toEqual({
      source: "default",
      newsEventsIngestionOrgConcurrency: 4,
      knowledgeGraphIngestionOrgConcurrency: 4,
      sentimentSnapshotOrgConcurrency: 2,
      newsnowHottestAnalysisOrgConcurrency: 6,
      classificationQualityAlertOrgConcurrency: 4,
      userDigestDeliveryOrgConcurrency: 4,
    });
  });

  it("throws when persisted value is invalid", async () => {
    prisma.systemSetting.findUnique.mockResolvedValue({
      key: "multi_tenant_scheduler_runtime_settings",
      value: {
        newsEventsIngestionOrgConcurrency: "invalid",
      },
    });

    try {
      await service.getSettings();
      throw new Error("expected getSettings to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      const conflict = error as ConflictException;
      expect(conflict.getResponse()).toMatchObject({
        code: "MULTI_TENANT_SCHEDULER_SETTINGS_INVALID",
        message: "Stored multi-tenant scheduler runtime settings are invalid.",
      });
    }
  });

  it("returns db override when persisted value is valid", async () => {
    prisma.systemSetting.findUnique.mockResolvedValue({
      key: "multi_tenant_scheduler_runtime_settings",
      value: {
        newsEventsIngestionOrgConcurrency: "6",
        knowledgeGraphIngestionOrgConcurrency: 5,
        sentimentSnapshotOrgConcurrency: 3,
        newsnowHottestAnalysisOrgConcurrency: 8,
        classificationQualityAlertOrgConcurrency: 4,
        userDigestDeliveryOrgConcurrency: 2,
      },
    });

    await expect(service.getSettings()).resolves.toEqual({
      source: "db",
      newsEventsIngestionOrgConcurrency: 6,
      knowledgeGraphIngestionOrgConcurrency: 5,
      sentimentSnapshotOrgConcurrency: 3,
      newsnowHottestAnalysisOrgConcurrency: 8,
      classificationQualityAlertOrgConcurrency: 4,
      userDigestDeliveryOrgConcurrency: 2,
    });
  });

  it("falls back to defaults for newly added fields when persisted record is old", async () => {
    prisma.systemSetting.findUnique.mockResolvedValue({
      key: "multi_tenant_scheduler_runtime_settings",
      value: {
        newsEventsIngestionOrgConcurrency: 5,
      },
    });

    await expect(service.getSettings()).resolves.toEqual({
      source: "db",
      newsEventsIngestionOrgConcurrency: 5,
      knowledgeGraphIngestionOrgConcurrency: 4,
      sentimentSnapshotOrgConcurrency: 2,
      newsnowHottestAnalysisOrgConcurrency: 6,
      classificationQualityAlertOrgConcurrency: 4,
      userDigestDeliveryOrgConcurrency: 4,
    });
  });

  it("caches runtime settings for repeated scheduler reads", async () => {
    prisma.systemSetting.findUnique.mockResolvedValue({
      key: "multi_tenant_scheduler_runtime_settings",
      value: {
        newsEventsIngestionOrgConcurrency: 7,
        knowledgeGraphIngestionOrgConcurrency: 4,
        sentimentSnapshotOrgConcurrency: 2,
        newsnowHottestAnalysisOrgConcurrency: 6,
        classificationQualityAlertOrgConcurrency: 5,
        userDigestDeliveryOrgConcurrency: 3,
      },
    });

    const first = await service.getRuntimeSettings();
    const second = await service.getRuntimeSettings();

    expect(first).toEqual(second);
    expect(prisma.systemSetting.findUnique).toHaveBeenCalledTimes(1);
  });

  it("updates settings and writes audit log", async () => {
    await service.updateSettings("org-1", "actor-1", {
      newsEventsIngestionOrgConcurrency: 5,
      knowledgeGraphIngestionOrgConcurrency: 4,
      sentimentSnapshotOrgConcurrency: 3,
      newsnowHottestAnalysisOrgConcurrency: 7,
      classificationQualityAlertOrgConcurrency: 4,
      userDigestDeliveryOrgConcurrency: 4,
    });

    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "multi_tenant_scheduler_runtime_settings" },
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it("rejects invalid update payload without silently falling back", async () => {
    await expect(
      service.updateSettings("org-1", "actor-1", {
        newsEventsIngestionOrgConcurrency: 17,
        knowledgeGraphIngestionOrgConcurrency: 4,
        sentimentSnapshotOrgConcurrency: 2,
        newsnowHottestAnalysisOrgConcurrency: 6,
        classificationQualityAlertOrgConcurrency: 4,
        userDigestDeliveryOrgConcurrency: 4,
      }),
    ).rejects.toThrow(
      "newsEventsIngestionOrgConcurrency must be an integer between 1 and 16",
    );
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });
});
