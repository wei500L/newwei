import { ECONOMIC_DASHBOARD_REFRESH_PRESET } from "@modular/utils";
import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";

import { ActionRateLimitService } from "./action-rate-limit.service";

const rateLimiterMock = {
  consume: jest.fn()
} as any;

const rateLimitConfigMock = {
  getBucketConfig: jest.fn()
} as any;

const rateLimitPolicyMock = {
  getPolicy: jest.fn()
} as any;

describe("ActionRateLimitService", () => {
  let service: ActionRateLimitService;

  beforeEach(() => {
    jest.resetAllMocks();
    rateLimiterMock.consume = jest.fn().mockResolvedValue(true);
    rateLimitConfigMock.getBucketConfig = jest
      .fn()
      .mockResolvedValue({ limit: 10, windowSeconds: 300 });
    rateLimitPolicyMock.getPolicy = jest.fn().mockResolvedValue(null);
    service = new ActionRateLimitService(rateLimiterMock, rateLimitConfigMock, rateLimitPolicyMock);
  });

  it("enforces crawl task creation limits", async () => {
    await service.enforceCrawlTaskCreate("org-1", "user-1", "10.0.0.1");
    expect(rateLimitConfigMock.getBucketConfig).toHaveBeenCalledWith("crawlCreate");
    expect(rateLimiterMock.consume).toHaveBeenNthCalledWith(
      1,
      "crawl:create:org-1:user-1",
      10,
      300
    );
    expect(rateLimiterMock.consume).toHaveBeenNthCalledWith(
      2,
      "crawl:create:org-1:ip:10.0.0.1",
      10,
      300
    );
  });

  it("prefers policy config when available", async () => {
    rateLimitPolicyMock.getPolicy = jest.fn().mockResolvedValue({
      feature: "crawl_task",
      userLimit: 2,
      ipLimit: 3,
      windowSeconds: 120,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    service = new ActionRateLimitService(rateLimiterMock, rateLimitConfigMock, rateLimitPolicyMock);

    await service.enforceCrawlTaskCreate("org-1", "user-1", "10.0.0.1");

    expect(rateLimitPolicyMock.getPolicy).toHaveBeenCalledWith("crawl_task");
    expect(rateLimitConfigMock.getBucketConfig).not.toHaveBeenCalled();
    expect(rateLimiterMock.consume).toHaveBeenNthCalledWith(
      1,
      "crawl:create:org-1:user-1",
      2,
      120
    );
    expect(rateLimiterMock.consume).toHaveBeenNthCalledWith(
      2,
      "crawl:create:org-1:ip:10.0.0.1",
      3,
      120
    );
  });

  it("throws when RBAC writes exceed limits", async () => {
    rateLimitConfigMock.getBucketConfig = jest
      .fn()
      .mockResolvedValueOnce({ limit: 5, windowSeconds: 600 });
    rateLimiterMock.consume = jest.fn().mockResolvedValue(false);
    rateLimitPolicyMock.getPolicy = jest.fn().mockResolvedValue(null);
    service = new ActionRateLimitService(rateLimiterMock, rateLimitConfigMock, rateLimitPolicyMock);
    await expect(service.enforceRbacWrite("org-1", "admin-2")).rejects.toThrow(
      TooManyRequestsException
    );
  });

  describe("enforceAkshareUpgrade", () => {
    it("allows first upgrade request", async () => {
      rateLimiterMock.consume = jest.fn().mockResolvedValue(true);
      await service.enforceAkshareUpgrade("org-1");
      expect(rateLimiterMock.consume).toHaveBeenCalledWith(
        "akshare:upgrade:org-1",
        1,
        3600
      );
    });

    it("rejects second upgrade request within window", async () => {
      rateLimiterMock.consume = jest.fn().mockResolvedValue(false);
      await expect(service.enforceAkshareUpgrade("org-1")).rejects.toThrow(
        TooManyRequestsException
      );
      await expect(service.enforceAkshareUpgrade("org-1")).rejects.toThrow(
        "Akshare upgrade can only be triggered once per hour"
      );
    });

    it("tracks limits per organization independently", async () => {
      rateLimiterMock.consume = jest.fn().mockResolvedValue(true);
      await service.enforceAkshareUpgrade("org-1");
      await service.enforceAkshareUpgrade("org-2");
      expect(rateLimiterMock.consume).toHaveBeenNthCalledWith(
        1,
        "akshare:upgrade:org-1",
        1,
        3600
      );
      expect(rateLimiterMock.consume).toHaveBeenNthCalledWith(
        2,
        "akshare:upgrade:org-2",
        1,
        3600
      );
    });
  });

  describe("enforceEconomicDataRefreshPreset", () => {
    it("limits refresh attempts per org and preset", async () => {
      rateLimiterMock.consume = jest.fn().mockResolvedValue(true);

      await service.enforceEconomicDataRefreshPreset(
        "org-1",
        ECONOMIC_DASHBOARD_REFRESH_PRESET.livelihoodPrices
      );

      expect(rateLimiterMock.consume).toHaveBeenCalledWith(
        "economic-data:refresh:org-1:livelihoodPrices",
        1,
        60
      );
    });

    it("throws when the same preset is triggered too frequently", async () => {
      rateLimiterMock.consume = jest.fn().mockResolvedValue(false);

      await expect(
        service.enforceEconomicDataRefreshPreset(
          "org-1",
          ECONOMIC_DASHBOARD_REFRESH_PRESET.keyMonitor
        )
      ).rejects.toThrow(TooManyRequestsException);
    });
  });
});
