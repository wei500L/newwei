import { CanActivate, ExecutionContext, Injectable, TooManyRequestsException } from "@nestjs/common";
import { GqlExecutionContext } from "@nestjs/graphql";
import { RateLimiterService } from "../../modules/cache/rate-limiter.service";
import { EnvService } from "../../modules/config/config.service";

type GqlContextType = "graphql" | "http" | "rpc" | "ws";

@Injectable()
export class GraphqlRateLimitGuard implements CanActivate {
  constructor(private readonly rateLimiter: RateLimiterService, private readonly env: EnvService) {}

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

    const limit = Math.max((this.env.rateLimit.login ?? 5) * 12, 60);
    const windowSeconds = this.env.rateLimit.loginWindowSeconds ?? 60;

    const allowed = await this.rateLimiter.consume(`graphql:${ip}`, limit, windowSeconds);
    if (!allowed) {
      throw new TooManyRequestsException("Too many GraphQL requests. Slow down.");
    }

    return true;
  }
}
