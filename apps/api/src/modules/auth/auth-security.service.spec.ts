import { AuthSecurityService } from "./auth-security.service";

const prismaMock = {
  systemSetting: {
    findUnique: jest.fn()
  }
} as any;

const cacheMock = {
  wrap: jest.fn()
} as any;

const envMock = {
  systemSettingsEncryptionKey: undefined as string | undefined
} as any;

describe("AuthSecurityService", () => {
  let service: AuthSecurityService;
  let storedSettings: any;

  beforeEach(() => {
    jest.resetAllMocks();
    storedSettings = null;
    envMock.systemSettingsEncryptionKey = undefined;

    prismaMock.systemSetting.findUnique = jest.fn(async () =>
      storedSettings ? { key: "system_security", value: storedSettings } : null
    );
    cacheMock.wrap = jest.fn(async (_key: string, _ttl: number, loader: () => Promise<unknown>) =>
      loader()
    );

    service = new AuthSecurityService(prismaMock, cacheMock, envMock);
  });

  it("encodeSecret encrypts by default when key present", async () => {
    envMock.systemSettingsEncryptionKey = "0".repeat(64);
    const encoded = await service.encodeSecret("hello");
    expect(typeof encoded).toBe("object");
    expect((encoded as any).__enc).toBe("system-settings:v1");
  });

  it("encodeSecret returns plaintext when explicitly disabled and key present", async () => {
    envMock.systemSettingsEncryptionKey = "0".repeat(64);
    storedSettings = { secretEncryptionEnabled: false, mfaPolicy: "off" };

    const encoded = await service.encodeSecret("hello");
    expect(encoded).toBe("hello");
  });

  it("encodeSecret throws when encryption enabled but key missing", async () => {
    storedSettings = { secretEncryptionEnabled: true, mfaPolicy: "off" };
    await expect(service.encodeSecret("hello")).rejects.toThrow(
      "Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is not configured"
    );
  });

  it("encodeSecret throws in production when key missing (fail-closed)", async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(service.encodeSecret("hello")).rejects.toThrow(
        "SYSTEM_SETTINGS_ENCRYPTION_KEY is required to store secrets in production"
      );
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it("encodeSecret returns plaintext in non-production when key missing", async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const encoded = await service.encodeSecret("hello");
      expect(encoded).toBe("hello");
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it("decodeSecret returns legacy plaintext string as-is", async () => {
    const decoded = await service.decodeSecret("legacy-plaintext-secret");
    expect(decoded).toBe("legacy-plaintext-secret");
  });
});
