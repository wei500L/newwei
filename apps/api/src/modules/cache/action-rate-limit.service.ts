import type { EconomicDashboardRefreshPreset } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";

import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";
import { RateLimitConfigService } from "../system-settings/rate-limit-config.service";
import { RateLimitPolicyService } from "../system-settings/rate-limit-policy.service";

import { RateLimiterService } from "./rate-limiter.service";

const CRAWL_TASK_FEATURE = "crawl_task";
const PASSWORD_RESET_FEATURE = "auth.password_reset";
const PASSWORD_RESET_DEFAULT_EMAIL_LIMIT = 3;
const PASSWORD_RESET_DEFAULT_IP_LIMIT = 10;
const PASSWORD_RESET_DEFAULT_WINDOW_SECONDS = 900;
const PASSWORD_RESET_RATE_LIMIT_MESSAGE =
  "Too many password reset requests. Please wait before trying again.";

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
        key: `crawl:create:${orgId}:ip:${normalizedIp}`,
        limit: ipLimit,
        windowSeconds,
        message: "Too many crawl tasks created from this IP. Please wait before creating new tasks."
      });
    }
  }

  async enforcePasswordResetRequest(email: string, ip?: string) {
    const { userLimit, ipLimit, windowSeconds } =
      await this.resolvePasswordResetPolicy();
    const normalizedIp = ip?.trim();
    if (normalizedIp) {
      await this.consumeOrThrow({
        key: `auth:password-reset:ip:${normalizedIp}`,
        limit: ipLimit,
        windowSeconds,
        message: PASSWORD_RESET_RATE_LIMIT_MESSAGE
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    await this.consumeOrThrow({
      key: `auth:password-reset:email:${this.hashIdentifier(normalizedEmail)}`,
      limit: userLimit,
      windowSeconds,
      message: PASSWORD_RESET_RATE_LIMIT_MESSAGE
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

  async enforceAkshareUpgrade(orgId: string) {
    await this.consumeOrThrow({
      key: `akshare:upgrade:${orgId}`,
      limit: 1,
      windowSeconds: 3600,
      message: "Akshare upgrade can only be triggered once per hour. Please wait before trying again."
    });
  }

  async enforceEconomicDataRefreshPreset(orgId: string, preset: EconomicDashboardRefreshPreset) {
    await this.consumeOrThrow({
      key: `economic-data:refresh:${orgId}:${preset}`,
      limit: 1,
      windowSeconds: 60,
      message: "This economic data preset was refreshed recently. Please wait before triggering it again."
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

  private async resolvePasswordResetPolicy(): Promise<{
    userLimit: number;
    ipLimit: number;
    windowSeconds: number;
  }> {
    const policy = await this.rateLimitPolicies.getPolicy(PASSWORD_RESET_FEATURE);
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

    return {
      userLimit: PASSWORD_RESET_DEFAULT_EMAIL_LIMIT,
      ipLimit: PASSWORD_RESET_DEFAULT_IP_LIMIT,
      windowSeconds: PASSWORD_RESET_DEFAULT_WINDOW_SECONDS
    };
  }

  private hashIdentifier(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }
}
