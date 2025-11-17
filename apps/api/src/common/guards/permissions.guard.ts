import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { GqlExecutionContext } from "@nestjs/graphql";
import { PERMISSIONS_KEY } from "../decorators/permissions.decorator";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { ALLOW_AUTHENTICATED_KEY } from "../decorators/allow-authenticated.decorator";

type GqlContextType = "graphql" | "http" | "rpc" | "ws";

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
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

    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    if (!requiredPermissions || requiredPermissions.length === 0) {
      if (allowAuthenticated) {
        return true;
      }
      throw new ForbiddenException("Permission metadata missing");
    }

    const type = context.getType<GqlContextType>();
    const request =
      type === "graphql"
        ? GqlExecutionContext.create(context).getContext().req
        : context.switchToHttp().getRequest();
    const user = request.user as { permissions?: string[] } | undefined;
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
