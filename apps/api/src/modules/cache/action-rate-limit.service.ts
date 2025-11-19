import { Injectable } from "@nestjs/common";
import { RateLimiterService } from "./rate-limiter.service";
import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";
import { RateLimitConfigService } from "../system-settings/rate-limit-config.service";

@Injectable()
export class ActionRateLimitService {
  constructor(
    private readonly rateLimiter: RateLimiterService,
    private readonly rateLimitConfig: RateLimitConfigService
  ) {}

  async enforceCrawlTaskCreate(orgId: string, userId: string) {
    const { limit, windowSeconds } = await this.rateLimitConfig.getBucketConfig("crawlCreate");
    await this.consumeOrThrow({
      key: `crawl:create:${orgId}:${userId}`,
      limit,
      windowSeconds,
      message: "Too many crawl tasks created. Please wait before creating new tasks."
    });
  }

  async enforceRbacWrite(orgId: string, actorId: string) {
    const { limit, windowSeconds } = await this.rateLimitConfig.getBucketConfig("rbacWrite");
    await this.consumeOrThrow({
      key: `rbac:write:${orgId}:${actorId}`,
      limit,
      windowSeconds,
      message: "Too many RBAC changes were attempted. Please try again later."
    });
  }

  private async consumeOrThrow(options: {
    key: string;
    limit: number;
    windowSeconds: number;
    message: string;
  }) {
    if (!options.limit || options.limit <= 0) {
      return;
    }
    const allowed = await this.rateLimiter.consume(options.key, options.limit, options.windowSeconds);
    if (!allowed) {
      throw new TooManyRequestsException(options.message);
    }
  }
}
