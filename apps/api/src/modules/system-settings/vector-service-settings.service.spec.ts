import { BadRequestException } from "@nestjs/common";

import { VectorServiceSettingsService } from "./vector-service-settings.service";

const prismaMock = {
  systemSetting: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    deleteMany: jest.fn(),
  },
  auditLog: {
    create: jest.fn(),
  },
  auditLogOutbox: {
    create: jest.fn(),
  },
} as any;

const cacheMock = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
} as any;

const envMock = {
  vectorServiceConfig: {
    enabled: false,
    fallbackToMongo: true,
    baseUrl: undefined,
    token: undefined,
    timeoutMs: 5_000,
    maxRetries: 2,
  },
  systemSettingsEncryptionKey: undefined,
} as any;

describe("VectorServiceSettingsService", () => {
  let service: VectorServiceSettingsService;
  let cacheState: any;
  let persistedValue: any;

  beforeEach(() => {
    jest.resetAllMocks();
    cacheState = null;
    persistedValue = undefined;
    envMock.systemSettingsEncryptionKey = undefined;

    cacheMock.get = jest.fn(async () => cacheState);
    cacheMock.set = jest.fn(async (_key: string, value: unknown) => {
      cacheState = value;
    });
    cacheMock.del = jest.fn(async () => {
      cacheState = null;
    });

    prismaMock.systemSetting.findUnique = jest.fn(async () => {
      if (!persistedValue) {
        return null;
      }
      return { key: "vector_service", value: persistedValue };
    });
    prismaMock.systemSetting.upsert = jest.fn(async (args: any) => {
      persistedValue = args.create?.value ?? args.update?.value;
      return { key: "vector_service", value: persistedValue };
    });
    prismaMock.systemSetting.deleteMany = jest.fn(async () => {
      persistedValue = undefined;
      return { count: 1 };
    });
    prismaMock.auditLog.create = jest.fn().mockResolvedValue(undefined);
    prismaMock.auditLogOutbox.create = jest.fn().mockResolvedValue(undefined);

    service = new VectorServiceSettingsService(prismaMock, cacheMock, envMock);
  });

  it("returns env defaults when no record exists", async () => {
    const response = await service.getPublicSettings();
    expect(response.source).toBe("env");
    expect(response.enabled).toBe(false);
    expect(response.fallbackToMongo).toBe(true);
    expect(response.baseUrl).toBeNull();
    expect(response.hasToken).toBe(false);
    expect(response.tokenSource).toBe("none");
  });

  it("stores token in plaintext when SYSTEM_SETTINGS_ENCRYPTION_KEY is missing", async () => {
    const response = await service.updateSettings("org-1", "actor-1", {
      enabled: true,
      fallbackToMongo: true,
      baseUrl: "http://localhost:4010",
      token: "dev-token",
      timeoutMs: 5_000,
      maxRetries: 2,
    });

    expect(response.source).toBe("db");
    expect(response.enabled).toBe(true);
    expect(response.baseUrl).toBe("http://localhost:4010");
    expect(response.hasToken).toBe(true);
    expect(response.tokenSource).toBe("stored");

    expect(persistedValue?.token).toBe("dev-token");
    const effective = await service.getEffectiveConfig();
    expect(effective.token).toBe("dev-token");
  });

  it("stores token encrypted and returns it decrypted via getEffectiveConfig", async () => {
    envMock.systemSettingsEncryptionKey = "0".repeat(64);

    await service.updateSettings("org-1", "actor-1", {
      enabled: true,
      fallbackToMongo: false,
      baseUrl: "http://localhost:4010",
      token: "dev-token",
      timeoutMs: 5_000,
      maxRetries: 1,
    });

    const rawToken = persistedValue?.token;
    expect(rawToken).toBeTruthy();
    expect(typeof rawToken).toBe("object");
    expect(rawToken.__enc).toBe("system-settings:v1");

    const effective = await service.getEffectiveConfig();
    expect(effective.token).toBe("dev-token");
  });

  it("keeps token when token is omitted", async () => {
    await service.updateSettings("org-1", "actor-1", {
      enabled: true,
      fallbackToMongo: true,
      baseUrl: "http://localhost:4010",
      token: "dev-token",
      timeoutMs: 5_000,
      maxRetries: 2,
    });

    await service.updateSettings("org-1", "actor-1", {
      enabled: true,
      fallbackToMongo: false,
      baseUrl: "http://localhost:4010",
      timeoutMs: 10_000,
      maxRetries: 0,
    });

    expect(persistedValue?.token).toBe("dev-token");
    expect(persistedValue?.fallbackToMongo).toBe(false);
    expect(persistedValue?.timeoutMs).toBe(10_000);
    expect(persistedValue?.maxRetries).toBe(0);
  });

  it("clears token when token is set to null", async () => {
    await service.updateSettings("org-1", "actor-1", {
      enabled: false,
      fallbackToMongo: true,
      baseUrl: "http://localhost:4010",
      token: "dev-token",
      timeoutMs: 5_000,
      maxRetries: 2,
    });

    const response = await service.updateSettings("org-1", "actor-1", {
      enabled: false,
      fallbackToMongo: true,
      baseUrl: "http://localhost:4010",
      token: null,
      timeoutMs: 5_000,
      maxRetries: 2,
    });

    expect(response.hasToken).toBe(false);
    expect(response.tokenSource).toBe("none");
    expect(persistedValue?.token).toBeNull();
  });

  it("resets stored settings to env", async () => {
    await service.updateSettings("org-1", "actor-1", {
      enabled: true,
      fallbackToMongo: true,
      baseUrl: "http://localhost:4010",
      token: "dev-token",
      timeoutMs: 5_000,
      maxRetries: 2,
    });

    const response = await service.resetToEnv("org-1", "actor-1");
    expect(response.source).toBe("env");
    expect(response.enabled).toBe(false);
    expect(response.hasToken).toBe(false);
  });

  it("rejects enabling when baseUrl or token missing", async () => {
    await expect(
      service.updateSettings("org-1", "actor-1", {
        enabled: true,
        fallbackToMongo: true,
        baseUrl: null,
        token: null,
        timeoutMs: 5_000,
        maxRetries: 2,
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
