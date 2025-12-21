import { ForbiddenException } from "@nestjs/common";

import { PermissionsGuard } from "./permissions.guard";

describe("PermissionsGuard", () => {
  it("skips authorization for GraphQL context", () => {
    const reflector = { getAllAndOverride: jest.fn() } as any;
    const guard = new PermissionsGuard(reflector);
    const ctx = { getType: () => "graphql" } as any;
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("fails closed when permission metadata is missing", () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) } as any;
    const guard = new PermissionsGuard(reflector);
    const ctx = {
      getType: () => "http",
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => ({ user: { permissions: [] } }) })
    } as any;

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});

