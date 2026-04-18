import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import bcrypt from "bcrypt";
import crypto from "node:crypto";

import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";

import { AuthService } from "./auth.service";

const prismaMock = {
  user: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    findUniqueOrThrow: jest.fn(),
  },
  membership: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    upsert: jest.fn(),
  },
  refreshToken: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  globalRoleAssignment: {
    findMany: jest.fn(),
  },
  auditLog: {
    create: jest.fn(),
  },
} as unknown as any;

const envMock = {
  jwtConfig: {
    secret: "test-secret",
    issuer: "test",
    audience: "test",
    accessExpiresIn: "15m",
    refreshExpiresIn: "7d",
  },
  authRefreshGraceSeconds: 10,
  rateLimit: {
    login: 5,
    loginWindowSeconds: 60,
  },
} as any;

const rateLimiterMock = {
  consume: jest.fn().mockResolvedValue(true),
} as any;

const rateLimitConfigMock = {
  getBucketConfig: jest.fn().mockResolvedValue({ limit: 5, windowSeconds: 60 }),
} as any;

const cacheMock = {
  get: jest.fn(),
  set: jest.fn(),
  setIfAbsent: jest.fn(),
  del: jest.fn(),
  incr: jest.fn(),
  wrap: jest.fn(),
} as any;

const accessTokenBlacklistMock = {
  add: jest.fn(),
  has: jest.fn(),
} as any;

const refreshTokenBlacklistMock = {
  add: jest.fn(),
  has: jest.fn(),
} as any;

const authCacheSettingsMock = {
  getSettings: jest.fn().mockResolvedValue({
    profileTtlSeconds: 600,
    lockTtlMs: 5_000,
    maxWaitMs: 5_000,
    retryDelayMs: 50,
  }),
} as any;

const authEmailCodeSettingsMock = {
  getSettings: jest.fn().mockResolvedValue({
    ttlSeconds: 300,
    cooldownSeconds: 90,
    maxAttempts: 3,
  }),
} as any;

const orgServiceMock = {
  listOrganizationOptionsForUser: jest
    .fn()
    .mockResolvedValue([{ id: "org-1" }]),
} as any;

const storageServiceMock = {
  isPublicUrl: jest.fn(),
} as any;

const emailServiceMock = {
  send: jest.fn(),
  buildVerificationCodeTemplate: jest.fn().mockReturnValue("<p>code</p>"),
  buildVerificationCodeTextTemplate: jest.fn().mockReturnValue("code"),
} as any;

const platformAccessMock = {
  getGlobalRoles: jest.fn().mockResolvedValue([]),
} as any;

const mfaServiceMock = {
  getStatus: jest.fn().mockResolvedValue({
    enabled: false,
    recoveryCodesRemaining: 0,
  }),
  shouldRequireMfa: jest.fn().mockResolvedValue(false),
  createLoginChallenge: jest.fn(),
  consumeLoginChallenge: jest.fn(),
} as any;

