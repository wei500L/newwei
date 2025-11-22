import { AuditLogSettingsService } from "./audit-log-settings.service";

describe("AuditLogSettingsService", () => {
  const prismaMock = {
    systemSetting: {
      findUnique: jest.fn(),
      upsert: jest.fn()
    },
    auditLog: {
      create: jest.fn()
    }
  } as unknown as any;

  const envMock = {
    auditLogRetentionDays: 90
  } as unknown as any;

  beforeEach(() => {
    jest.resetAllMocks();
    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue(null);
    prismaMock.systemSetting.upsert = jest.fn().mockResolvedValue({ key: "audit_log_retention" });
    prismaMock.auditLog.create = jest.fn().mockResolvedValue(null);
    prismaMock.$transaction = jest.fn(async (operations: any) => {
      if (Array.isArray(operations)) {
        await Promise.all(operations);
        return null;
      }
      return operations;
    });
  });

  it("returns fallback from env when no setting exists", async () => {
    const service = new AuditLogSettingsService(prismaMock, envMock);

    const days = await service.getRetentionDays();

    expect(days).toBe(envMock.auditLogRetentionDays);
    expect(prismaMock.systemSetting.findUnique).toHaveBeenCalled();
  });

  it("normalizes stored values and caches result", async () => {
    const service = new AuditLogSettingsService(prismaMock, envMock);
    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue({
      key: "audit_log_retention_days",
      value: { retentionDays: 0 }
    });

    const days = await service.getRetentionDays();
    const daysSecondCall = await service.getRetentionDays();

    expect(days).toBe(1);
    expect(daysSecondCall).toBe(1);
    expect(prismaMock.systemSetting.findUnique).toHaveBeenCalledTimes(1);
  });

  it("persists updates and writes audit log", async () => {
    const service = new AuditLogSettingsService(prismaMock, envMock);

    const updated = await service.updateRetentionDays("org-1", "user-1", 15);

    expect(updated).toBe(15);
    expect(prismaMock.systemSetting.upsert).toHaveBeenCalled();
    expect(prismaMock.auditLog.create).toHaveBeenCalled();
  });
});
