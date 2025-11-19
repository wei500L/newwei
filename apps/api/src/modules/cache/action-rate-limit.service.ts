import { Injectable } from "@nestjs/common";
import { EnvService } from "../config/config.service";
import { RateLimiterService } from "./rate-limiter.service";
import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";

@Injectable()
export class ActionRateLimitService {
  constructor(
    private readonly env: EnvService,
    private readonly rateLimiter: RateLimiterService
  ) {}

  async enforceCrawlTaskCreate(orgId: string, userId: string) {
    const { crawlTaskCreate, crawlTaskCreateWindowSeconds } = this.env.rateLimit;
    await this.consumeOrThrow({
      key: `crawl:create:${orgId}:${userId}`,
      limit: crawlTaskCreate,
      windowSeconds: crawlTaskCreateWindowSeconds,
      message: "Too many crawl tasks created. Please wait before creating new tasks."
    });
  }

  async enforceRbacWrite(orgId: string, actorId: string) {
    const { rbacWrite, rbacWriteWindowSeconds } = this.env.rateLimit;
    await this.consumeOrThrow({
      key: `rbac:write:${orgId}:${actorId}`,
      limit: rbacWrite,
      windowSeconds: rbacWriteWindowSeconds,
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
