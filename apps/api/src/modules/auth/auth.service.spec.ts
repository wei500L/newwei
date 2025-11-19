import { BadRequestException, TooManyRequestsException, UnauthorizedException } from "@nestjs/common";
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

const cacheMock = {
  get: jest.fn(),
  set: jest.fn()
} as any;

const accessTokenBlacklistMock = {
  add: jest.fn(),
  has: jest.fn()
} as any;

describe("AuthService", () => {
  let service: AuthService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new AuthService(
      prismaMock,
      envMock,
      rateLimiterMock,
      cacheMock,
      accessTokenBlacklistMock
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
  });

  it("throws on excessive login attempts", async () => {
    rateLimiterMock.consume = jest.fn().mockResolvedValue(false);
    await expect(service.login("user@example.com", "pw", "127.0.0.1")).rejects.toThrow(
      TooManyRequestsException
    );
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
