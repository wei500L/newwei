import { ForbiddenException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { PlatformAccessService } from "../auth/platform-access.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { withMysqlSessionLock } from "../situation-monitor/situation-monitor-user-lock";

import { GeoNominatimSettingsService } from "./geo-nominatim-settings.service";

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

const SETTINGS_KEY = "geo_nominatim_identity";
const NOMINATIM_LOCK = "data-runtime-settings:nominatim:v1";

const sessionLock = vi.mocked(withMysqlSessionLock);
const auditWriter = vi.mocked(writeAuditLogBestEffort);

type Mock = ReturnType<typeof vi.fn>;

const build = (
  options: {
    isPlatformAdmin?: boolean;
    rows?: Array<unknown>;
    userAgent?: string;
    email?: string;
  } = {},
) => {
  const rows = options.rows ? [...options.rows] : [];
  const findUnique = vi.fn(async () => {
    const next = rows.length > 1 ? rows.shift() : rows[0];
    return next === undefined ? null : next;
  });
  const upsert = vi.fn(async () => undefined);
  const assertPlatformAdmin = vi.fn(async () => {
    if (options.isPlatformAdmin === false) {
      throw new ForbiddenException("Platform admin access required");
    }
    return undefined;
  });
  const envGet = vi.fn((key: string) => {
    if (key === "GEO_NOMINATIM_USER_AGENT") {
      return options.userAgent ?? "modular-api";
    }
    if (key === "GEO_NOMINATIM_EMAIL") {
      return options.email ?? "ops@example.com";
    }
    return undefined;
  });

  const service = new GeoNominatimSettingsService(
    { systemSetting: { findUnique, upsert } } as unknown as PrismaService,
    { get: envGet } as unknown as EnvService,
    { assertPlatformAdmin } as unknown as PlatformAccessService,
  );

  return { service, findUnique, upsert, assertPlatformAdmin };
};

const writtenOverrides = (
  upsert: Mock,
  index = 0,
): { userAgent: string | null; email: string | null } => {
  const args = upsert.mock.calls[index]?.[0] as {
    create?: { value?: { userAgent: string | null; email: string | null } };
    update?: { value?: { userAgent: string | null; email: string | null } };
  };
  const value = args.update?.value ?? args.create?.value;
  if (!value) {
    throw new Error("no upsert value was written");
  }
  return value;
};

const writtenActor = (upsert: Mock, index = 0): string | null => {
  const args = upsert.mock.calls[index]?.[0] as {
    update?: { updatedById?: string | null };
  };
  return args.update?.updatedById ?? null;
};

describe("GeoNominatimSettingsService", () => {
  beforeEach(() => {
    sessionLock.mockReset();
    sessionLock.mockImplementation(async (_url, _name, fn) => await fn());
    auditWriter.mockClear();
    auditWriter.mockImplementation(async () => undefined);
  });

  describe("DS1 platform write gate", () => {
    it("rejects a non-platform writer before the DB read and the write", async () => {
      const harness = build({
        isPlatformAdmin: false,
        rows: [{ value: { userAgent: "db-ua" } }],
      });

      const caught = await harness.service
        .updateSettings("org-a", "org-admin", { userAgent: "attacker" })
        .catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(ForbiddenException);
      expect((caught as ForbiddenException).message).toBe(
        "Platform admin access required",
      );
      expect(harness.findUnique).not.toHaveBeenCalled();
      expect(harness.upsert).not.toHaveBeenCalled();
      expect(sessionLock).not.toHaveBeenCalled();
      expect(auditWriter).not.toHaveBeenCalled();
    });

    it("does not gate the read path", async () => {
      const harness = build({ isPlatformAdmin: false, rows: [] });

      const settings = await harness.service.getSettings();

      expect(harness.assertPlatformAdmin).not.toHaveBeenCalled();
      expect(settings.userAgent).toBeNull();
      expect(settings.effectiveUserAgent).toBe("modular-api");
      expect(settings.effectiveEmail).toBe("ops@example.com");
    });
  });

  describe("DS2 lock and database-authoritative merge", () => {
    it("merges from the MySQL row even after warming the process cache", async () => {
      const harness = build({
        isPlatformAdmin: true,
        rows: [
          { value: { userAgent: "from-db" } },
          { value: { userAgent: "updated-db" } },
        ],
      });

      // Warm the 30 second process cache with the first DB value.
      const warmed = await harness.service.getSettings();
      expect(warmed.userAgent).toBe("from-db");

      await harness.service.updateSettings("org-a", "platform-user", {
        email: "next@example.com",
      });

      // The merge base must be the fresh DB row, never the process cache.
      expect(writtenOverrides(harness.upsert).userAgent).toBe("updated-db");
      expect(writtenOverrides(harness.upsert).email).toBe("next@example.com");
      expect(sessionLock.mock.calls[0]?.[1]).toBe(NOMINATIM_LOCK);
      expect(NOMINATIM_LOCK).not.toContain("org-a");
    });

    it("keeps the 30 second process cache for reads", async () => {
      const harness = build({
        isPlatformAdmin: false,
        rows: [{ value: { userAgent: "cached-ua" } }],
      });

      await harness.service.getSettings();
      const second = await harness.service.getSettings();

      // Documented retained behaviour: one DB read serves the whole TTL.
      expect(harness.findUnique).toHaveBeenCalledTimes(1);
      expect(second.userAgent).toBe("cached-ua");
    });

    it("writes the real platform administrator user id", async () => {
      const harness = build({ isPlatformAdmin: true, rows: [{ value: {} }] });

      await harness.service.updateSettings("org-a", "platform-user", {
        userAgent: "ua",
      });

      expect(writtenActor(harness.upsert)).toBe("platform-user");
    });
  });

  describe("override merge semantics", () => {
    it("clears with null and preserves with missing", async () => {
      const harness = build({
        isPlatformAdmin: true,
        rows: [{ value: { userAgent: "db-ua", email: "db@example.com" } }],
      });

      await harness.service.updateSettings("org-a", "p", { userAgent: null });
      expect(writtenOverrides(harness.upsert, 0)).toEqual({
        userAgent: null,
        email: "db@example.com",
      });

      await harness.service.updateSettings("org-a", "p", {});
      expect(writtenOverrides(harness.upsert, 1)).toEqual({
        userAgent: "db-ua",
        email: "db@example.com",
      });
    });

    it("normalizes a whitespace userAgent and an invalid email to null", async () => {
      const harness = build({ isPlatformAdmin: true, rows: [{ value: {} }] });

      await harness.service.updateSettings("org-a", "p", {
        userAgent: "   ",
        email: "not-an-email",
      });

      expect(writtenOverrides(harness.upsert)).toEqual({
        userAgent: null,
        email: null,
      });
    });

    it("trims a valid userAgent and keeps a valid email", async () => {
      const harness = build({ isPlatformAdmin: true, rows: [{ value: {} }] });

      await harness.service.updateSettings("org-a", "p", {
        userAgent: "  modular-client/1.0  ",
        email: " geocoder@example.com ",
      });

      expect(writtenOverrides(harness.upsert)).toEqual({
        userAgent: "modular-client/1.0",
        email: "geocoder@example.com",
      });
    });

    it("treats a non-object stored value as no overrides", async () => {
      const harness = build({
        isPlatformAdmin: true,
        rows: [{ value: ["not", "an", "object"] }],
      });

      await harness.service.updateSettings("org-a", "p", { email: "a@example.com" });

      expect(writtenOverrides(harness.upsert).userAgent).toBeNull();
      expect(writtenOverrides(harness.upsert).email).toBe("a@example.com");
    });
  });

  describe("fire-and-forget audit", () => {
    it("still resolves the write when the audit write rejects", async () => {
      const harness = build({ isPlatformAdmin: true, rows: [{ value: {} }] });
      auditWriter.mockRejectedValue(new Error("audit down"));

      const settings = await harness.service.updateSettings("org-a", "p", {
        userAgent: "ua",
      });

      expect(harness.upsert).toHaveBeenCalledTimes(1);
      expect(settings.userAgent).toBe("ua");
      expect(settings.effectiveUserAgent).toBe("ua");
    });

    it("audits the overrides, not the effective identity", async () => {
      const harness = build({
        isPlatformAdmin: true,
        rows: [{ value: {} }],
        userAgent: "env-ua",
        email: "env@example.com",
      });

      await harness.service.updateSettings("org-a", "p", { userAgent: null });

      const args = auditWriter.mock.calls[0]?.[0] as {
        data: { action: string; actorId: string | null; metadata: unknown };
      };
      expect(args.data.action).toBe("geo_nominatim_settings_update");
      expect(args.data.actorId).toBe("p");
      expect(args.data.metadata).toEqual({ userAgent: null, email: null });
    });
  });

  describe("effective identity", () => {
    it("falls back to the environment when an override is null", async () => {
      const harness = build({
        isPlatformAdmin: false,
        rows: [{ value: { userAgent: null, email: null } }],
        userAgent: "env-ua",
        email: "env@example.com",
      });

      const identity = await harness.service.getEffectiveIdentity();

      expect(identity).toEqual({ userAgent: "env-ua", email: "env@example.com" });
    });

    it("omits the email key when the environment has none", async () => {
      const harness = build({
        isPlatformAdmin: false,
        rows: [{ value: {} }],
        userAgent: "env-ua",
        email: "",
      });

      const identity = await harness.service.getEffectiveIdentity();

      expect(identity).toEqual({ userAgent: "env-ua" });
    });
  });
});
