import { OpenAiKeysSettingsService } from "./openai-keys-settings.service";

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
  systemSettingsEncryptionKey: undefined as string | undefined,
} as any;

const securityMock = {
  encodeSecretForStorage: jest.fn(async (plain: string) => plain),
} as any;

describe("OpenAiKeysSettingsService", () => {
  let service: OpenAiKeysSettingsService;
  let cacheState: Map<string, any>;
  let persisted: Record<string, any>;

  beforeEach(() => {
    jest.resetAllMocks();
    cacheState = new Map();
    persisted = {};

    securityMock.encodeSecretForStorage = jest.fn(async (plain: string) => plain);

    cacheMock.get = jest.fn(async (key: string) => cacheState.get(key));
    cacheMock.set = jest.fn(async (key: string, value: unknown) => {
      cacheState.set(key, value);
    });
    cacheMock.del = jest.fn(async () => {
      cacheState = new Map();
    });

    prismaMock.systemSetting.findUnique = jest.fn(async (args: any) => {
      const key = args?.where?.key;
      if (!key || !(key in persisted)) {
        return null;
      }
      return { key, value: persisted[key] };
    });
    prismaMock.systemSetting.upsert = jest.fn(async (args: any) => {
      const key = args?.where?.key;
      const value = args.create?.value ?? args.update?.value;
      if (typeof key === "string") {
        persisted[key] = value;
      }
      return { key, value };
    });
    prismaMock.systemSetting.deleteMany = jest.fn(async (args: any) => {
      const key = args?.where?.key;
      if (typeof key === "string") {
        delete persisted[key];
      }
      return { count: 1 };
    });
    prismaMock.auditLog.create = jest.fn().mockResolvedValue(undefined);
    prismaMock.auditLogOutbox.create = jest.fn().mockResolvedValue(undefined);

    service = new OpenAiKeysSettingsService(prismaMock, cacheMock, envMock, securityMock);
  });

  it("returns none when no record exists", async () => {
    const response = await service.getPublicSettings();
    expect(response.source).toBe("none");
    expect(response.keysCount).toBe(0);
    expect(response.hasKeys).toBe(false);
    expect(response.keyFingerprints).toEqual([]);
    expect(response.appliedAt).toBeNull();
    expect(response.appliedSource).toBeNull();
    expect(response.appliedKeyFingerprints).toEqual([]);
    expect(response.restartRequired).toBe(false);
  });

  it("stores keys and returns count", async () => {
    const response = await service.updateSettings("org-1", "actor-1", {
      keys: ["sk-one", "sk-two", " sk-one "],
    });

    expect(response).toMatchObject({
      source: "db",
      keysCount: 2,
      hasKeys: true,
    });
    expect(response.keyFingerprints).toHaveLength(2);
    expect(response.restartRequired).toBe(true);

    const keys = await service.getPlaintextKeys();
    expect(keys).toEqual(["sk-one", "sk-two"]);
  });

  it("rejects more than 100 keys", async () => {
    const keys = Array.from({ length: 101 }, (_, i) => `sk-${i}`);
    await expect(
      service.updateSettings("org-1", "actor-1", { keys })
    ).rejects.toThrow("Too many OpenAI API keys");
  });

  it("resets stored keys", async () => {
    await service.updateSettings("org-1", "actor-1", { keys: ["sk-one"] });
    const response = await service.reset("org-1", "actor-1");
    expect(response.source).toBe("none");
    expect(response.keysCount).toBe(0);
    expect(response.keyFingerprints).toEqual([]);
    expect(response.restartRequired).toBe(false);
  });
});
