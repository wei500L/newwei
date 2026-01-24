import { LlmGatewaySettingsService } from "./llm-gateway-settings.service";
import { decodeSystemSettingsKey, encryptStringValueV1 } from "../storage/storage-settings.crypto";

const prismaMock = {
  systemSetting: {
    findUnique: jest.fn(),
    upsert: jest.fn()
  },
  auditLog: {
    create: jest.fn()
  }
} as any;

const cacheMock = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn()
} as any;

const envMock = {
  liteLlmConfig: {
    model: "openai/gpt-4o-mini",
    embeddingModel: "openai/text-embedding-3-small",
    apiBase: "http://localhost:4001",
    apiKey: undefined,
    timeoutMs: 60_000,
    temperature: 0.2,
    topP: 0.9,
    maxOutputTokens: 1_200,
    maxRetries: 3,
    fallbackModels: ["openai/gpt-4o-mini"],
    requestsPerMinute: 60
  },
  systemSettingsEncryptionKey: undefined
} as any;

describe("LlmGatewaySettingsService", () => {
  let service: LlmGatewaySettingsService;
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
      return { key: "llm_gateway_profiles", value: persistedValue };
    });
    prismaMock.systemSetting.upsert = jest.fn(async (args: any) => {
      persistedValue = args.create?.value ?? args.update?.value;
      return { key: "llm_gateway_profiles", value: persistedValue };
    });
    prismaMock.auditLog.create = jest.fn().mockResolvedValue(undefined);

    service = new LlmGatewaySettingsService(prismaMock, cacheMock, envMock, securitySettingsMock);
  });

  it("returns empty settings when no record exists", async () => {
    const response = await service.list();
    expect(response.activeId).toBeNull();
    expect(response.profiles).toEqual([]);
  });

  it("creates a profile and auto-activates the first one", async () => {
    const created = await service.createProfile("org-1", "actor-1", {
      name: "LiteLLM Local",
      apiBase: "http://localhost:4001/v1",
      model: "openai/gpt-4o-mini",
      enabled: true
    });

    expect(typeof created.id).toBe("string");
    expect(created.name).toBe("LiteLLM Local");
    expect(created.apiBase).toBe("http://localhost:4001/v1");
    expect(created.hasApiKey).toBe(false);

    const listed = await service.list();
    expect(listed.activeId).toBe(created.id);
    expect(listed.embeddingActiveId).toBeNull();
    expect(listed.profiles).toHaveLength(1);
  });

  it("uses active profile for embeddings when embeddingActiveId is unset", async () => {
    const first = await service.createProfile("org-1", "actor-1", {
      name: "Gateway A",
      apiBase: "http://gateway-a:4001/v1",
      model: "openai/gpt-4o-mini",
      embeddingModel: "openai/text-embedding-3-small",
      enabled: true
    });

    const second = await service.createProfile("org-1", "actor-1", {
      name: "Gateway B",
      apiBase: "http://gateway-b:4001/v1",
      model: "openai/gpt-4o-mini",
      embeddingModel: "openai/text-embedding-3-small",
      enabled: true
    });

    await service.setActiveProfile("org-1", "actor-1", second.id);

    const embeddingCfg = await service.getActiveEmbeddingConfig();
    expect(embeddingCfg?.apiBase).toBe("http://gateway-b:4001/v1");

    const listed = await service.list();
    expect(listed.activeId).toBe(second.id);
    expect(listed.embeddingActiveId).toBeNull();
    expect(listed.profiles.map((profile) => profile.id)).toEqual([first.id, second.id]);
  });

  it("persists embeddingActiveId when explicitly set", async () => {
    const first = await service.createProfile("org-1", "actor-1", {
      name: "Gateway A",
      apiBase: "http://gateway-a:4001/v1",
      model: "openai/gpt-4o-mini",
      embeddingModel: "openai/text-embedding-3-small",
      enabled: true
    });

    const second = await service.createProfile("org-1", "actor-1", {
      name: "Gateway B",
      apiBase: "http://gateway-b:4001/v1",
      model: "openai/gpt-4o-mini",
      embeddingModel: "openai/text-embedding-3-small",
      enabled: true
    });

    await service.setActiveProfile("org-1", "actor-1", second.id);
    await service.setEmbeddingActiveProfile("org-1", "actor-1", first.id);

    const listed = await service.list();
    expect(listed.activeId).toBe(second.id);
    expect(listed.embeddingActiveId).toBe(first.id);
  });

  it("allows embeddingActiveId to match activeId when explicitly set", async () => {
    const created = await service.createProfile("org-1", "actor-1", {
      name: "Gateway",
      apiBase: "http://gateway:4001/v1",
      model: "openai/gpt-4o-mini",
      embeddingModel: "openai/text-embedding-3-small",
      enabled: true
    });

    await service.setEmbeddingActiveProfile("org-1", "actor-1", created.id);

    const listed = await service.list();
    expect(listed.activeId).toBe(created.id);
    expect(listed.embeddingActiveId).toBe(created.id);
  });

  it("clears activeId when persisted active profile is disabled", async () => {
    persistedValue = {
      activeId: "profile-1",
      embeddingActiveId: null,
      profiles: [
        {
          id: "profile-1",
          name: "Disabled Gateway",
          apiBase: "http://localhost:4001/v1",
          model: "openai/gpt-4o-mini",
          enabled: false,
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z"
        }
      ]
    };

    const listed = await service.list();
    expect(listed.activeId).toBeNull();
    expect(listed.profiles).toHaveLength(1);
    expect(listed.profiles[0]?.enabled).toBe(false);
  });

  it("clears activeId when the active profile is disabled", async () => {
    const created = await service.createProfile("org-1", "actor-1", {
      name: "LiteLLM Local",
      apiBase: "http://localhost:4001",
      model: "openai/gpt-4o-mini",
      enabled: true
    });

    await service.updateProfile("org-1", "actor-1", created.id, { enabled: false });

    const listed = await service.list();
    expect(listed.activeId).toBeNull();
    expect(listed.profiles[0]?.enabled).toBe(false);
  });

  it("stores apiKey in plaintext when SYSTEM_SETTINGS_ENCRYPTION_KEY is missing", async () => {
    const created = await service.createProfile("org-1", "actor-1", {
      name: "My Gateway",
      apiBase: "http://localhost:4001",
      model: "openai/gpt-4o-mini",
      apiKey: "sk-test"
    });

    expect(created.hasApiKey).toBe(true);

    const rawApiKey = persistedValue?.profiles?.[0]?.apiKey;
    expect(rawApiKey).toBe("sk-test");

    const active = await service.getActiveConfig();
    expect(active?.apiKey).toBe("sk-test");
  });

  it("stores apiKey in plaintext when encryption toggle is disabled", async () => {
    envMock.systemSettingsEncryptionKey = "0".repeat(64);

    const created = await service.createProfile("org-1", "actor-1", {
      name: "My Gateway",
      apiBase: "http://localhost:4001",
      model: "openai/gpt-4o-mini",
      apiKey: "sk-test"
    });

    expect(created.hasApiKey).toBe(true);

    const rawApiKey = persistedValue?.profiles?.[0]?.apiKey;
    expect(rawApiKey).toBe("sk-test");
  });

  it("strips Bearer prefix when storing apiKey", async () => {
    const created = await service.createProfile("org-1", "actor-1", {
      name: "My Gateway",
      apiBase: "http://localhost:4001",
      model: "openai/gpt-4o-mini",
      apiKey: "Bearer sk-test"
    });

    expect(created.hasApiKey).toBe(true);
    const rawApiKey = persistedValue?.profiles?.[0]?.apiKey;
    expect(rawApiKey).toBe("sk-test");

    const active = await service.getActiveConfig();
    expect(active?.apiKey).toBe("sk-test");
  });

  it("stores apiKey encrypted and returns it decrypted via getActiveConfig", async () => {
    envMock.systemSettingsEncryptionKey = "0".repeat(64);
    encryptionEnabled = true;

    const created = await service.createProfile("org-1", "actor-1", {
      name: "Secure Gateway",
      apiBase: "http://localhost:4001",
      model: "openai/gpt-4o-mini",
      apiKey: "sk-test"
    });

    expect(created.hasApiKey).toBe(true);

    const rawApiKey = persistedValue?.profiles?.[0]?.apiKey;
    expect(rawApiKey).toBeTruthy();
    expect(typeof rawApiKey).toBe("object");
    expect(rawApiKey.__enc).toBe("system-settings:v1");

    const active = await service.getActiveConfig();
    expect(active?.apiKey).toBe("sk-test");
  });

  it("returns a profile config by id with decrypted apiKey", async () => {
    envMock.systemSettingsEncryptionKey = "0".repeat(64);

    const created = await service.createProfile("org-1", "actor-1", {
      name: "Gateway",
      apiBase: "http://localhost:4001",
      model: "openai/gpt-4o-mini",
      apiKey: "sk-test"
    });

    const cfg = await service.getProfileConfig(created.id);
    expect(cfg?.apiKey).toBe("sk-test");
    expect(cfg?.apiBase).toBe("http://localhost:4001");
    expect(cfg?.model).toBe("openai/gpt-4o-mini");
  });
});
