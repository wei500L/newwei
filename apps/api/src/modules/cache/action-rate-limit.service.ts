import { Injectable } from "@nestjs/common";

import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";
import { RateLimitConfigService } from "../system-settings/rate-limit-config.service";
import { RateLimitPolicyService } from "../system-settings/rate-limit-policy.service";

import { RateLimiterService } from "./rate-limiter.service";

const CRAWL_TASK_FEATURE = "crawl_task";

@Injectable()
export class ActionRateLimitService {
  constructor(
    private readonly rateLimiter: RateLimiterService,
    private readonly rateLimitConfig: RateLimitConfigService,
    private readonly rateLimitPolicies: RateLimitPolicyService
  ) {}

  async enforceCrawlTaskCreate(orgId: string, userId: string, ip?: string) {
    const { userLimit, ipLimit, windowSeconds } = await this.resolveCrawlTaskPolicy();
    await this.consumeOrThrow({
      key: `crawl:create:${orgId}:${userId}`,
      limit: userLimit,
      windowSeconds,
      message: "Too many crawl tasks created. Please wait before creating new tasks."
    });
    const normalizedIp = ip?.trim();
    if (normalizedIp) {
      await this.consumeOrThrow({
        key: `crawl:create:ip:${normalizedIp}`,
        limit: ipLimit,
        windowSeconds,
        message: "Too many crawl tasks created from this IP. Please wait before creating new tasks."
      });
    }
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

  private async resolveCrawlTaskPolicy(): Promise<{
    userLimit: number;
    ipLimit: number;
    windowSeconds: number;
  }> {
    const policy = await this.rateLimitPolicies.getPolicy(CRAWL_TASK_FEATURE);
    if (policy) {
      if (!policy.enabled) {
        return { userLimit: 0, ipLimit: 0, windowSeconds: policy.windowSeconds };
      }
      return {
        userLimit: policy.userLimit,
        ipLimit: policy.ipLimit,
        windowSeconds: policy.windowSeconds
      };
    }

    const fallback = await this.rateLimitConfig.getBucketConfig("crawlCreate");
    return {
      userLimit: fallback.limit,
      ipLimit: fallback.limit,
      windowSeconds: fallback.windowSeconds
    };
  }
}
