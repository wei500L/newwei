import { LiteLlmProxyLoadBalancingSettingsService } from "./litellm-proxy-lb-settings.service";

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

const openaiKeysMock = {
  getPublicSettings: jest.fn(async () => ({
    source: "db",
    keysCount: 2,
    hasKeys: true,
    keyFingerprints: ["fp-openai-1", "fp-openai-2"],
    internalTokenConfigured: true,
    appliedAt: null,
    appliedSource: null,
    appliedKeyFingerprints: [],
    restartRequired: false,
  })),
  getPlaintextKeys: jest.fn(async () => ["sk-openai-1", "sk-openai-2"]),
} as any;

describe("LiteLlmProxyLoadBalancingSettingsService", () => {
  let service: LiteLlmProxyLoadBalancingSettingsService;
  let cacheState: Map<string, any>;
  let persisted: Record<string, any>;

  beforeEach(() => {
    jest.resetAllMocks();
    cacheState = new Map();
    persisted = {};

    securityMock.encodeSecretForStorage = jest.fn(
      async (plain: string) => plain,
    );

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

    openaiKeysMock.getPublicSettings = jest.fn(async () => ({
      source: "db",
      keysCount: 2,
      hasKeys: true,
      keyFingerprints: ["fp-openai-1", "fp-openai-2"],
      internalTokenConfigured: true,
      appliedAt: null,
      appliedSource: null,
      appliedKeyFingerprints: [],
      restartRequired: false,
    }));
    openaiKeysMock.getPlaintextKeys = jest.fn(async () => [
      "sk-openai-1",
      "sk-openai-2",
    ]);

    service = new LiteLlmProxyLoadBalancingSettingsService(
      prismaMock,
      cacheMock,
      envMock,
      securityMock,
      openaiKeysMock,
    );
  });

  it("returns disabled state when no DB config exists", async () => {
    const response = await service.getPublicSettings();

    expect(response.source).toBe("none");
    expect(response.enabled).toBe(false);
    expect(response.routingStrategy).toBe("simple-shuffle");
    expect(response.redisHost).toBe("redis");
    expect(response.redisPort).toBe(6379);
    expect(response.openai.keysCount).toBe(2);
  });

  it("stores and returns DB-managed proxy load balancing settings", async () => {
    const response = await service.updateSettings("org-1", "actor-1", {
      enabled: true,
      anthropicApiKeys: ["sk-ant-1", " sk-ant-2 "],
      routingStrategy: "least-busy",
      redisHost: "redis-internal",
      redisPort: 6380,
      redisPassword: "redis-secret",
      deploymentRpm: 120,
      deploymentTpm: 60000,
    });

    expect(response.source).toBe("db");
    expect(response.enabled).toBe(true);
    expect(response.routingStrategy).toBe("least-busy");
    expect(response.redisHost).toBe("redis-internal");
    expect(response.redisPort).toBe(6380);
    expect(response.hasRedisPassword).toBe(true);
    expect(response.anthropicKeysCount).toBe(2);
    expect(response.anthropicKeyFingerprints).toHaveLength(2);
    expect(response.deploymentRpm).toBe(120);
    expect(response.deploymentTpm).toBe(60000);
  });

  it("builds internal snapshot from DB config and OpenAI keys settings", async () => {
    await service.updateSettings("org-1", "actor-1", {
      enabled: true,
      anthropicApiKeys: ["sk-ant-1"],
      routingStrategy: "usage-based-routing",
      redisHost: "redis",
      redisPort: 6379,
      redisPassword: "secret",
      deploymentRpm: 100,
      deploymentTpm: 50000,
    });

    const snapshot = await service.getInternalSnapshot();

    expect(snapshot.hasStoredConfig).toBe(true);
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.openaiApiKeys).toEqual(["sk-openai-1", "sk-openai-2"]);
    expect(snapshot.anthropicApiKeys).toEqual(["sk-ant-1"]);
    expect(snapshot.routingStrategy).toBe("usage-based-routing");
    expect(snapshot.redisHost).toBe("redis");
    expect(snapshot.redisPort).toBe(6379);
    expect(snapshot.redisPassword).toBe("secret");
    expect(snapshot.deploymentRpm).toBe(100);
    expect(snapshot.deploymentTpm).toBe(50000);
  });

  it("resets DB config and returns disabled state", async () => {
    await service.updateSettings("org-1", "actor-1", {
      enabled: true,
      anthropicApiKeys: ["sk-ant-1"],
      routingStrategy: "least-busy",
      redisHost: "redis",
      redisPort: 6379,
      redisPassword: "",
      deploymentRpm: null,
      deploymentTpm: null,
    });

    const response = await service.resetToDisabled("org-1", "actor-1");

    expect(response.source).toBe("none");
    expect(response.enabled).toBe(false);
    expect(response.anthropicKeysCount).toBe(0);
    expect(response.hasRedisPassword).toBe(false);
  });
});
