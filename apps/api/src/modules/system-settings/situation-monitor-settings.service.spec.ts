import { SituationMonitorSettingsService } from "./situation-monitor-settings.service";

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

describe("SituationMonitorSettingsService", () => {
  let service: SituationMonitorSettingsService;
  let cacheState: any;
  let persistedValue: any;

  beforeEach(() => {
    jest.resetAllMocks();
    cacheState = null;
    persistedValue = undefined;

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
      return { key: "situation_monitor_settings", value: persistedValue };
    });
    prismaMock.systemSetting.upsert = jest.fn(async (args: any) => {
      persistedValue = args.create?.value ?? args.update?.value;
      return { key: "situation_monitor_settings", value: persistedValue };
    });
    prismaMock.systemSetting.deleteMany = jest.fn(async () => {
      persistedValue = undefined;
      return { count: 1 };
    });
    prismaMock.auditLog.create = jest.fn().mockResolvedValue(undefined);
    prismaMock.auditLogOutbox.create = jest.fn().mockResolvedValue(undefined);

    service = new SituationMonitorSettingsService(prismaMock, cacheMock);
  });

  it("returns env defaults when no record exists", async () => {
    const response = await service.getPublicSettings();
    expect(response.source).toBe("env");
    expect(response.translationMaxConcurrency).toBe(2);
  });

  it("stores overrides and returns db source", async () => {
    const response = await service.updateSettings("org-1", "actor-1", { translationMaxConcurrency: 3 });

    expect(response.source).toBe("db");
    expect(response.translationMaxConcurrency).toBe(3);
    expect(persistedValue?.translationMaxConcurrency).toBe(3);
  });

  it("resets to env defaults", async () => {
    await service.updateSettings("org-1", "actor-1", { translationMaxConcurrency: 4 });

    const response = await service.resetToEnv("org-1", "actor-1");
    expect(response.source).toBe("env");
    expect(response.translationMaxConcurrency).toBe(2);
    expect(persistedValue).toBeUndefined();
  });

  it("falls back to defaults when stored values are invalid", async () => {
    persistedValue = { translationMaxConcurrency: "nope" };
    const response = await service.getPublicSettings();
    expect(response.source).toBe("db");
    expect(response.translationMaxConcurrency).toBe(2);
  });
});

