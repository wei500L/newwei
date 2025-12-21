import { UnauthorizedException } from "@nestjs/common";

import { JwtStrategy } from "./jwt.strategy";

describe("JwtStrategy", () => {
  const envMock = {
    jwtConfig: {
      secret: "test-secret",
      audience: "test-audience",
      issuer: "test-issuer"
    }
  } as any;

  const authServiceMock = {
    getUserProfile: jest.fn()
  } as any;

  const accessTokenBlacklistMock = {
    has: jest.fn()
  } as any;

  beforeEach(() => {
    jest.resetAllMocks();
    accessTokenBlacklistMock.has = jest.fn().mockResolvedValue(false);
    authServiceMock.getUserProfile = jest.fn().mockResolvedValue({
      id: "user-1",
      email: "user@example.com",
      firstName: "Test",
      lastName: "User",
      orgId: "org-1",
      roleIds: ["role-1"],
      permissions: ["read"]
    });
  });

  it("returns the profile with access token metadata", async () => {
    const strategy = new JwtStrategy(envMock, authServiceMock, accessTokenBlacklistMock);

    const result = await strategy.validate({
      sub: "user-1",
      orgId: "org-1",
      permissions: ["read"],
      jti: "token-1",
      exp: 100
    });

    expect(authServiceMock.getUserProfile).toHaveBeenCalledWith("user-1", "org-1");
    expect(result).toMatchObject({
      id: "user-1",
      orgId: "org-1",
      accessTokenId: "token-1",
      accessTokenExpiresAt: 100_000
    });
  });

  it("rejects revoked access tokens", async () => {
    accessTokenBlacklistMock.has = jest.fn().mockResolvedValue(true);
    const strategy = new JwtStrategy(envMock, authServiceMock, accessTokenBlacklistMock);

    await expect(
      strategy.validate({
        sub: "user-1",
        orgId: "org-1",
        permissions: ["read"],
        jti: "token-1"
      })
    ).rejects.toThrow(UnauthorizedException);
    expect(authServiceMock.getUserProfile).not.toHaveBeenCalled();
  });

  it("propagates auth service UnauthorizedException", async () => {
    authServiceMock.getUserProfile = jest
      .fn()
      .mockRejectedValue(new UnauthorizedException("User disabled"));
    const strategy = new JwtStrategy(envMock, authServiceMock, accessTokenBlacklistMock);

    await expect(
      strategy.validate({
        sub: "user-1",
        orgId: "org-1",
        permissions: []
      })
    ).rejects.toThrow("User disabled");
  });

  it("does not special-case Prisma error codes", async () => {
    const prismaError = { code: "P2025" };
    authServiceMock.getUserProfile = jest.fn().mockRejectedValue(prismaError);
    const strategy = new JwtStrategy(envMock, authServiceMock, accessTokenBlacklistMock);

    await expect(
      strategy.validate({
        sub: "user-1",
        orgId: "org-1",
        permissions: []
      })
    ).rejects.toBe(prismaError);
  });

  it("does not swallow unexpected errors", async () => {
    const error = new Error("DB down");
    authServiceMock.getUserProfile = jest.fn().mockRejectedValue(error);
    const strategy = new JwtStrategy(envMock, authServiceMock, accessTokenBlacklistMock);

    await expect(
      strategy.validate({
        sub: "user-1",
        orgId: "org-1",
        permissions: []
      })
    ).rejects.toBe(error);
  });
});
