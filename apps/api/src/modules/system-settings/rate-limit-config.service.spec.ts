import { RateLimitConfigService } from "./rate-limit-config.service";

const prismaMock = {
  systemSetting: {
    findMany: jest.fn(),
    upsert: jest.fn()
  },
  $transaction: jest.fn()
} as any;

const envMock = {
  rateLimit: {
    login: 5,
    loginWindowSeconds: 60,
    crawlTaskCreate: 10,
    crawlTaskCreateWindowSeconds: 300,
    rbacWrite: 4,
    rbacWriteWindowSeconds: 600
  }
} as any;

describe("RateLimitConfigService", () => {
  let service: RateLimitConfigService;

  beforeEach(() => {
    jest.resetAllMocks();
    prismaMock.systemSetting.findMany = jest.fn().mockResolvedValue([]);
    prismaMock.systemSetting.upsert = jest.fn().mockResolvedValue(undefined);
    prismaMock.$transaction = jest
      .fn()
      .mockImplementation(async (operations: Promise<any>[]) => Promise.all(operations));
    service = new RateLimitConfigService(prismaMock, envMock);
  });

  it("falls back to environment defaults when no settings exist", async () => {
    const settings = await service.getRateLimitSettings();
    expect(settings.login.limit).toBe(envMock.rateLimit.login);
    expect(settings.crawlCreate.windowSeconds).toBe(envMock.rateLimit.crawlTaskCreateWindowSeconds);
    expect(prismaMock.systemSetting.findMany).toHaveBeenCalled();
  });

  it("prefers persisted settings when available", async () => {
    prismaMock.systemSetting.findMany = jest.fn().mockResolvedValue([
      { key: "rate_limit_login", value: { limit: 8, windowSeconds: 90 } },
      { key: "rate_limit_crawl_create", value: { limit: 2, windowSeconds: 600 } },
      { key: "rate_limit_rbac_write", value: { limit: 3, windowSeconds: 420 } }
    ]);
    const settings = await service.getRateLimitSettings();
    expect(settings.login).toEqual({ limit: 8, windowSeconds: 90 });
    expect(settings.crawlCreate).toEqual({ limit: 2, windowSeconds: 600 });
    expect(settings.rbacWrite).toEqual({ limit: 3, windowSeconds: 420 });
  });

  it("updates settings and refreshes cache", async () => {
    await service.updateRateLimitSettings("admin-1", {
      login: { limit: 6, windowSeconds: 100 },
      crawlCreate: { limit: 4, windowSeconds: 500 },
      rbacWrite: { limit: 2, windowSeconds: 300 }
    });
    expect(prismaMock.$transaction).toHaveBeenCalled();
    expect(prismaMock.systemSetting.upsert).toHaveBeenCalledTimes(3);
    const refreshed = await service.getBucketConfig("rbacWrite");
    expect(refreshed).toEqual({ limit: 2, windowSeconds: 300 });
  });
});
