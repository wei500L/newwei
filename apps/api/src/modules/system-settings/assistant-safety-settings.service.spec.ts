import { AssistantSafetySettingsService } from "./assistant-safety-settings.service";

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
  assistantConfig: {
    guardrailsEnabled: true,
    guardrails: ["openai-moderation-pre"],
  },
} as any;

describe("AssistantSafetySettingsService", () => {
  let service: AssistantSafetySettingsService;
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
      return { key: "assistant_safety", value: persistedValue };
    });
    prismaMock.systemSetting.upsert = jest.fn(async (args: any) => {
      persistedValue = args.create?.value ?? args.update?.value;
      return { key: "assistant_safety", value: persistedValue };
    });
    prismaMock.systemSetting.deleteMany = jest.fn(async () => {
      persistedValue = undefined;
      return { count: 1 };
    });
    prismaMock.auditLog.create = jest.fn().mockResolvedValue(undefined);
    prismaMock.auditLogOutbox.create = jest.fn().mockResolvedValue(undefined);

    service = new AssistantSafetySettingsService(prismaMock, cacheMock, envMock);
  });

  it("returns env defaults when no record exists", async () => {
    const response = await service.getPublicSettings();
    expect(response.source).toBe("env");
    expect(response.enabled).toBe(true);
    expect(response.outputModerationEnabled).toBe(false);
    expect(response.guardrails).toEqual(["openai-moderation-pre"]);
  });

  it("persists settings and returns db source", async () => {
    const response = await service.updateSettings("org-1", "actor-1", {
      enabled: false,
      outputModerationEnabled: true,
    });

    expect(response.source).toBe("db");
    expect(response.enabled).toBe(false);
    expect(response.guardrails).toEqual([]);
  });

  it("enables output moderation and includes post guardrail", async () => {
    const response = await service.updateSettings("org-1", "actor-1", {
      enabled: true,
      outputModerationEnabled: true,
    });

    expect(response.enabled).toBe(true);
    expect(response.guardrails).toEqual(["openai-moderation-pre", "openai-moderation-post"]);
  });

  it("resets stored settings to env", async () => {
    await service.updateSettings("org-1", "actor-1", {
      enabled: false,
      outputModerationEnabled: false,
    });

    const response = await service.resetToEnv("org-1", "actor-1");
    expect(response.source).toBe("env");
    expect(response.enabled).toBe(true);
    expect(response.guardrails).toEqual(["openai-moderation-pre"]);
  });
});

