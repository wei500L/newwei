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
      "crawl:create:ip:10.0.0.1",
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
      "crawl:create:ip:10.0.0.1",
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
});
