import { RealtimeSignalsSettingsService } from "./realtime-signals-settings.service";

const REALTIME_SIGNALS_SETTINGS_KEY = "realtime_signals_settings";
const ACLED_AUTH_STATE_KEY = "realtime_signals_acled_auth_state";
const ACLED_DISABLED_REASON = "Open myACLED does not include API access.";

const baseEnvConfig = {
  enabled: true,
  requestTimeoutMs: 12_000,
  maxRetries: 1,
  sources: {
    adsb: { enabled: true, intervalSec: 600 },
    ais: { enabled: true, intervalSec: 600 },
    unrest: { enabled: true, intervalSec: 600 },
    outages: { enabled: true, intervalSec: 600 },
    keywordSpike: { enabled: true, intervalSec: 600 },
    pizzint: { enabled: true, intervalSec: 600 },
    gdeltTension: { enabled: true, intervalSec: 600 },
    polymarketLeads: { enabled: true, intervalSec: 600 },
  },
  thresholds: {
    keywordSpikeMinCount: 5,
    keywordSpikeMultiplier: 3,
    predictionShiftThreshold: 5,
    predictionNewsActivityThreshold: 3,
  },
  relay: {},
  adsb: { baseUrl: "https://api.adsb.lol" },
  credentials: {
    aisApiKey: undefined,
    acledOauthUsername: undefined,
    acledOauthPassword: undefined,
    acledOauthClientId: undefined,
    cloudflareApiToken: undefined,
    wingbitsApiKey: undefined,
  },
  polymarket: {},
};

describe("RealtimeSignalsSettingsService", () => {
  let service: RealtimeSignalsSettingsService;
  let envConfig: any;
  let store: Map<string, unknown>;
  let cacheStore: Map<string, unknown>;
  let prismaMock: any;
  let cacheMock: any;
  let securitySettingsMock: any;
  let envMock: any;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    envConfig = structuredClone(baseEnvConfig);
    store = new Map<string, unknown>();
    cacheStore = new Map<string, unknown>();
    originalFetch = global.fetch;

    prismaMock = {
      systemSetting: {
        findUnique: jest.fn(async ({ where }: { where: { key: string } }) => {
          const value = store.get(where.key);
          return value === undefined ? null : { key: where.key, value };
        }),
        upsert: jest.fn(async (args: any) => {
          const key = args.where.key as string;
          const value = args.create?.value ?? args.update?.value;
          store.set(key, value);
          return { key, value };
        }),
        deleteMany: jest.fn(
          async ({ where }: { where: { key: string | { in: string[] } } }) => {
            const key = where.key;
            if (typeof key === "string") {
              store.delete(key);
              return { count: 1 };
            }
            for (const item of key.in) {
              store.delete(item);
            }
            return { count: key.in.length };
          },
        ),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue(undefined),
      },
      auditLogOutbox: {
        create: jest.fn().mockResolvedValue({ id: "outbox-1" }),
      },
    };

    cacheMock = {
      get: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
      set: jest.fn(async (key: string, value: unknown) => {
        cacheStore.set(key, value);
      }),
      del: jest.fn(async (key: string) => {
        cacheStore.delete(key);
      }),
      withLock: jest.fn(
        async (_key: string, _ttlMs: number, runner: () => Promise<unknown>) =>
          runner(),
      ),
    };

    securitySettingsMock = {
      encodeSecretForStorage: jest.fn(async (value: string) => value),
    };

    envMock = {
      get realtimeSignalsConfig() {
        return envConfig;
      },
      get systemSettingsEncryptionKey() {
        return undefined;
      },
    };

    service = new RealtimeSignalsSettingsService(
      prismaMock,
      cacheMock,
      envMock,
      securitySettingsMock,
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("reports ACLED API as disabled and never refreshes tokens in public settings", async () => {
    envConfig.credentials.acledOauthUsername = "env-user@example.com";
    envConfig.credentials.acledOauthPassword = "env-password";
    envConfig.credentials.acledOauthClientId = "acled";
    store.set(ACLED_AUTH_STATE_KEY, {
      version: 1,
      accessToken: "derived-token",
      expiresAt: "2030-01-01T00:00:00.000Z",
      refreshedAt: "2030-01-01T00:00:00.000Z",
      lastAttemptAt: "2030-01-01T00:00:00.000Z",
      lastError: null,
    });
    global.fetch = jest.fn();

    const response = await service.getPublicSettings();

    expect(response.acledApiEnabled).toBe(false);
    expect(response.acledApiDisabledReason).toBe(ACLED_DISABLED_REASON);
    expect(response.hasAcledAccessToken).toBe(false);
    expect(response.acledAccessTokenStatus).toBe("missing");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("omits ACLED runtime tokens even when OAuth credentials and stored auth state exist", async () => {
    envConfig.credentials.acledOauthUsername = "env-user@example.com";
    envConfig.credentials.acledOauthPassword = "env-password";
    envConfig.credentials.acledOauthClientId = "acled";
    store.set(ACLED_AUTH_STATE_KEY, {
      version: 1,
      accessToken: "derived-token",
      expiresAt: "2030-01-01T00:00:00.000Z",
      refreshedAt: "2030-01-01T00:00:00.000Z",
      lastAttemptAt: "2030-01-01T00:00:00.000Z",
      lastError: null,
    });
    global.fetch = jest.fn();

    const runtime = await service.getRuntimeConfig();

    expect(runtime.capabilities).toEqual({
      acledApiEnabled: false,
      acledApiDisabledReason: ACLED_DISABLED_REASON,
    });
    expect(runtime.credentials.acledAccessToken).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("stores ACLED credentials without clearing auth state or refreshing while disabled", async () => {
    store.set(ACLED_AUTH_STATE_KEY, {
      version: 1,
      accessToken: "stale-token",
      expiresAt: "2030-01-01T00:00:00.000Z",
      refreshedAt: "2030-01-01T00:00:00.000Z",
      lastAttemptAt: "2030-01-01T00:00:00.000Z",
      lastError: "403",
    });
    global.fetch = jest.fn();

    const result = await service.updateSettings("org-1", "user-1", {
      acledOauthUsername: "new-user@example.com",
      acledOauthPassword: "new-password",
      acledOauthClientId: "acled",
    });

    expect(result.acledApiEnabled).toBe(false);
    expect(result.acledOauthUsername).toBe("new-user@example.com");
    expect(result.acledAccessTokenStatus).toBe("missing");
    expect(store.get(REALTIME_SIGNALS_SETTINGS_KEY)).toMatchObject({
      acledOauthUsername: "new-user@example.com",
      acledOauthPassword: "new-password",
      acledOauthClientId: "acled",
    });
    expect(store.get(ACLED_AUTH_STATE_KEY)).toMatchObject({
      accessToken: "stale-token",
      lastError: "403",
      version: 1,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns undefined for forced ACLED token refresh while the API is disabled", async () => {
    envConfig.credentials.acledOauthUsername = "env-user@example.com";
    envConfig.credentials.acledOauthPassword = "env-password";
    global.fetch = jest.fn();

    const token = await service.forceRefreshAcledAccessToken();

    expect(token).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
