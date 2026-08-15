import { ExecutionContext, HttpException, Injectable, UnauthorizedException } from "@nestjs/common";
import { GqlExecutionContext } from "@nestjs/graphql";
import { AuthGuard } from "@nestjs/passport";

import {
  createSyntheticGqlRequest,
  type GraphQLContext,
  type GqlRequest,
} from "../../graphql/graphql.types";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";

function isAuthenticatedUser(value: unknown): value is AuthenticatedUser {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<AuthenticatedUser>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.email === "string" &&
    typeof candidate.orgId === "string" &&
    Array.isArray(candidate.roleIds) &&
    Array.isArray(candidate.permissions)
  );
}

@Injectable()
export class GqlAuthGuard extends AuthGuard("jwt") {
  canActivate(context: ExecutionContext) {
    if (context.getType<"graphql" | "http" | "rpc" | "ws">() !== "graphql") {
      return true;
    }
    return super.canActivate(context);
  }

  getRequest(context: ExecutionContext): GqlRequest {
    const ctx = GqlExecutionContext.create(context);
    const gqlContext = ctx.getContext<GraphQLContext | undefined>();

    const request = gqlContext?.req ?? gqlContext?.request;
    if (request) {
      return request;
    }

    // Some transports/context builders may not provide an HTTP-like request object.
    // Passport's authenticate middleware requires a non-null `req` object.
    return createSyntheticGqlRequest(gqlContext?.connectionParams);
  }

  // Passport IAuthGuard.handleRequest is typed with `any`; keep that signature
  // and narrow `user` with isAuthenticatedUser before returning.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleRequest<TUser = AuthenticatedUser>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    err: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    user: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    info: any,
    _context: ExecutionContext,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _status?: any,
  ): TUser {
    void _context;
    void _status;
    if (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      const message = err instanceof Error ? err.message : "Unauthorized";
      throw new UnauthorizedException(message);
    }

    if (!isAuthenticatedUser(user)) {
      const message =
        info instanceof Error
          ? info.message
          : typeof info === "string"
            ? info
            : "Unauthorized";
      throw new UnauthorizedException(message);
    }

    return user as TUser;
  }
}
