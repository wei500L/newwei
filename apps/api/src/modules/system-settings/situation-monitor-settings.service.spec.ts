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
  let envConfig: any;
  let envExternalKeys: Record<string, string | undefined>;
  let securitySettingsMock: any;

  beforeEach(() => {
    jest.resetAllMocks();
    cacheState = null;
    persistedValue = undefined;
    envConfig = {
      enabled: true,
      baseUrl: "https://api.deeplx.org",
      apiKey: undefined,
      timeoutMs: 15_000,
      maxRetries: 2,
      fallbackEnabled: false,
      fallbackBaseUrl: undefined,
    };
    envExternalKeys = {
      SITUATION_MONITOR_FINNHUB_API_KEY: undefined,
      SITUATION_MONITOR_FRED_API_KEY: undefined,
      SITUATION_MONITOR_TELEGRAM_ENABLED: undefined,
      SITUATION_MONITOR_TELEGRAM_API_ID: undefined,
      SITUATION_MONITOR_TELEGRAM_API_HASH: undefined,
      SITUATION_MONITOR_TELEGRAM_SESSION: undefined,
      SITUATION_MONITOR_TELEGRAM_CHANNEL_SET: undefined,
      SITUATION_MONITOR_TELEGRAM_MAX_FEED_ITEMS: undefined,
      SITUATION_MONITOR_TELEGRAM_MAX_TEXT_CHARS: undefined,
      SITUATION_MONITOR_TELEGRAM_CHANNEL_TIMEOUT_MS: undefined,
      SITUATION_MONITOR_TELEGRAM_POLL_CYCLE_TIMEOUT_MS: undefined,
      SITUATION_MONITOR_TELEGRAM_STARTUP_DELAY_MS: undefined,
      SITUATION_MONITOR_TELEGRAM_RATE_LIMIT_MS: undefined,
      SITUATION_MONITOR_TELEGRAM_POLL_INTERVAL_MS: undefined,
    };
    securitySettingsMock = {
      encodeSecretForStorage: jest.fn(async (value: string) => value),
    };

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

    service = new SituationMonitorSettingsService(
      prismaMock,
      cacheMock,
      {
        get situationMonitorTranslationConfig() {
          return envConfig;
        },
        get<T>(key: string) {
          return envExternalKeys[key] as T;
        },
        get systemSettingsEncryptionKey() {
          return undefined;
        },
      } as any,
      securitySettingsMock,
    );
  });

  it("returns env defaults when no record exists", async () => {
    const response = await service.getPublicSettings();
    expect(response.source).toBe("env");
    expect(response.translationMaxConcurrency).toBe(2);
    expect(response.translationProvider).toBe("deeplx");
    expect(response.translationApiEnabled).toBe(true);
    expect(response.translationApiBaseUrl).toBe("https://api.deeplx.org");
    expect(response.translationFallbackApiEnabled).toBe(false);
    expect(response.translationFallbackApiBaseUrl).toBe("");
    expect(response.translationApiTimeoutMs).toBe(15_000);
    expect(response.translationApiMaxRetries).toBe(2);
    expect(response.hasTranslationApiKey).toBe(false);
    expect(response.translationApiKeySource).toBe("none");
    expect(response.hasFinnhubApiKey).toBe(false);
    expect(response.finnhubApiKeySource).toBe("none");
    expect(response.hasFredApiKey).toBe(false);
    expect(response.fredApiKeySource).toBe("none");
    expect(response.telegramEnabled).toBe(false);
    expect(response.telegramChannelSet).toBe("full");
    expect(response.telegramPollIntervalMs).toBe(60_000);
    expect(response.hasTelegramSession).toBe(false);
    expect(response.telegramSessionSource).toBe("none");
  });

  it("uses telegram env fallback when no stored telegram secret exists", async () => {
    envExternalKeys.SITUATION_MONITOR_TELEGRAM_ENABLED = "true";
    envExternalKeys.SITUATION_MONITOR_TELEGRAM_API_ID = "100001";
    envExternalKeys.SITUATION_MONITOR_TELEGRAM_API_HASH = "env-hash";
    envExternalKeys.SITUATION_MONITOR_TELEGRAM_SESSION = "env-session";
    envExternalKeys.SITUATION_MONITOR_TELEGRAM_CHANNEL_SET = "tech";
    envExternalKeys.SITUATION_MONITOR_TELEGRAM_POLL_INTERVAL_MS = "90000";

    const response = await service.getPublicSettings();
    expect(response.telegramEnabled).toBe(true);
    expect(response.hasTelegramApiId).toBe(true);
    expect(response.telegramApiIdSource).toBe("env");
    expect(response.hasTelegramApiHash).toBe(true);
    expect(response.telegramApiHashSource).toBe("env");
    expect(response.hasTelegramSession).toBe(true);
    expect(response.telegramSessionSource).toBe("env");
    expect(response.telegramChannelSet).toBe("tech");
    expect(response.telegramPollIntervalMs).toBe(90_000);

    const runtime = await service.getTelegramRuntimeConfig();
    expect(runtime.apiId).toBe("100001");
    expect(runtime.apiHash).toBe("env-hash");
    expect(runtime.session).toBe("env-session");
    expect(runtime.channelSet).toBe("tech");
    expect(runtime.pollIntervalMs).toBe(90_000);
  });

  it("stores overrides and returns db source", async () => {
    const response = await service.updateSettings("org-1", "actor-1", {
      translationMaxConcurrency: 3,
      translationApiEnabled: true,
      translationApiBaseUrl: "https://api.deeplx.org",
      translationApiKey: "test-key",
      translationFallbackApiEnabled: true,
      translationFallbackApiBaseUrl: "https://translates.shisihua.dpdns.org/fallback/v1",
      finnhubApiKey: "finnhub-key",
      fredApiKey: "fred-key",
      translationApiTimeoutMs: 8_000,
      translationApiMaxRetries: 1,
      telegramEnabled: true,
      telegramApiId: "2222",
      telegramApiHash: "telegram-hash",
      telegramSession: "telegram-session",
      telegramChannelSet: "finance",
      telegramMaxFeedItems: 260,
      telegramMaxTextChars: 1200,
      telegramChannelTimeoutMs: 9000,
      telegramPollCycleTimeoutMs: 210_000,
      telegramStartupDelayMs: 45_000,
      telegramRateLimitMs: 1200,
      telegramPollIntervalMs: 75_000,
    });

    expect(response.source).toBe("db");
    expect(response.translationMaxConcurrency).toBe(3);
    expect(response.translationApiTimeoutMs).toBe(8_000);
    expect(response.translationApiMaxRetries).toBe(1);
    expect(response.translationFallbackApiEnabled).toBe(true);
    expect(response.translationFallbackApiBaseUrl).toBe("https://translates.shisihua.dpdns.org/fallback/v1");
    expect(response.hasTranslationApiKey).toBe(true);
    expect(response.translationApiKeySource).toBe("stored");
    expect(response.hasFinnhubApiKey).toBe(true);
    expect(response.finnhubApiKeySource).toBe("stored");
    expect(response.hasFredApiKey).toBe(true);
    expect(response.fredApiKeySource).toBe("stored");
    expect(response.telegramEnabled).toBe(true);
    expect(response.telegramChannelSet).toBe("finance");
    expect(response.telegramPollIntervalMs).toBe(75_000);
    expect(response.hasTelegramApiId).toBe(true);
    expect(response.telegramApiIdSource).toBe("stored");
    expect(response.hasTelegramApiHash).toBe(true);
    expect(response.telegramApiHashSource).toBe("stored");
    expect(response.hasTelegramSession).toBe(true);
    expect(response.telegramSessionSource).toBe("stored");
    expect(persistedValue?.translationMaxConcurrency).toBe(3);
    expect(persistedValue?.translationApiBaseUrl).toBe("https://api.deeplx.org");
    expect(persistedValue?.translationApiKey).toBe("test-key");
    expect(persistedValue?.translationFallbackApiEnabled).toBe(true);
    expect(persistedValue?.translationFallbackApiBaseUrl).toBe("https://translates.shisihua.dpdns.org/fallback/v1");
    expect(persistedValue?.finnhubApiKey).toBe("finnhub-key");
    expect(persistedValue?.fredApiKey).toBe("fred-key");
    expect(persistedValue?.telegramEnabled).toBe(true);
    expect(persistedValue?.telegramApiId).toBe("2222");
    expect(persistedValue?.telegramChannelSet).toBe("finance");
    expect(persistedValue?.telegramPollIntervalMs).toBe(75_000);
    expect(securitySettingsMock.encodeSecretForStorage).toHaveBeenCalledWith("test-key");
    expect(securitySettingsMock.encodeSecretForStorage).toHaveBeenCalledWith("finnhub-key");
    expect(securitySettingsMock.encodeSecretForStorage).toHaveBeenCalledWith("fred-key");
    expect(securitySettingsMock.encodeSecretForStorage).toHaveBeenCalledWith("telegram-hash");
    expect(securitySettingsMock.encodeSecretForStorage).toHaveBeenCalledWith("telegram-session");
  });

  it("ignores env api keys when no stored key exists", async () => {
    envConfig.apiKey = "env-key";
    envExternalKeys.SITUATION_MONITOR_FINNHUB_API_KEY = "env-finnhub-key";
    envExternalKeys.SITUATION_MONITOR_FRED_API_KEY = "env-fred-key";

    const response = await service.getPublicSettings();
    expect(response.hasTranslationApiKey).toBe(false);
    expect(response.translationApiKeySource).toBe("none");
    expect(response.hasFinnhubApiKey).toBe(false);
    expect(response.finnhubApiKeySource).toBe("none");
    expect(response.hasFredApiKey).toBe(false);
    expect(response.fredApiKeySource).toBe("none");

    const translationRuntime = await service.getTranslationRuntimeConfig();
    expect(translationRuntime.apiKey).toBeUndefined();

    const externalRuntime = await service.getExternalApiRuntimeConfig();
    expect(externalRuntime.finnhubApiKey).toBeUndefined();
    expect(externalRuntime.fredApiKey).toBeUndefined();
  });

  it("resets to env defaults", async () => {
    await service.updateSettings("org-1", "actor-1", {
      translationMaxConcurrency: 4,
      translationApiKey: "stored-key",
    });

    const response = await service.resetToEnv("org-1", "actor-1");
    expect(response.source).toBe("env");
    expect(response.translationMaxConcurrency).toBe(2);
    expect(response.hasTranslationApiKey).toBe(false);
    expect(response.hasFinnhubApiKey).toBe(false);
    expect(response.hasFredApiKey).toBe(false);
    expect(persistedValue).toBeUndefined();
  });

  it("falls back to defaults when stored values are invalid", async () => {
    persistedValue = {
      translationMaxConcurrency: "nope",
      translationApiEnabled: "nope",
      translationApiBaseUrl: "",
      translationFallbackApiEnabled: "bad",
      translationFallbackApiBaseUrl: "",
      translationApiTimeoutMs: "bad",
      translationApiMaxRetries: -999,
      finnhubApiKey: " ",
      fredApiKey: " ",
    };
    const response = await service.getPublicSettings();
    expect(response.source).toBe("db");
    expect(response.translationMaxConcurrency).toBe(2);
    expect(response.translationApiEnabled).toBe(true);
    expect(response.translationApiBaseUrl).toBe("https://api.deeplx.org");
    expect(response.translationFallbackApiEnabled).toBe(false);
    expect(response.translationFallbackApiBaseUrl).toBe("");
    expect(response.translationApiTimeoutMs).toBe(15_000);
    expect(response.translationApiMaxRetries).toBe(0);
    expect(response.hasFinnhubApiKey).toBe(false);
    expect(response.finnhubApiKeySource).toBe("none");
    expect(response.hasFredApiKey).toBe(false);
    expect(response.fredApiKeySource).toBe("none");
  });

  it("clears stored key when translationApiKey is null", async () => {
    await service.updateSettings("org-1", "actor-1", {
      translationMaxConcurrency: 3,
      translationApiKey: "stored-key",
    });

    const response = await service.updateSettings("org-1", "actor-1", {
      translationMaxConcurrency: 3,
      translationApiKey: null,
    });

    expect(response.hasTranslationApiKey).toBe(false);
    expect(response.translationApiKeySource).toBe("none");
    expect(persistedValue.translationApiKey).toBeNull();
  });

  it("clears stored external keys without falling back to env keys", async () => {
    envExternalKeys.SITUATION_MONITOR_FINNHUB_API_KEY = "env-finnhub-key";
    envExternalKeys.SITUATION_MONITOR_FRED_API_KEY = "env-fred-key";

    await service.updateSettings("org-1", "actor-1", {
      translationMaxConcurrency: 3,
      finnhubApiKey: "stored-finnhub-key",
      fredApiKey: "stored-fred-key",
    });

    const response = await service.updateSettings("org-1", "actor-1", {
      translationMaxConcurrency: 3,
      finnhubApiKey: null,
      fredApiKey: null,
    });

    expect(response.hasFinnhubApiKey).toBe(false);
    expect(response.finnhubApiKeySource).toBe("none");
    expect(response.hasFredApiKey).toBe(false);
    expect(response.fredApiKeySource).toBe("none");
    expect(persistedValue.finnhubApiKey).toBeNull();
    expect(persistedValue.fredApiKey).toBeNull();
  });

  it("validates fallback endpoint URL", async () => {
    await expect(
      service.updateSettings("org-1", "actor-1", {
        translationMaxConcurrency: 3,
        translationFallbackApiBaseUrl: "not-a-url",
      })
    ).rejects.toThrow("translationFallbackApiBaseUrl must be a valid http(s) URL");
  });
});
