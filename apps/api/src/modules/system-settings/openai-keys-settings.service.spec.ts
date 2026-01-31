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
  let cacheState: any;
  let persistedValue: any;

  beforeEach(() => {
    jest.resetAllMocks();
    cacheState = null;
    persistedValue = undefined;

    securityMock.encodeSecretForStorage = jest.fn(async (plain: string) => plain);

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
      return { key: "openai_keys", value: persistedValue };
    });
    prismaMock.systemSetting.upsert = jest.fn(async (args: any) => {
      persistedValue = args.create?.value ?? args.update?.value;
      return { key: "openai_keys", value: persistedValue };
    });
    prismaMock.systemSetting.deleteMany = jest.fn(async () => {
      persistedValue = undefined;
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

    const keys = await service.getPlaintextKeys();
    expect(keys).toEqual(["sk-one", "sk-two"]);
  });

  it("resets stored keys", async () => {
    await service.updateSettings("org-1", "actor-1", { keys: ["sk-one"] });
    const response = await service.reset("org-1", "actor-1");
    expect(response.source).toBe("none");
    expect(response.keysCount).toBe(0);
    expect(response.keyFingerprints).toEqual([]);
  });
});
