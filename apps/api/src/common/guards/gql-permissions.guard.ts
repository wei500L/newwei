import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { GqlExecutionContext } from "@nestjs/graphql";
import { PERMISSIONS_KEY } from "../decorators/permissions.decorator";

type GqlContextType = "graphql" | "http" | "rpc" | "ws";

@Injectable()
export class GqlPermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
    if (context.getType<GqlContextType>() !== "graphql") {
      return true;
    }

    const ctx = GqlExecutionContext.create(context);
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass()
    ]);

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = ctx.getContext().req;
    const user = request?.user as { permissions?: string[] } | undefined;

    if (!user) {
      throw new ForbiddenException("Missing user context");
    }

    const hasPermission = requiredPermissions.every((permission) =>
      user.permissions?.includes(permission)
    );

    if (!hasPermission) {
      throw new ForbiddenException("Insufficient permissions");
    }

    return true;
  }
}
