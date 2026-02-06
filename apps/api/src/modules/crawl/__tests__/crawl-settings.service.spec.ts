import { CrawlSettingsService } from "../crawl-settings.service";

const prismaMock = {
  systemSetting: {
    findUnique: jest.fn(),
    upsert: jest.fn()
  },
  auditLog: {
    create: jest.fn()
  },
  $transaction: jest.fn()
} as any;

const envMock = {
  crawl4aiConfig: {
    timeoutMs: 120_000,
    maxRetries: 3,
    healthCheckTtlMs: 60_000,
    retryBackoffMs: 5_000
  }
} as any;

describe("CrawlSettingsService", () => {
  let service: CrawlSettingsService;

  beforeEach(() => {
    jest.resetAllMocks();
    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue(null);
    prismaMock.systemSetting.upsert = jest.fn().mockResolvedValue(undefined);
    prismaMock.auditLog.create = jest.fn().mockResolvedValue(undefined);
    prismaMock.$transaction = jest
      .fn()
      .mockImplementation(async (operations: Promise<any>[]) => Promise.all(operations));
    service = new CrawlSettingsService(prismaMock, envMock);
  });

  it("returns environment defaults when no setting is persisted", async () => {
    const settings = await service.getSettings();
    expect(settings.healthCheckTtlMs).toBe(envMock.crawl4aiConfig.healthCheckTtlMs);
    expect(settings.requestTimeoutMs).toBe(envMock.crawl4aiConfig.timeoutMs);
    expect(settings.maxRetries).toBe(envMock.crawl4aiConfig.maxRetries);
    expect(prismaMock.systemSetting.findUnique).toHaveBeenCalledWith({
      where: { key: "crawl_client_settings" }
    });
  });

  it("prefers stored settings and clamps to safe ranges", async () => {
    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue({
      key: "crawl_client_settings",
      value: {
        healthCheckTtlMs: 10_000,
        requestTimeoutMs: 1_500_000, // should clamp down
        maxRetries: 12, // should clamp down
        retryBackoffMs: 200 // should clamp up
      }
    });
    const settings = await service.getSettings();
    expect(settings.healthCheckTtlMs).toBe(10_000);
    expect(settings.requestTimeoutMs).toBe(900_000);
    expect(settings.maxRetries).toBe(10);
    expect(settings.retryBackoffMs).toBe(500);
  });

  it("updates settings and writes audit log", async () => {
    await service.updateSettings("org-1", "admin-1", {
      healthCheckTtlMs: 90_000,
      requestTimeoutMs: 150_000,
      maxRetries: 2,
      retryBackoffMs: 8_000
    });
    expect(prismaMock.$transaction).toHaveBeenCalled();
    expect(prismaMock.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "crawl_client_settings" },
        update: expect.objectContaining({
          value: {
            healthCheckTtlMs: 90_000,
            requestTimeoutMs: 150_000,
            maxRetries: 2,
            retryBackoffMs: 8_000
          }
        })
      })
    );
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "crawl_client_settings_update",
          orgId: "org-1",
          actorId: "admin-1"
        })
      })
    );

    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue({
      key: "crawl_client_settings",
      value: {
        healthCheckTtlMs: 90_000,
        requestTimeoutMs: 150_000,
        maxRetries: 2,
        retryBackoffMs: 8_000
      }
    });

    const refreshed = await service.getSettings();
    expect(refreshed.maxRetries).toBe(2);
    expect(prismaMock.systemSetting.findUnique).toHaveBeenCalled();
  });
});
