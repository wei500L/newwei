import { RealtimeSignalsSettingsService } from "./realtime-signals-settings.service";

const REALTIME_SIGNALS_SETTINGS_KEY = "realtime_signals_settings";
const ACLED_AUTH_STATE_KEY = "realtime_signals_acled_auth_state";

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

  it("refreshes ACLED token from env OAuth credentials and persists derived state", async () => {
    envConfig.credentials.acledOauthUsername = "env-user@example.com";
    envConfig.credentials.acledOauthPassword = "env-password";
    envConfig.credentials.acledOauthClientId = "acled";
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        access_token: "derived-token",
        expires_in: 3600,
      }),
    } as any);

    const runtime = await service.getRuntimeConfig();

    expect(runtime.credentials.acledAccessToken).toBe("derived-token");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://acleddata.com/oauth/token",
      expect.objectContaining({
        body: "username=env-user%40example.com&password=env-password&grant_type=password&client_id=acled",
        method: "POST",
      }),
    );
    expect(store.get(ACLED_AUTH_STATE_KEY)).toMatchObject({
      accessToken: "derived-token",
      lastError: null,
      lastAttemptAt: expect.any(String),
      version: 1,
    });
  });

  it("clears stale auth state and eagerly refreshes when OAuth credentials change", async () => {
    store.set(REALTIME_SIGNALS_SETTINGS_KEY, {
      enabled: true,
      acledOauthUsername: "old-user@example.com",
      acledOauthPassword: "old-password",
      acledOauthClientId: "acled",
    });
    store.set(ACLED_AUTH_STATE_KEY, {
      version: 1,
      accessToken: "stale-token",
      expiresAt: "2030-01-01T00:00:00.000Z",
      refreshedAt: "2030-01-01T00:00:00.000Z",
      lastAttemptAt: "2030-01-01T00:00:00.000Z",
      lastError: null,
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        access_token: "fresh-token",
        expires_in: 7200,
      }),
    } as any);

    const result = await service.updateSettings("org-1", "user-1", {
      acledOauthUsername: "new-user@example.com",
      acledOauthPassword: "new-password",
      acledOauthClientId: "acled",
    });

    expect(result.acledOauthUsername).toBe("new-user@example.com");
    expect(result.acledAccessTokenStatus).toBe("ready");
    expect(store.get(REALTIME_SIGNALS_SETTINGS_KEY)).toMatchObject({
      acledOauthUsername: "new-user@example.com",
      acledOauthPassword: "new-password",
      acledOauthClientId: "acled",
    });
    expect(store.get(ACLED_AUTH_STATE_KEY)).toMatchObject({
      accessToken: "fresh-token",
      lastError: null,
      lastAttemptAt: expect.any(String),
      version: 1,
    });
  });

  it("does not fall back to a legacy ACLED token when OAuth credentials are missing", async () => {
    global.fetch = jest.fn();

    const runtime = await service.getRuntimeConfig();

    expect(runtime.credentials.acledAccessToken).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("respects refresh cooldown after an ACLED OAuth failure", async () => {
    envConfig.credentials.acledOauthUsername = "env-user@example.com";
    envConfig.credentials.acledOauthPassword = "env-password";
    envConfig.credentials.acledOauthClientId = "acled";
    const now = Date.parse("2026-03-11T00:00:00.000Z");
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(now);
    store.set(ACLED_AUTH_STATE_KEY, {
      version: 1,
      accessToken: null,
      expiresAt: null,
      refreshedAt: null,
      lastAttemptAt: new Date(now - 60_000).toISOString(),
      lastError: "bad credentials",
    });
    global.fetch = jest.fn();

    const result = await service.getPublicSettings();

    expect(result.acledAccessTokenStatus).toBe("refresh_failed");
    expect(result.acledAccessTokenLastAttemptAt).toBe(
      new Date(now - 60_000).toISOString(),
    );
    expect(global.fetch).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });
});
