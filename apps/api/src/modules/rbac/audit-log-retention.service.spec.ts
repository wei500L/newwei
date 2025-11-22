import { AuditLogRetentionService } from "./audit-log-retention.service";

describe("AuditLogRetentionService", () => {
  const prismaMock = {
    auditLog: {
      deleteMany: jest.fn()
    }
  } as unknown as any;

  const settingsMock = {
    getRetentionDays: jest.fn()
  } as unknown as any;

  beforeEach(() => {
    jest.resetAllMocks();
    prismaMock.auditLog.deleteMany = jest.fn().mockResolvedValue({ count: 3 });
    settingsMock.getRetentionDays = jest.fn().mockResolvedValue(90);
  });

  it("purges logs older than the retention window", async () => {
    const service = new AuditLogRetentionService(prismaMock, settingsMock);
    const now = new Date("2024-01-10T00:00:00Z");

    const removed = await service.purgeExpiredAuditLogs(now);

    expect(removed).toBe(3);
    expect(settingsMock.getRetentionDays).toHaveBeenCalled();
    expect(prismaMock.auditLog.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: expect.any(Date) } }
    });
    const cutoff = prismaMock.auditLog.deleteMany.mock.calls[0][0].where.createdAt
      .lt as Date;
    expect(cutoff.getTime()).toBe(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  });

  it("enforces at least a one day retention window", async () => {
    settingsMock.getRetentionDays = jest.fn().mockResolvedValue(0);
    const service = new AuditLogRetentionService(prismaMock, settingsMock);
    const now = new Date("2024-01-10T00:00:00Z");

    await service.purgeExpiredAuditLogs(now);

    const cutoff = prismaMock.auditLog.deleteMany.mock.calls[0][0].where.createdAt
      .lt as Date;
    expect(cutoff.getTime()).toBe(now.getTime() - 24 * 60 * 60 * 1000);
  });

  it("logs and swallows errors during scheduled cleanup", async () => {
    const service = new AuditLogRetentionService(prismaMock, settingsMock);
    jest.spyOn(service, "purgeExpiredAuditLogs").mockRejectedValue(new Error("db down"));
    const loggerSpy = jest.spyOn(service["logger"], "error").mockImplementation();

    await service.handleCron();

    expect(loggerSpy).toHaveBeenCalled();
  });
});
