import { BadRequestException } from "@nestjs/common";

import { ModelServiceSettingsService } from "./model-service-settings.service";
import { decodeSystemSettingsKey, encryptStringValueV1 } from "../storage/storage-settings.crypto";

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
  modelServiceConfig: {
    enabled: false,
    baseUrl: undefined,
    internalToken: undefined,
    timeoutMs: 15_000,
    maxRetries: 2,
  },
  systemSettingsEncryptionKey: undefined,
} as any;

describe("ModelServiceSettingsService", () => {
  let service: ModelServiceSettingsService;
  let cacheState: any;
  let persistedValue: any;
  let encryptionEnabled: boolean;
  const securitySettingsMock = {
    encodeSecretForStorage: jest.fn(async (plain: string) => {
      if (!encryptionEnabled) {
        return plain;
      }
      const key = decodeSystemSettingsKey(envMock.systemSettingsEncryptionKey);
      return encryptStringValueV1(plain, key);
    })
  } as any;

  beforeEach(() => {
    jest.resetAllMocks();
    cacheState = null;
    persistedValue = undefined;
    envMock.systemSettingsEncryptionKey = undefined;
    encryptionEnabled = false;
    securitySettingsMock.encodeSecretForStorage = jest.fn(async (plain: string) => {
      if (!encryptionEnabled) {
        return plain;
      }
      const key = decodeSystemSettingsKey(envMock.systemSettingsEncryptionKey);
      return encryptStringValueV1(plain, key);
    });

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
      return { key: "model_service", value: persistedValue };
    });
    prismaMock.systemSetting.upsert = jest.fn(async (args: any) => {
      persistedValue = args.create?.value ?? args.update?.value;
      return { key: "model_service", value: persistedValue };
    });
    prismaMock.systemSetting.deleteMany = jest.fn(async () => {
      persistedValue = undefined;
      return { count: 1 };
    });
    prismaMock.auditLog.create = jest.fn().mockResolvedValue(undefined);
    prismaMock.auditLogOutbox.create = jest.fn().mockResolvedValue(undefined);

    service = new ModelServiceSettingsService(prismaMock, cacheMock, envMock, securitySettingsMock);
  });

  it("returns env defaults when no record exists", async () => {
    const response = await service.getPublicSettings();
    expect(response.source).toBe("env");
    expect(response.enabled).toBe(false);
    expect(response.baseUrl).toBeNull();
    expect(response.hasToken).toBe(false);
    expect(response.tokenSource).toBe("none");
  });

  it("stores token in plaintext when SYSTEM_SETTINGS_ENCRYPTION_KEY is missing", async () => {
    const response = await service.updateSettings("org-1", "actor-1", {
      enabled: true,
      baseUrl: "http://localhost:8090",
      internalToken: "dev-token",
      timeoutMs: 15_000,
      maxRetries: 2,
    });

    expect(response.source).toBe("db");
    expect(response.enabled).toBe(true);
    expect(response.baseUrl).toBe("http://localhost:8090");
    expect(response.hasToken).toBe(true);
    expect(response.tokenSource).toBe("stored");

    expect(persistedValue?.internalToken).toBe("dev-token");
    const effective = await service.getEffectiveConfig();
    expect(effective.internalToken).toBe("dev-token");
  });

  it("stores token encrypted and returns it decrypted via getEffectiveConfig", async () => {
    envMock.systemSettingsEncryptionKey = "0".repeat(64);
    encryptionEnabled = true;

    await service.updateSettings("org-1", "actor-1", {
      enabled: true,
      baseUrl: "http://localhost:8090",
      internalToken: "dev-token",
      timeoutMs: 12_000,
      maxRetries: 1,
    });

    const rawToken = persistedValue?.internalToken;
    expect(rawToken).toBeTruthy();
    expect(typeof rawToken).toBe("object");
    expect(rawToken.__enc).toBe("system-settings:v1");

    const effective = await service.getEffectiveConfig();
    expect(effective.internalToken).toBe("dev-token");
  });

  it("keeps token when token is omitted", async () => {
    await service.updateSettings("org-1", "actor-1", {
      enabled: true,
      baseUrl: "http://localhost:8090",
      internalToken: "dev-token",
      timeoutMs: 15_000,
      maxRetries: 2,
    });

    await service.updateSettings("org-1", "actor-1", {
      enabled: true,
      baseUrl: "http://localhost:8090",
      timeoutMs: 10_000,
      maxRetries: 0,
    });

    expect(persistedValue?.internalToken).toBe("dev-token");
    expect(persistedValue?.timeoutMs).toBe(10_000);
    expect(persistedValue?.maxRetries).toBe(0);
  });

  it("clears token when token is set to null", async () => {
    await service.updateSettings("org-1", "actor-1", {
      enabled: false,
      baseUrl: "http://localhost:8090",
      internalToken: "dev-token",
      timeoutMs: 15_000,
      maxRetries: 2,
    });

    const response = await service.updateSettings("org-1", "actor-1", {
      enabled: false,
      baseUrl: "http://localhost:8090",
      internalToken: null,
      timeoutMs: 15_000,
      maxRetries: 2,
    });

    expect(response.hasToken).toBe(false);
    expect(response.tokenSource).toBe("none");
    expect(persistedValue?.internalToken).toBeNull();
  });

  it("resets stored settings to env", async () => {
    await service.updateSettings("org-1", "actor-1", {
      enabled: true,
      baseUrl: "http://localhost:8090",
      internalToken: "dev-token",
      timeoutMs: 15_000,
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
        baseUrl: null,
        internalToken: null,
        timeoutMs: 15_000,
        maxRetries: 2,
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