describe("AuthService", () => {
  let service: AuthService;

  beforeEach(() => {
    jest.resetAllMocks();
    const wrapStore = new Map<string, unknown>();
    cacheMock.wrap = jest.fn(
      async (
        _key: string,
        _ttlSeconds: number,
        loader: () => Promise<unknown>,
      ) => {
        if (wrapStore.has(_key)) {
          return wrapStore.get(_key);
        }
        const value = await loader();
        wrapStore.set(_key, value);
        return value;
      },
    );
    rateLimiterMock.consume = jest.fn().mockResolvedValue(true);
    rateLimitConfigMock.getBucketConfig = jest
      .fn()
      .mockResolvedValue({ limit: 5, windowSeconds: 60 });
    refreshTokenBlacklistMock.has = jest.fn().mockResolvedValue(false);
    authCacheSettingsMock.getSettings = jest.fn().mockResolvedValue({
      profileTtlSeconds: 600,
      lockTtlMs: 5_000,
      maxWaitMs: 5_000,
      retryDelayMs: 50,
    });
    authEmailCodeSettingsMock.getSettings = jest.fn().mockResolvedValue({
      ttlSeconds: 300,
      cooldownSeconds: 90,
      maxAttempts: 3,
    });
    cacheMock.setIfAbsent = jest.fn().mockResolvedValue(true);
    cacheMock.incr = jest.fn().mockResolvedValue(1);
    platformAccessMock.getGlobalRoles = jest.fn().mockResolvedValue([]);
    mfaServiceMock.getStatus = jest.fn().mockResolvedValue({
      enabled: false,
      recoveryCodesRemaining: 0,
    });
    mfaServiceMock.shouldRequireMfa = jest.fn().mockResolvedValue(false);
    service = new AuthService(
      prismaMock,
      envMock,
      rateLimiterMock,
      rateLimitConfigMock,
      cacheMock,
      accessTokenBlacklistMock,
      refreshTokenBlacklistMock,
      authCacheSettingsMock,
      authEmailCodeSettingsMock,
      orgServiceMock,
      storageServiceMock,
      emailServiceMock,
      platformAccessMock,
      mfaServiceMock,
    );
  });

  it("parses timespans", () => {
    expect((service as any).parseTimespan("1s")).toBe(1000);
    expect((service as any).parseTimespan("2m")).toBe(120000);
    expect((service as any).parseTimespan("3h")).toBe(10800000);
    expect((service as any).parseTimespan("1d")).toBe(86400000);
    expect(() => (service as any).parseTimespan("5x")).toThrow(
      BadRequestException,
    );
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
          org: { isActive: true },
          roleId: "role-1",
          role: {
            permissions: [
              {
                permission: { name: "items.read" },
              },
            ],
          },
          roles: [],
        },
      ],
    });

    const user = await service.validateUser("test@example.com", "password");
    expect(user.permissions).toContain("items.read");
    expect(user.orgId).toBe("org-1");
    expect(user.roleIds).toEqual(["role-1"]);
  });

  it("unions permissions across multiple roles in the same org", async () => {
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
          org: { isActive: true },
          roleId: "role-primary",
          role: { permissions: [] },
          roles: [
            {
              roleId: "role-editor",
              role: {
                permissions: [{ permission: { name: "items.read" } }],
              },
            },
            {
              roleId: "role-billing",
              role: {
                permissions: [{ permission: { name: "billing.manage" } }],
              },
            },
          ],
        },
      ],
    });

    const user = await service.validateUser(
      "test@example.com",
      "password",
      "org-1",
    );
    expect(user.roleIds).toEqual(["role-editor", "role-billing"]);
    expect(user.permissions).toEqual(
      expect.arrayContaining(["items.read", "billing.manage"]),
    );
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
          org: { isActive: true },
          roleId: "role-1",
          role: {
            permissions: [
              {
                permission: { name: "items.read" },
              },
            ],
          },
        },
        {
          orgId: "org-2",
          org: { isActive: true },
          roleId: "role-2",
          role: {
            permissions: [
              {
                permission: { name: "items.write" },
              },
            ],
          },
        },
      ],
    });

    const user = await service.validateUser(
      "test@example.com",
      "password",
      "org-2",
    );
    expect(user.orgId).toBe("org-2");
    expect(user.permissions).toContain("items.write");
    expect(user.roleIds).toEqual(["role-2"]);
  });

  it("accepts organization slug case-insensitively when validating credentials", async () => {
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
          org: { isActive: true, slug: "acme" },
          roleId: "role-1",
          role: {
            permissions: [{ permission: { name: "items.read" } }],
          },
        },
      ],
    });

    const user = await service.validateUser(
      "test@example.com",
      "password",
      "ACME",
    );
    expect(user.orgId).toBe("org-1");
    expect(user.permissions).toContain("items.read");
  });

  it("defaults to the earliest active organization for multi-org login", async () => {
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
          org: { isActive: true },
          roleId: "role-1",
          role: {
            permissions: [{ permission: { name: "items.read" } }],
          },
        },
        {
          orgId: "org-2",
          org: { isActive: true },
          roleId: "role-2",
          role: {
            permissions: [{ permission: { name: "items.write" } }],
          },
        },
      ],
    });

    const user = await service.validateUser("test@example.com", "password");
    expect(user.orgId).toBe("org-1");
    expect(user.permissions).toContain("items.read");
    expect(user.roleIds).toEqual(["role-1"]);
  });

  it("defaults to the only active organization when others are disabled", async () => {
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
          org: { isActive: false },
          roleId: "role-1",
          role: {
            permissions: [{ permission: { name: "items.read" } }],
          },
        },
        {
          orgId: "org-2",
          org: { isActive: true },
          roleId: "role-2",
          role: {
            permissions: [{ permission: { name: "items.write" } }],
          },
        },
      ],
    });

    const user = await service.validateUser("test@example.com", "password");
    expect(user.orgId).toBe("org-2");
    expect(user.permissions).toContain("items.write");
    expect(user.roleIds).toEqual(["role-2"]);
  });

  it("rejects password login when the target membership is disabled", async () => {
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
          isActive: false,
          org: { isActive: true },
          roleId: "role-1",
          role: {
            permissions: [{ permission: { name: "items.read" } }],
          },
        },
      ],
    });

    await expect(
      service.validateUser("test@example.com", "password", "org-1"),
    ).rejects.toThrow("Organization access disabled");
  });

  it("throws on excessive login attempts", async () => {
    rateLimiterMock.consume = jest.fn().mockResolvedValue(false);
    await expect(
      service.login("user@example.com", "pw", undefined, "127.0.0.1"),
    ).rejects.toThrow(TooManyRequestsException);
  });

  it("uses configured login rate limit values", async () => {
    rateLimitConfigMock.getBucketConfig = jest
      .fn()
      .mockResolvedValue({ limit: 2, windowSeconds: 120 });
    await (service as any).validateRateLimit("login:test");
    expect(rateLimiterMock.consume).toHaveBeenCalledWith("login:test", 2, 120);
  });

  it("writes userAgent into login audit metadata", async () => {
    jest.spyOn(service, "validateUser").mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      firstName: "Test",
      lastName: "User",
      orgId: "org-1",
      primaryRoleId: "role-1",
      roleIds: ["role-1"],
      permissions: ["items.read"],
      isActive: true,
    });
    prismaMock.user.findUnique = jest.fn().mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      emailVerified: null,
      pendingEmail: null,
      firstName: "Test",
      lastName: "User",
      avatarUrl: null,
      lastLoginAt: null,
      isActive: true,
      memberships: [
        {
          orgId: "org-1",
          isActive: true,
          org: {
            id: "org-1",
            isActive: true,
            subscription: null,
          },
          roleId: "role-1",
          role: {
            name: "admin",
            permissions: [
              {
                permission: { name: "items.read" },
              },
            ],
          },
          roles: [],
        },
      ],
    });
    jest
      .spyOn(service as any, "signRefreshToken")
      .mockResolvedValue({ token: "refresh-token" });
    prismaMock.user.update = jest.fn().mockResolvedValue({
      id: "user-1",
      lastLoginAt: new Date(),
    });

    await service.login(
      "test@example.com",
      "password",
      "org-1",
      "127.0.0.1",
      "Chrome/136.0",
    );

    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "login",
          ipAddress: "127.0.0.1",
          metadata: {
            email: "test@example.com",
            userAgent: "Chrome/136.0",
          },
        }),
      }),
    );
  });

  it("defaults refresh to the org encoded in the token when none is provided", async () => {
    const secret = "a".repeat(64);
    prismaMock.refreshToken.findUnique = jest.fn().mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      tokenHash: await bcrypt.hash(secret, 10),
      expiresAt: new Date(Date.now() + 10000),
      revokedAt: null,
    });
    prismaMock.user.findUnique = jest.fn().mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      firstName: "Test",
      lastName: "User",
      isActive: true,
    });
    prismaMock.membership.findMany = jest.fn().mockResolvedValue([
      {
        orgId: "org-1",
        org: { isActive: true },
        roleId: "role-1",
        role: {
          permissions: [{ permission: { name: "items.read" } }],
        },
      },
      {
        orgId: "org-2",
        org: { isActive: true },
        roleId: "role-2",
        role: {
          permissions: [{ permission: { name: "items.write" } }],
        },
      },
    ]);

    const result = await service.refresh(`token-1.org-2.${secret}`);
    expect(result.user.orgId).toBe("org-2");
    expect(result.user.roleIds).toEqual(["role-2"]);
  });

  it("does not use a hardcoded orgId fallback in refresh cache keys", async () => {
    const secret = "a".repeat(64);
    prismaMock.refreshToken.findUnique = jest.fn().mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      tokenHash: await bcrypt.hash(secret, 10),
      expiresAt: new Date(Date.now() + 10000),
      revokedAt: null,
    });
    prismaMock.user.findUnique = jest.fn().mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      firstName: "Test",
      lastName: "User",
      isActive: true,
    });
    prismaMock.membership.findMany = jest.fn().mockResolvedValue([
      {
        orgId: "org-1",
        org: { isActive: true },
        roleId: "role-1",
        role: {
          permissions: [{ permission: { name: "items.read" } }],
        },
      },
    ]);

    const result = await service.refresh(`token-1.${secret}`);
    expect(result.user.orgId).toBe("org-1");

    const firstCacheKey = cacheMock.wrap.mock.calls[0]?.[0] as
      | string
      | undefined;
    expect(firstCacheKey).toBeDefined();
    expect(firstCacheKey).not.toContain(":default:");
  });

  it("allows switching organizations on refresh when requested", async () => {
    const secret = "a".repeat(64);
    prismaMock.refreshToken.findUnique = jest.fn().mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      tokenHash: await bcrypt.hash(secret, 10),
      expiresAt: new Date(Date.now() + 10000),
      revokedAt: null,
    });
    prismaMock.user.findUnique = jest.fn().mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      firstName: "Test",
      lastName: "User",
      isActive: true,
    });
    prismaMock.membership.findMany = jest.fn().mockResolvedValue([
      {
        orgId: "org-1",
        org: { isActive: true },
        roleId: "role-1",
        role: {
          permissions: [{ permission: { name: "items.read" } }],
        },
      },
      {
        orgId: "org-2",
        org: { isActive: true },
        roleId: "role-2",
        role: {
          permissions: [{ permission: { name: "items.write" } }],
        },
      },
    ]);

    const result = await service.refresh(`token-1.org-1.${secret}`, "org-2");
    expect(result.user.orgId).toBe("org-2");
    expect(result.user.permissions).toContain("items.write");
  });

  it("rejects refresh when the selected membership is disabled", async () => {
    const secret = "a".repeat(64);
    prismaMock.refreshToken.findUnique = jest.fn().mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      tokenHash: await bcrypt.hash(secret, 10),
      expiresAt: new Date(Date.now() + 10000),
      revokedAt: null,
    });
    prismaMock.user.findUnique = jest.fn().mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      firstName: "Test",
      lastName: "User",
      isActive: true,
    });
    prismaMock.membership.findMany = jest.fn().mockResolvedValue([
      {
        orgId: "org-1",
        isActive: false,
        org: { isActive: true },
        roleId: "role-1",
        role: {
          permissions: [{ permission: { name: "items.read" } }],
        },
      },
    ]);

    await expect(service.refresh(`token-1.org-1.${secret}`)).rejects.toThrow(
      "Organization access disabled",
    );
  });

  it("rejects blacklisted refresh tokens without querying the database", async () => {
    const secret = "a".repeat(64);
    refreshTokenBlacklistMock.has = jest.fn().mockResolvedValue(true);

    await expect(service.refresh(`token-1.org-1.${secret}`)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prismaMock.refreshToken.findUnique).not.toHaveBeenCalled();
  });

  it("does not issue multiple refresh tokens when org differs across calls", async () => {
    const secret = "a".repeat(64);
    prismaMock.refreshToken.findUnique = jest.fn().mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      tokenHash: await bcrypt.hash(secret, 10),
      expiresAt: new Date(Date.now() + 10000),
      revokedAt: null,
    });
    prismaMock.user.findUnique = jest.fn().mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      firstName: "Test",
      lastName: "User",
      isActive: true,
    });
    prismaMock.membership.findMany = jest.fn().mockResolvedValue([
      {
        orgId: "org-1",
        org: { isActive: true },
        roleId: "role-1",
        role: { permissions: [{ permission: { name: "items.read" } }] },
      },
      {
        orgId: "org-2",
        org: { isActive: true },
        roleId: "role-2",
        role: { permissions: [{ permission: { name: "items.write" } }] },
      },
    ]);

    const token = `token-1.org-1.${secret}`;
    const first = await service.refresh(token, "org-2");
    const second = await service.refresh(token);

    expect(second.user.orgId).toBe("org-2");
    expect(second.refreshToken).toBe(first.refreshToken);
    expect(prismaMock.refreshToken.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledTimes(1);
  });

  it("rejects refresh tokens that do not match the expected structure", async () => {
    await expect(service.refresh("token-without-secret")).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(service.refresh("token.org.too.short")).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("returns the cached refresh result during the grace window to avoid concurrent 401s", async () => {
    const secret = "a".repeat(64);
    const tokenHash = await bcrypt.hash(secret, 10);
    prismaMock.refreshToken.findUnique = jest.fn().mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      tokenHash,
      expiresAt: new Date(Date.now() + 10000),
      revokedAt: null,
    });
    prismaMock.user.findUnique = jest.fn().mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      firstName: "Test",
      lastName: "User",
      isActive: true,
    });
    prismaMock.membership.findMany = jest.fn().mockResolvedValue([
      {
        orgId: "org-1",
        org: { isActive: true },
        roleId: "role-1",
        role: {
          permissions: [{ permission: { name: "items.read" } }],
        },
      },
    ]);

    const token = `token-1.org-1.${secret}`;
    const first = await service.refresh(token);

    prismaMock.refreshToken.findUnique = jest.fn().mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      tokenHash,
      expiresAt: new Date(Date.now() + 10000),
      revokedAt: new Date(),
    });

    const second = await service.refresh(token);
    expect(second.refreshToken).toBe(first.refreshToken);
    expect(second.accessToken).toBe(first.accessToken);
    expect(prismaMock.refreshToken.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledTimes(1);
  });

  it("rejects missing membership", async () => {
    prismaMock.user.findUnique = jest.fn().mockResolvedValue({
      id: "user-1",
      email: "no-org@example.com",
      passwordHash: await bcrypt.hash("password", 10),
      firstName: "No",
      lastName: "Org",
      isActive: true,
      memberships: [],
    });

    await expect(
      service.validateUser("no-org@example.com", "password"),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("treats missing users as unauthorized when loading profiles", async () => {
    prismaMock.membership.findMany = jest.fn().mockResolvedValue([
      {
        orgId: "org-1",
        org: { isActive: true },
        roleId: "role-1",
        role: { permissions: [] },
        roles: [],
      },
    ]);
    prismaMock.user.findUnique = jest.fn().mockResolvedValue(null);

    await expect(service.getUserProfile("user-1", "org-1")).rejects.toThrow(
      "Invalid access token",
    );
  });

  it("rejects disabled memberships when loading profiles", async () => {
    prismaMock.membership.findMany = jest.fn().mockResolvedValue([
      {
        orgId: "org-1",
        isActive: false,
        org: { isActive: true },
        roleId: "role-1",
        role: { permissions: [] },
        roles: [],
      },
    ]);

    await expect(service.getUserProfile("user-1", "org-1")).rejects.toThrow(
      "Organization access disabled",
    );
  });

  it("returns generic success for sendLoginCode when account does not exist", async () => {
    prismaMock.user.findUnique = jest.fn().mockResolvedValue(null);

    const result = await service.sendLoginCode("missing@example.com");
    expect(result.ok).toBe(true);
    expect(emailServiceMock.send).not.toHaveBeenCalled();
  });

  it("sends verification email code and stores pendingEmail", async () => {
    prismaMock.user.findUnique = jest
      .fn()
      .mockResolvedValueOnce({
        id: "user-1",
        email: "old@example.com",
        isActive: true,
      })
      .mockResolvedValueOnce(null);
    prismaMock.user.findFirst = jest.fn().mockResolvedValue(null);
    prismaMock.user.update = jest.fn().mockResolvedValue({
      id: "user-1",
      pendingEmail: "new@example.com",
    });

    const result = await service.sendVerificationCode(
      "user-1",
      "org-1",
      "new@example.com",
    );

    expect(result.ok).toBe(true);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { pendingEmail: "new@example.com" },
    });
    expect(emailServiceMock.send).toHaveBeenCalled();
  });

  it("allows loginWithCode for verified users", async () => {
    cacheMock.get = jest.fn().mockResolvedValue({
      codeHash: crypto.createHash("sha256").update("12345678").digest("hex"),
      email: "test@example.com",
      userId: "user-1",
    });
    prismaMock.user.findUnique = jest.fn().mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      firstName: "Test",
      lastName: "User",
      avatarUrl: null,
      pendingEmail: null,
      emailVerified: new Date(),
      isActive: true,
      memberships: [
        {
          orgId: "org-1",
          org: { isActive: true },
          roleId: "role-1",
          role: {
            permissions: [{ permission: { name: "items.read" } }],
          },
          roles: [],
        },
      ],
    });

    const result = await service.loginWithCode(
      "test@example.com",
      "12345678",
      "org-1",
    );
    expect(result.user.id).toBe("user-1");
    expect(result.user.orgId).toBe("org-1");
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
  });

  it("rejects loginWithCode when the membership is disabled", async () => {
    cacheMock.get = jest.fn().mockResolvedValue({
      codeHash: crypto.createHash("sha256").update("12345678").digest("hex"),
      email: "test@example.com",
      userId: "user-1",
    });
    prismaMock.user.findUnique = jest.fn().mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      firstName: "Test",
      lastName: "User",
      avatarUrl: null,
      pendingEmail: null,
      emailVerified: new Date(),
      isActive: true,
      memberships: [
        {
          orgId: "org-1",
          isActive: false,
          org: { isActive: true },
          roleId: "role-1",
          role: {
            permissions: [{ permission: { name: "items.read" } }],
          },
          roles: [],
        },
      ],
    });

    await expect(
      service.loginWithCode("test@example.com", "12345678", "org-1"),
    ).rejects.toThrow("Organization access disabled");
  });

  it("writes userAgent into loginWithCode audit metadata", async () => {
    cacheMock.get = jest.fn().mockResolvedValue({
      codeHash: crypto.createHash("sha256").update("12345678").digest("hex"),
      email: "test@example.com",
      userId: "user-1",
    });
    prismaMock.user.findUnique = jest.fn().mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      firstName: "Test",
      lastName: "User",
      avatarUrl: null,
      pendingEmail: null,
      emailVerified: new Date(),
      isActive: true,
      memberships: [
        {
          orgId: "org-1",
          org: { isActive: true },
          roleId: "role-1",
          role: {
            permissions: [{ permission: { name: "items.read" } }],
          },
          roles: [],
        },
      ],
    });

    await service.loginWithCode(
      "test@example.com",
      "12345678",
      "org-1",
      "127.0.0.1",
      "Mozilla/5.0",
    );

    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "login_with_code",
          ipAddress: "127.0.0.1",
          metadata: {
            email: "test@example.com",
            userAgent: "Mozilla/5.0",
          },
        }),
      }),
    );
  });
});
