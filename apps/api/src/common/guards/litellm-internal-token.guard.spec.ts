import { ForbiddenException, UnauthorizedException } from "@nestjs/common";

import { LitellmInternalTokenGuard } from "./litellm-internal-token.guard";

function makeContext(authorization: string | undefined) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: { authorization },
        path: "/api/internal/litellm/openai-keys",
      }),
    }),
  } as any;
}

describe("LitellmInternalTokenGuard", () => {
  const env = { liteLlmConfigInternalToken: "super-secret-internal-token" } as any;

  it("rejects when the internal token is not configured", () => {
    const guard = new LitellmInternalTokenGuard({
      liteLlmConfigInternalToken: undefined,
    } as any);

    expect(() => guard.canActivate(makeContext("Bearer anything"))).toThrow(
      ForbiddenException,
    );
  });

  it("rejects a missing bearer token", () => {
    const guard = new LitellmInternalTokenGuard(env);

    expect(() => guard.canActivate(makeContext(undefined))).toThrow(
      UnauthorizedException,
    );
    expect(() => guard.canActivate(makeContext(""))).toThrow(
      UnauthorizedException,
    );
  });

  it("rejects an invalid bearer token", () => {
    const guard = new LitellmInternalTokenGuard(env);

    expect(() =>
      guard.canActivate(makeContext("Bearer wrong-token")),
    ).toThrow(UnauthorizedException);
  });

  it("accepts a valid bearer token", () => {
    const guard = new LitellmInternalTokenGuard(env);

    expect(
      guard.canActivate(makeContext("Bearer super-secret-internal-token")),
    ).toBe(true);
  });

  it("accepts a token with surrounding whitespace", () => {
    const guard = new LitellmInternalTokenGuard(env);

    expect(
      guard.canActivate(makeContext("  Bearer   super-secret-internal-token  ")),
    ).toBe(true);
  });
});
