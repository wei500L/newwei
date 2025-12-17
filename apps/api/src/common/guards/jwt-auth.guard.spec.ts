import { JwtAuthGuard } from "./jwt-auth.guard";

describe("JwtAuthGuard", () => {
  it("skips authentication for GraphQL context", () => {
    const reflector = { getAllAndOverride: jest.fn() } as any;
    const guard = new JwtAuthGuard(reflector);
    const ctx = { getType: () => "graphql" } as any;
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("skips authentication for public handlers", () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) } as any;
    const guard = new JwtAuthGuard(reflector);
    const ctx = {
      getType: () => "http",
      getHandler: () => ({}),
      getClass: () => ({})
    } as any;
    expect(guard.canActivate(ctx)).toBe(true);
  });
});

