import { AuthEmailCodeSettingsService } from "./auth-email-code-settings.service";

const prismaMock = {
  systemSetting: {
    findUnique: jest.fn(),
    upsert: jest.fn()
  },
  auditLog: {
    create: jest.fn()
  }
} as any;

const envMock = {
  authEmailCodeConfig: {
    ttlSeconds: 300,
    cooldownSeconds: 90,
    maxAttempts: 3
  }
} as any;

const cacheMock = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn()
} as any;

describe("AuthEmailCodeSettingsService", () => {
  let service: AuthEmailCodeSettingsService;

  beforeEach(() => {
    jest.resetAllMocks();
    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue(null);
    prismaMock.systemSetting.upsert = jest.fn().mockResolvedValue(undefined);
    prismaMock.auditLog.create = jest.fn().mockResolvedValue(undefined);
    cacheMock.get = jest.fn().mockResolvedValue(null);
    cacheMock.set = jest.fn().mockResolvedValue(undefined);
    cacheMock.del = jest.fn().mockResolvedValue(undefined);
    service = new AuthEmailCodeSettingsService(prismaMock, envMock, cacheMock);
  });

  it("returns env defaults when no database setting exists", async () => {
    const settings = await service.getSettings();

    expect(settings).toEqual({
      ttlSeconds: 300,
      cooldownSeconds: 90,
      maxAttempts: 3
    });
    expect(prismaMock.systemSetting.findUnique).toHaveBeenCalledWith({
      where: { key: "auth_email_code_settings" }
    });
    expect(cacheMock.set).toHaveBeenCalledWith("auth_email_code:settings", settings, 60);
  });

  it("prefers persisted settings and clamps out-of-range values", async () => {
    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue({
      key: "auth_email_code_settings",
      value: {
        ttlSeconds: 10,
        cooldownSeconds: 5_000,
        maxAttempts: 0
      }
    });

    const settings = await service.getSettings();

    expect(settings).toEqual({
      ttlSeconds: 60,
      cooldownSeconds: 3_600,
      maxAttempts: 1
    });
  });

  it("updates settings, writes audit log, and refreshes cache", async () => {
    const updated = await service.updateSettings("org-1", "admin-1", {
      ttlSeconds: 120,
      cooldownSeconds: 30,
      maxAttempts: 5
    });

    expect(updated).toEqual({
      ttlSeconds: 120,
      cooldownSeconds: 30,
      maxAttempts: 5
    });
    expect(prismaMock.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "auth_email_code_settings" },
        update: expect.objectContaining({
          value: {
            ttlSeconds: 120,
            cooldownSeconds: 30,
            maxAttempts: 5
          },
          updatedById: "admin-1"
        })
      })
    );
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgId: "org-1",
          actorId: "admin-1",
          action: "auth_email_code_settings_update"
        })
      })
    );
    expect(cacheMock.set).toHaveBeenCalledWith(
      "auth_email_code:settings",
      updated,
      60
    );
  });
});
