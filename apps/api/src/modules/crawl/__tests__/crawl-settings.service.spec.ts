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
    retryBackoffMs: 5_000,
    maxConcurrency: 3
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
    expect(settings.requestTimeoutHotMs).toBe(60_000);
    expect(settings.requestTimeoutNormalMs).toBe(envMock.crawl4aiConfig.timeoutMs);
    expect(settings.maxRetries).toBe(envMock.crawl4aiConfig.maxRetries);
    expect(settings.queueOverloadCooldownMs).toBe(30_000);
    expect(settings.adaptiveConcurrencyEnabled).toBe(false);
    expect(settings.adaptiveWindowMinutes).toBe(15);
    expect(settings.adaptiveCooldownMinutes).toBe(5);
    expect(settings.adaptiveLatencyThresholdRatio).toBe(0.85);
    expect(settings.adaptiveErrorRateThreshold).toBe(0.2);
    expect(settings.adaptiveMemoryHeadroomThreshold).toBe(0.12);
    expect(settings.maxConcurrency).toBe(envMock.crawl4aiConfig.maxConcurrency);
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
        retryBackoffMs: 200, // should clamp up
        queueOverloadCooldownMs: 1_000_000, // should clamp down
        adaptiveWindowMinutes: 0, // should clamp up
        adaptiveCooldownMinutes: 99, // should clamp down
        adaptiveLatencyThresholdRatio: 9, // should clamp down
        adaptiveErrorRateThreshold: 0, // should clamp up
        adaptiveMemoryHeadroomThreshold: -0.1, // should clamp up
        maxConcurrency: 999 // should clamp down
      }
    });
    const settings = await service.getSettings();
    expect(settings.healthCheckTtlMs).toBe(10_000);
    expect(settings.requestTimeoutMs).toBe(900_000);
    expect(settings.requestTimeoutHotMs).toBe(60_000);
    expect(settings.requestTimeoutNormalMs).toBe(900_000);
    expect(settings.maxRetries).toBe(10);
    expect(settings.retryBackoffMs).toBe(500);
    expect(settings.queueOverloadCooldownMs).toBe(600_000);
    expect(settings.adaptiveConcurrencyEnabled).toBe(false);
    expect(settings.adaptiveWindowMinutes).toBe(1);
    expect(settings.adaptiveCooldownMinutes).toBe(60);
    expect(settings.adaptiveLatencyThresholdRatio).toBe(0.99);
    expect(settings.adaptiveErrorRateThreshold).toBe(0.01);
    expect(settings.adaptiveMemoryHeadroomThreshold).toBe(0.01);
    expect(settings.maxConcurrency).toBe(20);
  });

  it("updates settings and writes audit log", async () => {
    await service.updateSettings("org-1", "admin-1", {
      healthCheckTtlMs: 90_000,
      requestTimeoutHotMs: 60_000,
      requestTimeoutNormalMs: 150_000,
      maxRetries: 2,
      retryBackoffMs: 8_000,
      queueOverloadCooldownMs: 45_000,
      adaptiveConcurrencyEnabled: true,
      adaptiveWindowMinutes: 20,
      adaptiveCooldownMinutes: 6,
      adaptiveLatencyThresholdRatio: 0.9,
      adaptiveErrorRateThreshold: 0.25,
      adaptiveMemoryHeadroomThreshold: 0.15,
      maxConcurrency: 6
    });
    expect(prismaMock.$transaction).toHaveBeenCalled();
    expect(prismaMock.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "crawl_client_settings" },
        update: expect.objectContaining({
          value: {
            healthCheckTtlMs: 90_000,
            requestTimeoutMs: 150_000,
            requestTimeoutHotMs: 60_000,
            requestTimeoutNormalMs: 150_000,
            maxRetries: 2,
            retryBackoffMs: 8_000,
            queueOverloadCooldownMs: 45_000,
            adaptiveConcurrencyEnabled: true,
            adaptiveWindowMinutes: 20,
            adaptiveCooldownMinutes: 6,
            adaptiveLatencyThresholdRatio: 0.9,
            adaptiveErrorRateThreshold: 0.25,
            adaptiveMemoryHeadroomThreshold: 0.15,
            maxConcurrency: 6
          }
        })
      })
    );
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "crawl_client_settings_update",
          orgId: "org-1",
          actorId: "admin-1",
          metadata: expect.objectContaining({
            settingsKey: "crawl_client_settings",
            changedCount: expect.any(Number),
            changedFields: expect.arrayContaining([
              "requestTimeoutNormalMs",
              "adaptiveConcurrencyEnabled",
              "maxConcurrency"
            ]),
            inputFields: expect.arrayContaining([
              "requestTimeoutHotMs",
              "requestTimeoutNormalMs",
              "adaptiveConcurrencyEnabled",
              "maxConcurrency"
            ]),
            before: expect.any(Object),
            after: expect.objectContaining({
              requestTimeoutNormalMs: 150_000,
              adaptiveConcurrencyEnabled: true,
              maxConcurrency: 6
            })
          })
        })
      })
    );

    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue({
      key: "crawl_client_settings",
      value: {
        healthCheckTtlMs: 90_000,
        requestTimeoutHotMs: 60_000,
        requestTimeoutNormalMs: 150_000,
        maxRetries: 2,
        retryBackoffMs: 8_000,
        queueOverloadCooldownMs: 45_000,
        adaptiveConcurrencyEnabled: true,
        adaptiveWindowMinutes: 20,
        adaptiveCooldownMinutes: 6,
        adaptiveLatencyThresholdRatio: 0.9,
        adaptiveErrorRateThreshold: 0.25,
        adaptiveMemoryHeadroomThreshold: 0.15,
        maxConcurrency: 6
      }
    });

    const refreshed = await service.getSettings();
    expect(refreshed.maxRetries).toBe(2);
    expect(refreshed.queueOverloadCooldownMs).toBe(45_000);
    expect(refreshed.adaptiveConcurrencyEnabled).toBe(true);
    expect(refreshed.adaptiveWindowMinutes).toBe(20);
    expect(refreshed.adaptiveCooldownMinutes).toBe(6);
    expect(refreshed.adaptiveLatencyThresholdRatio).toBe(0.9);
    expect(refreshed.adaptiveErrorRateThreshold).toBe(0.25);
    expect(refreshed.adaptiveMemoryHeadroomThreshold).toBe(0.15);
    expect(refreshed.maxConcurrency).toBe(6);
    expect(prismaMock.systemSetting.findUnique).toHaveBeenCalled();
  });

  it("skips audit log write when normalized settings do not change", async () => {
    await service.updateSettings("org-1", "admin-1", {});
    expect(prismaMock.$transaction).toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });
});
