import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { GqlExecutionContext } from "@nestjs/graphql";
import { PERMISSIONS_KEY, PermissionsMode, normalizePermissionsRequirement } from "../decorators/permissions.decorator";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { ALLOW_AUTHENTICATED_KEY } from "../decorators/allow-authenticated.decorator";

type GqlContextType = "graphql" | "http" | "rpc" | "ws";

@Injectable()
export class GqlPermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
    if (context.getType<GqlContextType>() !== "graphql") {
      return true;
    }

    const ctx = GqlExecutionContext.create(context);
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    if (isPublic) {
      return true;
    }

    const allowAuthenticated = this.reflector.getAllAndOverride<boolean>(ALLOW_AUTHENTICATED_KEY, [
      context.getHandler(),
      context.getClass()
    ]);

    const requiredPermissionsMetadata = this.reflector.getAllAndOverride<unknown>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    const requirement = normalizePermissionsRequirement(requiredPermissionsMetadata);

    if (!requirement || requirement.permissions.length === 0) {
      if (allowAuthenticated) {
        return true;
      }
      throw new ForbiddenException("Permission metadata missing");
    }

    const request = ctx.getContext().req;
    const user = request?.user as { permissions?: string[] } | undefined;

    if (!user) {
      throw new ForbiddenException("Missing user context");
    }

    const userPermissions = new Set(user.permissions ?? []);
    const hasPermission =
      requirement.mode === PermissionsMode.All
        ? requirement.permissions.every((permission) => userPermissions.has(permission))
        : requirement.permissions.some((permission) => userPermissions.has(permission));

    if (!hasPermission) {
      throw new ForbiddenException("Insufficient permissions");
    }

    return true;
  }
}
