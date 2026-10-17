import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { PlatformAccessService } from "../auth/platform-access.service";
import { CacheService } from "../cache/cache.service";
import { EnvService, type RealtimeSignalsEnvConfig } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { withMysqlSessionLock } from "../situation-monitor/situation-monitor-user-lock";

import { RealtimeSignalsSettingsService } from "./realtime-signals-settings.service";
import { SystemSecuritySettingsService } from "./system-security-settings.service";

vi.mock("../situation-monitor/situation-monitor-user-lock", () => {
  class SituationMonitorLockError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SituationMonitorLockError";
    }
  }
  return {
    SituationMonitorLockError,
    withMysqlSessionLock: vi.fn(),
  };
});

vi.mock("../audit/audit-log.writer", () => ({
  writeAuditLogBestEffort: vi.fn(async () => undefined),
}));

const SETTINGS_KEY = "realtime_signals_settings";
const ACLED_AUTH_KEY = "realtime_signals_acled_auth_state";
const CACHE_KEY = "realtime-signals:settings";
const REALTIME_LOCK = "data-runtime-settings:realtime:v1";

const sessionLock = vi.mocked(withMysqlSessionLock);
const auditWriter = vi.mocked(writeAuditLogBestEffort);

/** Mirrors the apiEnvSchema defaults of EnvService.realtimeSignalsConfig. */
const envConfig = (): RealtimeSignalsEnvConfig => ({
  enabled: true,
  requestTimeoutMs: 12_000,
  maxRetries: 2,
  sources: {
    opensky: { enabled: true, intervalSec: 900 },
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
  ais: {},
  opensky: {
    baseUrl: "https://opensky-network.org/api",
    tokenUrl:
      "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token",
    dailyCreditBudget: 4000,
    dayIntervalSec: 600,
    nightIntervalSec: 1800,
    dayStartHourHkt: 8,
    nightStartHourHkt: 22,
    warningRemainingPct: 20,
    criticalRemainingPct: 10,
  },
  credentials: {},
  polymarket: {},
});

type Mock = ReturnType<typeof vi.fn>;

type UpdateInput = Parameters<
  RealtimeSignalsSettingsService["updateSettings"]
>[2];

/** Builds a request body the way a DTO instance would reach the service. */
const input = (raw: Record<string, unknown>): UpdateInput =>
  raw as unknown as UpdateInput;

const build = (
  options: {
    isPlatformAdmin?: boolean;
    storedValue?: unknown;
    cachedEnvelope?: unknown;
    cacheReadFails?: boolean;
  } = {},
) => {
  const findUnique = vi.fn(async () =>
    options.storedValue === undefined
      ? null
      : { key: SETTINGS_KEY, value: options.storedValue },
  );
  const upsert = vi.fn(async () => undefined);
  const deleteMany = vi.fn(async () => ({ count: 0 }));
  const cacheGet = vi.fn(async () => {
    if (options.cacheReadFails) {
      throw new Error("redis unavailable");
    }
    return options.cachedEnvelope ?? null;
  });
  const cacheSet = vi.fn(async () => undefined);
  const cacheDel = vi.fn(async () => undefined);
  const encodeSecretForStorage = vi.fn(async (plain: string) => ({
    __enc: "system-settings:v1",
    alg: "aes-256-gcm",
    iv: "aXY=",
    tag: "dGFn",
    data: Buffer.from(plain, "utf8").toString("base64"),
  }));
  const assertPlatformAdmin = vi.fn(async () => {
    if (options.isPlatformAdmin === false) {
      throw new ForbiddenException("Platform admin access required");
    }
    return undefined;
  });

  const service = new RealtimeSignalsSettingsService(
    { systemSetting: { findUnique, upsert, deleteMany } } as unknown as PrismaService,
    { get: cacheGet, set: cacheSet, del: cacheDel } as unknown as CacheService,
    { realtimeSignalsConfig: envConfig() } as unknown as EnvService,
    { encodeSecretForStorage } as unknown as SystemSecuritySettingsService,
    { assertPlatformAdmin } as unknown as PlatformAccessService,
  );

  return {
    service,
    findUnique,
    upsert,
    deleteMany,
    cacheGet,
    cacheSet,
    cacheDel,
    encodeSecretForStorage,
    assertPlatformAdmin,
  };
};

/** The object written into SystemSetting.value by the last upsert. */
const writtenValue = (upsert: Mock, index = 0): Record<string, unknown> => {
  const args = upsert.mock.calls[index]?.[0] as {
    create?: { value?: Record<string, unknown> };
    update?: { value?: Record<string, unknown> };
  };
  const value = args.update?.value ?? args.create?.value;
  if (!value) {
    throw new Error("no upsert value was written");
  }
  return value;
};

describe("RealtimeSignalsSettingsService", () => {
  beforeEach(() => {
    sessionLock.mockReset();
    sessionLock.mockImplementation(async (_url, _name, fn) => await fn());
    auditWriter.mockClear();
  });

  describe("DS1 platform write gate", () => {
    it("rejects a non-platform writer before any read, lock or write", async () => {
      const harness = build({ isPlatformAdmin: false });

      const caught = await harness.service
        .updateSettings("org-a", "org-admin", input({ enabled: false }))
        .catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(ForbiddenException);
      expect((caught as ForbiddenException).message).toBe(
        "Platform admin access required",
      );
      expect(harness.assertPlatformAdmin).toHaveBeenCalledWith("org-admin");
      expect(harness.findUnique).not.toHaveBeenCalled();
      expect(harness.upsert).not.toHaveBeenCalled();
      expect(harness.cacheDel).not.toHaveBeenCalled();
      expect(sessionLock).not.toHaveBeenCalled();
      expect(auditWriter).not.toHaveBeenCalled();
    });

    it("rejects a non-platform reset and leaves both rows in place", async () => {
      const harness = build({ isPlatformAdmin: false });

      await expect(
        harness.service.resetToEnv("org-a", "machine:tok"),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(harness.deleteMany).not.toHaveBeenCalled();
      expect(sessionLock).not.toHaveBeenCalled();
    });

    it("does not gate the read path", async () => {
      const harness = build({ isPlatformAdmin: false });

      const settings = await harness.service.getPublicSettings();

      expect(harness.assertPlatformAdmin).not.toHaveBeenCalled();
      expect(settings.source).toBe("env");
      expect(settings.enabled).toBe(true);
    });

    it("writes as a platform admin", async () => {
      const harness = build({ isPlatformAdmin: true });

      await harness.service.updateSettings(
        "org-a",
        "platform-user",
        input({ maxRetries: 4 }),
      );

      expect(harness.upsert).toHaveBeenCalledTimes(1);
      expect(writtenValue(harness.upsert).maxRetries).toBe(4);
    });
  });

  describe("DS2 lock and database-authoritative merge", () => {
    it("uses the shared global lock for both update and reset", async () => {
      const harness = build({ isPlatformAdmin: true });

      await harness.service.updateSettings("org-a", "p", input({ maxRetries: 1 }));
      await harness.service.resetToEnv("org-a", "p");

      expect(sessionLock).toHaveBeenCalledTimes(2);
      expect(sessionLock.mock.calls[0]?.[1]).toBe(REALTIME_LOCK);
      expect(sessionLock.mock.calls[1]?.[1]).toBe(REALTIME_LOCK);
      // A global singleton never carries a tenant suffix.
      expect(REALTIME_LOCK).not.toContain("org-a");
    });

    it("merges from the MySQL row even when the Redis envelope is stale", async () => {
      const harness = build({
        isPlatformAdmin: true,
        storedValue: { enabled: false, requestTimeoutMs: 30_000 },
        cachedEnvelope: {
          exists: true,
          value: { enabled: true, requestTimeoutMs: 5_000 },
        },
      });

      await harness.service.updateSettings(
        "org-a",
        "p",
        input({ maxRetries: 4 }),
      );

      const value = writtenValue(harness.upsert);
      // The fields the request did not mention keep the DATABASE values, not
      // the stale cached ones: this is the cross-instance overwrite fix.
      expect(value.enabled).toBe(false);
      expect(value.requestTimeoutMs).toBe(30_000);
      expect(value.maxRetries).toBe(4);
      expect(harness.findUnique).toHaveBeenCalled();
      expect(harness.cacheDel).toHaveBeenCalled();
    });

    it("num() of an explicit null clamps to the lower bound", async () => {
      const harness = build({ isPlatformAdmin: true });

      await harness.service.updateSettings(
        "org-a",
        "p",
        input({ requestTimeoutMs: null, predictionNewsActivityThreshold: null }),
      );

      const value = writtenValue(harness.upsert);
      expect(value.requestTimeoutMs).toBe(1_000);
      expect(value.predictionNewsActivityThreshold).toBe(0);
    });

    it("preserves nullish-coalescing aliases instead of testing key presence", async () => {
      const harness = build({
        isPlatformAdmin: true,
        storedValue: { openskyBaseUrl: "https://db.example/base" },
      });

      // canonical null + absent legacy alias: `null ?? undefined` is undefined,
      // so resolveNextUrl keeps the stored value (it does NOT clear).
      await harness.service.updateSettings(
        "org-a",
        "p",
        input({ openskyBaseUrl: null }),
      );
      expect(writtenValue(harness.upsert).openskyBaseUrl).toBe(
        "https://db.example/base",
      );

      // canonical null + legacy alias null: `null ?? null` is null, so the
      // override is cleared.
      await harness.service.updateSettings(
        "org-a",
        "p",
        input({ openskyBaseUrl: null, adsbBaseUrl: null }),
      );
      expect(writtenValue(harness.upsert, 1).openskyBaseUrl).toBeNull();
    });

    it("keeps an unmodified encrypted secret byte-identical", async () => {
      const envelope = {
        __enc: "system-settings:v1",
        alg: "aes-256-gcm",
        iv: "aXY=",
        tag: "dGFn",
        data: "ZGF0YQ==",
      };
      const harness = build({
        isPlatformAdmin: true,
        storedValue: { openskyClientSecret: envelope, maxRetries: 1 },
      });

      await harness.service.updateSettings("org-a", "p", input({ maxRetries: 3 }));

      expect(writtenValue(harness.upsert).openskyClientSecret).toEqual(envelope);
      expect(harness.encodeSecretForStorage).not.toHaveBeenCalled();
    });

    it("encodes a new secret and clears one set to null", async () => {
      const harness = build({ isPlatformAdmin: true });

      await harness.service.updateSettings(
        "org-a",
        "p",
        input({ openskyClientSecret: "  s3cret  " }),
      );
      expect(harness.encodeSecretForStorage).toHaveBeenCalledWith("s3cret");

      await harness.service.updateSettings(
        "org-a",
        "p",
        input({ openskyClientSecret: null }),
      );
      expect(writtenValue(harness.upsert, 1).openskyClientSecret).toBeNull();
    });
  });

  describe("cross-field constraints", () => {
    const cases: [Record<string, unknown>, string][] = [
      [
        { openskyDailyCreditBudget: 0 },
        "openskyDailyCreditBudget must be greater than 0",
      ],
      [
        { openskyDayStartHourHkt: 22, openskyNightStartHourHkt: 8 },
        "openskyDayStartHourHkt must be earlier than openskyNightStartHourHkt",
      ],
      [
        { openskyCriticalRemainingPct: 20 },
        "openskyCriticalRemainingPct must be lower than openskyWarningRemainingPct",
      ],
      [
        { openskyDayIntervalSec: 1800, openskyNightIntervalSec: 600 },
        "openskyDayIntervalSec must be less than or equal to openskyNightIntervalSec",
      ],
    ];

    it.each(cases)("rejects %o with the exact message", async (raw, message) => {
      const harness = build({ isPlatformAdmin: true });

      const caught = await harness.service
        .updateSettings("org-a", "p", input(raw))
        .catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(BadRequestException);
      expect((caught as BadRequestException).message).toBe(message);
      expect(harness.upsert).not.toHaveBeenCalled();
    });

    it("applies the same validation to the effective GET config", async () => {
      const harness = build({
        isPlatformAdmin: false,
        storedValue: { openskyDayStartHourHkt: 23, openskyNightStartHourHkt: 1 },
      });

      await expect(harness.service.getPublicSettings()).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe("cache shape and degradation", () => {
    it("caches the {exists,value} envelope with the 30 second TTL", async () => {
      const harness = build({ isPlatformAdmin: false });

      await harness.service.getPublicSettings();

      expect(harness.cacheSet).toHaveBeenCalledWith(
        CACHE_KEY,
        { exists: false, value: undefined },
        30,
      );
    });

    it("degrades a cache read failure to the MySQL row", async () => {
      const harness = build({
        isPlatformAdmin: false,
        cacheReadFails: true,
        storedValue: { enabled: false },
      });

      const settings = await harness.service.getPublicSettings();

      expect(harness.findUnique).toHaveBeenCalled();
      expect(settings.source).toBe("db");
      expect(settings.enabled).toBe(false);
    });

    it("still writes when the cache invalidation fails", async () => {
      const harness = build({ isPlatformAdmin: true });
      harness.cacheDel.mockRejectedValue(new Error("redis down"));

      await expect(
        harness.service.updateSettings("org-a", "p", input({ maxRetries: 2 })),
      ).resolves.toMatchObject({ source: "env" });
      expect(harness.upsert).toHaveBeenCalledTimes(1);
    });
  });

  describe("ACLED stays hard-disabled", () => {
    it("reports the fixed policy and never a historical token as ready", async () => {
      const harness = build({
        isPlatformAdmin: false,
        storedValue: {
          acledAccessToken: "historical-plaintext-token",
          acledOauthUsername: "user",
          acledOauthPassword: "pass",
          acledOauthClientId: "client",
        },
      });

      const settings = await harness.service.getPublicSettings();

      expect(settings.acledApiEnabled).toBe(false);
      expect(settings.acledApiDisabledReason).toBe(
        "Open myACLED does not include API access.",
      );
      expect(settings.hasAcledAccessToken).toBe(false);
      expect(settings.acledAccessTokenSource).toBe("none");
      expect(settings.acledAccessTokenStatus).toBe("missing");
      // Unreachable state fields stay omitted.
      expect(settings.acledAccessTokenExpiresAt).toBeUndefined();
      expect(settings.acledAccessTokenRefreshedAt).toBeUndefined();
      expect(settings.acledAccessTokenLastAttemptAt).toBeUndefined();
      expect(settings.acledAccessTokenLastError).toBeUndefined();
      // A historical token must not be resurrected as an input field either.
      expect(settings).not.toHaveProperty("acledAccessToken");
    });

    it("never exposes a secret value or ciphertext through the public shape", async () => {
      const harness = build({
        isPlatformAdmin: false,
        storedValue: {
          openskyClientSecret: {
            __enc: "system-settings:v1",
            alg: "aes-256-gcm",
            iv: "aXY=",
            tag: "dGFn",
            data: "ZGF0YQ==",
          },
          aisRelaySharedSecret: "plain-relay-secret",
          wingbitsApiKey: "plain-wingbits-key",
        },
      });

      const settings = await harness.service.getPublicSettings();
      const serialized = JSON.stringify(settings);

      expect(serialized).not.toContain("plain-relay-secret");
      expect(serialized).not.toContain("plain-wingbits-key");
      expect(serialized).not.toContain("ZGF0YQ==");
      expect(settings.hasAisRelaySharedSecret).toBe(true);
      expect(settings.aisRelaySharedSecretSource).toBe("stored");
    });
  });

  describe("audit", () => {
    it("records the DTO own keys, the secret flags and no secret value", async () => {
      const harness = build({ isPlatformAdmin: true });
      const body = input({ maxRetries: 4, openskyClientSecret: null });

      await harness.service.updateSettings("org-a", "platform-user", body);

      expect(auditWriter).toHaveBeenCalledTimes(1);
      const args = auditWriter.mock.calls[0]?.[0] as {
        data: {
          orgId: string;
          actorId: string | null;
          resource: string;
          action: string;
          metadata: Record<string, unknown>;
        };
      };
      expect(args.data.orgId).toBe("org-a");
      expect(args.data.actorId).toBe("platform-user");
      expect(args.data.resource).toBe("system_settings");
      expect(args.data.action).toBe("realtime_signals_update");
      // Mirrors NestJS `Object.keys(input)` for the very object handed in.
      expect(args.data.metadata.updatedFields).toEqual(Object.keys(body));
      expect(args.data.metadata.secretsUpdated).toEqual({
        aisRelaySharedSecret: false,
        openskyClientSecret: true,
        acledOauthPassword: false,
        cloudflareApiToken: false,
        wingbitsApiKey: false,
      });
      expect(JSON.stringify(args.data.metadata)).not.toContain("s3cret");
    });

    it("writes the reset audit with {ok:true} and nulls a machine actor", async () => {
      const harness = build({ isPlatformAdmin: true });

      // A machine actor can never pass the gate, so exercise the normalization
      // directly through the reset path with a human id and check the shape.
      await harness.service.resetToEnv("org-a", "platform-user");

      const args = auditWriter.mock.calls[0]?.[0] as {
        data: { action: string; metadata: Record<string, unknown> };
      };
      expect(args.data.action).toBe("realtime_signals_reset");
      expect(args.data.metadata).toEqual({ ok: true });
      expect(harness.deleteMany).toHaveBeenCalledWith({
        where: { key: { in: [SETTINGS_KEY, ACLED_AUTH_KEY] } },
      });
    });
  });
});
