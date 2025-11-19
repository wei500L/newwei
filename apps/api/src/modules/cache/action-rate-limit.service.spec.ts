import { ActionRateLimitService } from "./action-rate-limit.service";
import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";

const rateLimiterMock = {
  consume: jest.fn()
} as any;

const rateLimitConfigMock = {
  getBucketConfig: jest.fn()
} as any;

describe("ActionRateLimitService", () => {
  let service: ActionRateLimitService;

  beforeEach(() => {
    jest.resetAllMocks();
    rateLimiterMock.consume = jest.fn().mockResolvedValue(true);
    rateLimitConfigMock.getBucketConfig = jest
      .fn()
      .mockResolvedValue({ limit: 10, windowSeconds: 300 });
    service = new ActionRateLimitService(rateLimiterMock, rateLimitConfigMock);
  });

  it("enforces crawl task creation limits", async () => {
    await service.enforceCrawlTaskCreate("org-1", "user-1");
    expect(rateLimitConfigMock.getBucketConfig).toHaveBeenCalledWith("crawlCreate");
    expect(rateLimiterMock.consume).toHaveBeenCalledWith("crawl:create:org-1:user-1", 10, 300);
  });

  it("throws when RBAC writes exceed limits", async () => {
    rateLimitConfigMock.getBucketConfig = jest
      .fn()
      .mockResolvedValueOnce({ limit: 5, windowSeconds: 600 });
    rateLimiterMock.consume = jest.fn().mockResolvedValue(false);
    service = new ActionRateLimitService(rateLimiterMock, rateLimitConfigMock);
    await expect(service.enforceRbacWrite("org-1", "admin-2")).rejects.toThrow(
      TooManyRequestsException
    );
  });
});
