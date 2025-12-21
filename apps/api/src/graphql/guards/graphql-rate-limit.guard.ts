import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { GqlExecutionContext } from "@nestjs/graphql";

import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";
import { RateLimiterService } from "../../modules/cache/rate-limiter.service";
import { RateLimitConfigService } from "../../modules/system-settings/rate-limit-config.service";

type GqlContextType = "graphql" | "http" | "rpc" | "ws";

@Injectable()
export class GraphqlRateLimitGuard implements CanActivate {
  constructor(
    private readonly rateLimiter: RateLimiterService,
    private readonly rateLimitConfig: RateLimitConfigService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const type = context.getType<GqlContextType>();

    if (type !== "graphql" && type !== "ws") {
      return true;
    }

    const ctx = GqlExecutionContext.create(context);
    const request = ctx.getContext().req ?? context.switchToHttp().getRequest();
    const ip =
      request?.ip ||
      request?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ||
      request?.connection?.remoteAddress ||
      "anonymous";

    const loginBucket = await this.rateLimitConfig.getBucketConfig("login");
    const limit = Math.max(loginBucket.limit * 12, 60);
    const windowSeconds = loginBucket.windowSeconds;

    const allowed = await this.rateLimiter.consume(`graphql:${ip}`, limit, windowSeconds);
    if (!allowed) {
      throw new TooManyRequestsException("Too many GraphQL requests. Slow down.");
    }

    return true;
  }
}
