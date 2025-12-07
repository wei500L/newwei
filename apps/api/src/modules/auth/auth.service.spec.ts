import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";
import bcrypt from "bcrypt";
import { AuthService } from "./auth.service";

const prismaMock = {
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
    findUniqueOrThrow: jest.fn()
  },
  membership: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    upsert: jest.fn()
  },
  refreshToken: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn()
  },
  auditLog: {
    create: jest.fn()
  }
} as unknown as any;

const envMock = {
  jwtConfig: {
    secret: "test-secret",
    issuer: "test",
    audience: "test",
    accessExpiresIn: "15m",
    refreshExpiresIn: "7d"
  },
  rateLimit: {
    login: 5,
    loginWindowSeconds: 60
  }
} as any;

const rateLimiterMock = {
  consume: jest.fn().mockResolvedValue(true)
} as any;

const rateLimitConfigMock = {
  getBucketConfig: jest.fn().mockResolvedValue({ limit: 5, windowSeconds: 60 })
} as any;

const cacheMock = {
  get: jest.fn(),
  set: jest.fn()
} as any;

const accessTokenBlacklistMock = {
  add: jest.fn(),
  has: jest.fn()
} as any;

const authCacheSettingsMock = {
  getSettings: jest.fn().mockResolvedValue({
    profileTtlSeconds: 600,
    lockTtlMs: 5_000,
    maxWaitMs: 5_000,
    retryDelayMs: 50
  })
} as any;

describe("AuthService", () => {
  let service: AuthService;

  beforeEach(() => {
    jest.resetAllMocks();
    rateLimiterMock.consume = jest.fn().mockResolvedValue(true);
    rateLimitConfigMock.getBucketConfig = jest
      .fn()
      .mockResolvedValue({ limit: 5, windowSeconds: 60 });
    authCacheSettingsMock.getSettings = jest.fn().mockResolvedValue({
      profileTtlSeconds: 600,
      lockTtlMs: 5_000,
      maxWaitMs: 5_000,
      retryDelayMs: 50
    });
    service = new AuthService(
      prismaMock,
      envMock,
      rateLimiterMock,
      rateLimitConfigMock,
      cacheMock,
      accessTokenBlacklistMock,
      authCacheSettingsMock
    );
  });

  it("parses timespans", () => {
    expect((service as any).parseTimespan("1s")).toBe(1000);
    expect((service as any).parseTimespan("2m")).toBe(120000);
    expect((service as any).parseTimespan("3h")).toBe(10800000);
    expect((service as any).parseTimespan("1d")).toBe(86400000);
    expect(() => (service as any).parseTimespan("5x")).toThrow(BadRequestException);
  });

  it("validates user credentials", async () => {
    const password = await bcrypt.hash("password", 10);
    prismaMock.user.findUnique = jest.fn().mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      passwordHash: password,
      firstName: "Test",
      lastName: "User",
      isActive: true,
      memberships: [
        {
          orgId: "org-1",
          roleId: "role-1",
          role: {
            permissions: [
              {
                permission: { name: "items.read" }
              }
            ]
          }
        }
      ]
    });

    const user = await service.validateUser("test@example.com", "password");
    expect(user.permissions).toContain("items.read");
    expect(user.orgId).toBe("org-1");
    expect(user.roleIds).toEqual(["role-1"]);
  });

  it("selects the requested organization when validating credentials", async () => {
    const password = await bcrypt.hash("password", 10);
    prismaMock.user.findUnique = jest.fn().mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      passwordHash: password,
      firstName: "Test",
      lastName: "User",
      isActive: true,
      memberships: [
        {
          orgId: "org-1",
          roleId: "role-1",
          role: {
            permissions: [
              {
                permission: { name: "items.read" }
              }
            ]
          }
        },
        {
          orgId: "org-2",
          roleId: "role-2",
          role: {
            permissions: [
              {
                permission: { name: "items.write" }
              }
            ]
          }
        }
      ]
    });

    const user = await service.validateUser("test@example.com", "password", "org-2");
    expect(user.orgId).toBe("org-2");
    expect(user.permissions).toContain("items.write");
    expect(user.roleIds).toEqual(["role-2"]);
  });

  it("throws on excessive login attempts", async () => {
    rateLimiterMock.consume = jest.fn().mockResolvedValue(false);
    await expect(
      service.login("user@example.com", "pw", undefined, "127.0.0.1")
    ).rejects.toThrow(
      TooManyRequestsException
    );
  });

  it("uses configured login rate limit values", async () => {
    rateLimitConfigMock.getBucketConfig = jest
      .fn()
      .mockResolvedValue({ limit: 2, windowSeconds: 120 });
    await (service as any).validateRateLimit("login:test");
    expect(rateLimiterMock.consume).toHaveBeenCalledWith("login:test", 2, 120);
  });

  it("defaults refresh to the org encoded in the token when none is provided", async () => {
    const secret = "a".repeat(64);
    prismaMock.refreshToken.findUnique = jest.fn().mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      tokenHash: await bcrypt.hash(secret, 10),
      expiresAt: new Date(Date.now() + 10000),
      revokedAt: null
    });
    prismaMock.user.findUnique = jest.fn().mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      firstName: "Test",
      lastName: "User"
    });
    prismaMock.membership.findMany = jest.fn().mockResolvedValue([
      {
        orgId: "org-1",
        roleId: "role-1",
        role: {
          permissions: [{ permission: { name: "items.read" } }]
        }
      },
      {
        orgId: "org-2",
        roleId: "role-2",
        role: {
          permissions: [{ permission: { name: "items.write" } }]
        }
      }
    ]);

    const result = await service.refresh(`token-1.org-2.${secret}`);
    expect(result.user.orgId).toBe("org-2");
    expect(result.user.roleIds).toEqual(["role-2"]);
  });

  it("allows switching organizations on refresh when requested", async () => {
    const secret = "a".repeat(64);
    prismaMock.refreshToken.findUnique = jest.fn().mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      tokenHash: await bcrypt.hash(secret, 10),
      expiresAt: new Date(Date.now() + 10000),
      revokedAt: null
    });
    prismaMock.user.findUnique = jest.fn().mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      firstName: "Test",
      lastName: "User"
    });
    prismaMock.membership.findMany = jest.fn().mockResolvedValue([
      {
        orgId: "org-1",
        roleId: "role-1",
        role: {
          permissions: [{ permission: { name: "items.read" } }]
        }
      },
      {
        orgId: "org-2",
        roleId: "role-2",
        role: {
          permissions: [{ permission: { name: "items.write" } }]
        }
      }
    ]);

    const result = await service.refresh(`token-1.org-1.${secret}`, "org-2");
    expect(result.user.orgId).toBe("org-2");
    expect(result.user.permissions).toContain("items.write");
  });

  it("rejects refresh tokens that do not match the expected structure", async () => {
    await expect(service.refresh("token-without-secret")).rejects.toThrow(
      UnauthorizedException
    );
    await expect(service.refresh("token.org.too.short")).rejects.toThrow(UnauthorizedException);
  });

  it("rejects missing membership", async () => {
    prismaMock.user.findUnique = jest.fn().mockResolvedValue({
      id: "user-1",
      email: "no-org@example.com",
      passwordHash: await bcrypt.hash("password", 10),
      firstName: "No",
      lastName: "Org",
      isActive: true,
      memberships: []
    });

    await expect(service.validateUser("no-org@example.com", "password")).rejects.toThrow(
      UnauthorizedException
    );
  });
});
