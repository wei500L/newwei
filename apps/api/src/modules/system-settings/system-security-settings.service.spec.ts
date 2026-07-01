import { BadRequestException } from "@nestjs/common";

import { SystemSecuritySettingsService } from "./system-security-settings.service";

const prismaMock = {
  systemSetting: {
    findUnique: jest.fn(),
    upsert: jest.fn()
  },
  auditLog: {
    create: jest.fn()
  },
  auditLogOutbox: {
    create: jest.fn()
  }
} as any;

const cacheMock = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn()
} as any;

const envMock = {
  systemSettingsEncryptionKey: undefined as string | undefined
} as any;

const authSecurityMock = {
  invalidate: jest.fn().mockResolvedValue(undefined),
} as any;

describe("SystemSecuritySettingsService", () => {
  let service: SystemSecuritySettingsService;
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
      return { key: "system_security", value: persistedValue };
    });
    prismaMock.systemSetting.upsert = jest.fn(async (args: any) => {
      persistedValue = args.create?.value ?? args.update?.value;
      return { key: "system_security", value: persistedValue };
    });
    prismaMock.auditLog.create = jest.fn().mockResolvedValue(undefined);
    prismaMock.auditLogOutbox.create = jest.fn().mockResolvedValue({ id: "outbox-1" });

    service = new SystemSecuritySettingsService(
      prismaMock,
      cacheMock,
      envMock,
      authSecurityMock,
    );
  });

  it("defaults to encryption disabled when no setting exists", async () => {
    envMock.systemSettingsEncryptionKey = "0".repeat(64);
    const settings = await service.getPublicSettings();
    expect(settings.secretEncryptionEnabled).toBe(false);
    expect(settings.encryptionKeyPresent).toBe(true);
    expect(settings.encryptionKeyValid).toBe(true);
    expect(settings.encryptionKeyError).toBeNull();
  });

  it("returns key status even when encryption is disabled", async () => {
    envMock.systemSettingsEncryptionKey = "not-a-key";
    const settings = await service.getPublicSettings();
    expect(settings.secretEncryptionEnabled).toBe(false);
    expect(settings.encryptionKeyPresent).toBe(true);
    expect(settings.encryptionKeyValid).toBe(false);
    expect(settings.encryptionKeyError).toContain("SYSTEM_SETTINGS_ENCRYPTION_KEY");
  });

  it("rejects enabling encryption when env key is missing", async () => {
    await expect(
      service.updateSettings("org-1", "actor-1", {
        secretEncryptionEnabled: true,
        mfaPolicy: "off",
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("enables encryption when env key is valid", async () => {
    envMock.systemSettingsEncryptionKey = "0".repeat(64);

    const updated = await service.updateSettings("org-1", "actor-1", {
      secretEncryptionEnabled: true,
      mfaPolicy: "admins_only",
    });

    expect(updated.secretEncryptionEnabled).toBe(true);
    expect(updated.mfaPolicy).toBe("admins_only");
    expect(persistedValue?.secretEncryptionEnabled).toBe(true);
  });

  it("encodeSecretForStorage returns plaintext when encryption disabled", async () => {
    envMock.systemSettingsEncryptionKey = "0".repeat(64);
    const encoded = await service.encodeSecretForStorage("hello");
    expect(encoded).toBe("hello");
  });

  it("encodeSecretForStorage encrypts when enabled and key valid", async () => {
    envMock.systemSettingsEncryptionKey = "0".repeat(64);
    await service.updateSettings("org-1", "actor-1", {
      secretEncryptionEnabled: true,
      mfaPolicy: "off",
    });

    const encoded = await service.encodeSecretForStorage("hello");
    expect(encoded).toBeTruthy();
    expect(typeof encoded).toBe("object");
    expect((encoded as any).__enc).toBe("system-settings:v1");
  });
});
