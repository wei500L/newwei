import { ExecutionContext, HttpException, Injectable, UnauthorizedException } from "@nestjs/common";
import { GqlExecutionContext } from "@nestjs/graphql";
import { AuthGuard } from "@nestjs/passport";

@Injectable()
export class GqlAuthGuard extends AuthGuard("jwt") {
  canActivate(context: ExecutionContext) {
    if (context.getType<"graphql" | "http" | "rpc" | "ws">() !== "graphql") {
      return true;
    }
    return super.canActivate(context);
  }

  getRequest(context: ExecutionContext) {
    const ctx = GqlExecutionContext.create(context);
    const gqlContext = ctx.getContext() as
      | { req?: unknown; request?: unknown; connectionParams?: unknown; extra?: unknown }
      | undefined;

    const request = gqlContext?.req ?? gqlContext?.request;
    if (request) {
      return request;
    }

    // Some transports/context builders may not provide an HTTP-like request object.
    // Passport's authenticate middleware requires a non-null `req` object.
    return {
      headers:
        (gqlContext?.connectionParams as Record<string, unknown> | undefined) ?? {},
      ip: undefined
    };
  }

  handleRequest(err: unknown, user: unknown, info: unknown) {
    if (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      const message = err instanceof Error ? err.message : "Unauthorized";
      throw new UnauthorizedException(message);
    }

    if (!user) {
      const message =
        info instanceof Error
          ? info.message
          : typeof info === "string"
            ? info
            : "Unauthorized";
      throw new UnauthorizedException(message);
    }

    return user;
  }
}
