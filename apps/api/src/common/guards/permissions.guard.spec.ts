import type { ExecutionContext } from "@nestjs/common";
import { ForbiddenException } from "@nestjs/common";

import { ALLOW_AUTHENTICATED_KEY } from "../decorators/allow-authenticated.decorator";
import { PERMISSIONS_KEY, PermissionsMode } from "../decorators/permissions.decorator";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { PermissionsGuard } from "./permissions.guard";

function createHttpContext(user?: unknown): ExecutionContext {
  return {
    getType: () => "http",
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ user })
    })
  } as unknown as ExecutionContext;
}

describe("PermissionsGuard", () => {
  it("treats multiple permissions as OR by default (legacy array metadata)", () => {
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => {
        if (key === IS_PUBLIC_KEY) return false;
        if (key === ALLOW_AUTHENTICATED_KEY) return false;
        if (key === PERMISSIONS_KEY) return ["admin", "editor"];
        return undefined;
      })
    } as any;

    const guard = new PermissionsGuard(reflector);
    expect(guard.canActivate(createHttpContext({ permissions: ["editor"] }))).toBe(true);
  });

  it("enforces AND when PermissionsMode.All is used", () => {
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => {
        if (key === IS_PUBLIC_KEY) return false;
        if (key === ALLOW_AUTHENTICATED_KEY) return false;
        if (key === PERMISSIONS_KEY)
          return { permissions: ["admin", "editor"], mode: PermissionsMode.All };
        return undefined;
      })
    } as any;

    const guard = new PermissionsGuard(reflector);
    expect(() => guard.canActivate(createHttpContext({ permissions: ["editor"] }))).toThrow(
      ForbiddenException
    );
  });

  it("allows when allowAuthenticated is set and permission metadata is missing", () => {
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => {
        if (key === IS_PUBLIC_KEY) return false;
        if (key === ALLOW_AUTHENTICATED_KEY) return true;
        if (key === PERMISSIONS_KEY) return undefined;
        return undefined;
      })
    } as any;

    const guard = new PermissionsGuard(reflector);
    expect(guard.canActivate(createHttpContext())).toBe(true);
  });
});

