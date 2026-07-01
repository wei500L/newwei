import { ExecutionContext, Injectable, Optional } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import type { Request } from "express";

import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { MachineTokenService } from "../../modules/auth/machine-token.service";

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor(
    private readonly reflector: Reflector,
    @Optional() private readonly machineTokens?: MachineTokenService,
  ) {
    super();
  }

  canActivate(context: ExecutionContext) {
    if (context.getType<"graphql" | "http" | "rpc" | "ws">() === "graphql") {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    if (isPublic) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request & { user?: unknown }>();
    const authorization = request.headers.authorization;
    const token =
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length).trim()
        : undefined;
    if (this.machineTokens?.isMachineToken(token)) {
      return this.machineTokens.validate(token!).then((user) => {
        request.user = user;
        return true;
      });
    }
    return super.canActivate(context);
  }
}
