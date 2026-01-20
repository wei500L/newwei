jest.mock("@nestjs/graphql", () => {
  const actual = jest.requireActual("@nestjs/graphql");
  return {
    ...actual,
    GqlExecutionContext: {
      create: jest.fn()
    }
  };
});

import { ForbiddenException } from "@nestjs/common";
import { GqlExecutionContext } from "@nestjs/graphql";

import { ALLOW_AUTHENTICATED_KEY } from "../decorators/allow-authenticated.decorator";
import { PERMISSIONS_KEY, PermissionsMode } from "../decorators/permissions.decorator";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";

import { GqlPermissionsGuard } from "./gql-permissions.guard";

const makeContext = () =>
  ({
    getType: () => "graphql",
    getHandler: () => ({}),
    getClass: () => ({})
  }) as any;

describe("GqlPermissionsGuard", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("allows a GraphQL request when any required permission matches", () => {
    (GqlExecutionContext.create as unknown as jest.Mock).mockReturnValue({
      getContext: () => ({ req: { user: { permissions: ["knowledgegraph.review"] } } })
    });

    const reflector = {
      getAllAndOverride: jest.fn((key: string) => {
        if (key === IS_PUBLIC_KEY) return false;
        if (key === ALLOW_AUTHENTICATED_KEY) return false;
        if (key === PERMISSIONS_KEY) {
          return {
            permissions: ["settings.manage", "knowledgegraph.review"],
            mode: PermissionsMode.Any
          };
        }
        return undefined;
      })
    } as any;

    const guard = new GqlPermissionsGuard(reflector);
    expect(guard.canActivate(makeContext())).toBe(true);
  });

  it("rejects a GraphQL request when none of the permissions match", () => {
    (GqlExecutionContext.create as unknown as jest.Mock).mockReturnValue({
      getContext: () => ({ req: { user: { permissions: ["items.read"] } } })
    });

    const reflector = {
      getAllAndOverride: jest.fn((key: string) => {
        if (key === IS_PUBLIC_KEY) return false;
        if (key === ALLOW_AUTHENTICATED_KEY) return false;
        if (key === PERMISSIONS_KEY) {
          return {
            permissions: ["settings.manage", "knowledgegraph.review"],
            mode: PermissionsMode.Any
          };
        }
        return undefined;
      })
    } as any;

    const guard = new GqlPermissionsGuard(reflector);
    expect(() => guard.canActivate(makeContext())).toThrow(ForbiddenException);
  });

  it("fails closed when permission metadata is missing", () => {
    (GqlExecutionContext.create as unknown as jest.Mock).mockReturnValue({
      getContext: () => ({ req: { user: { permissions: [] } } })
    });

    const reflector = {
      getAllAndOverride: jest.fn((key: string) => {
        if (key === IS_PUBLIC_KEY) return false;
        if (key === ALLOW_AUTHENTICATED_KEY) return false;
        if (key === PERMISSIONS_KEY) return undefined;
        return undefined;
      })
    } as any;

    const guard = new GqlPermissionsGuard(reflector);
    expect(() => guard.canActivate(makeContext())).toThrow(ForbiddenException);
  });

  it("allows authenticated requests when allowAuthenticated is enabled", () => {
    (GqlExecutionContext.create as unknown as jest.Mock).mockReturnValue({
      getContext: () => ({ req: { user: { permissions: [] } } })
    });

    const reflector = {
      getAllAndOverride: jest.fn((key: string) => {
        if (key === IS_PUBLIC_KEY) return false;
        if (key === ALLOW_AUTHENTICATED_KEY) return true;
        if (key === PERMISSIONS_KEY) return undefined;
        return undefined;
      })
    } as any;

    const guard = new GqlPermissionsGuard(reflector);
    expect(guard.canActivate(makeContext())).toBe(true);
  });
});
