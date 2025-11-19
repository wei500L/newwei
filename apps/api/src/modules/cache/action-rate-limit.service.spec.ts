import { ActionRateLimitService } from "./action-rate-limit.service";
import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";

const rateLimiterMock = {
  consume: jest.fn()
} as any;

const envMock = {
  rateLimit: {
    crawlTaskCreate: 10,
    crawlTaskCreateWindowSeconds: 300,
    rbacWrite: 5,
    rbacWriteWindowSeconds: 600
  }
} as any;

describe("ActionRateLimitService", () => {
  let service: ActionRateLimitService;

  beforeEach(() => {
    jest.resetAllMocks();
    rateLimiterMock.consume = jest.fn().mockResolvedValue(true);
    service = new ActionRateLimitService(envMock, rateLimiterMock);
  });

  it("enforces crawl task creation limits", async () => {
    await service.enforceCrawlTaskCreate("org-1", "user-1");
    expect(rateLimiterMock.consume).toHaveBeenCalledWith("crawl:create:org-1:user-1", 10, 300);
  });

  it("throws when RBAC writes exceed limits", async () => {
    rateLimiterMock.consume = jest.fn().mockResolvedValue(false);
    service = new ActionRateLimitService(envMock, rateLimiterMock);
    await expect(service.enforceRbacWrite("org-1", "admin-2")).rejects.toThrow(
      TooManyRequestsException
    );
  });
});
