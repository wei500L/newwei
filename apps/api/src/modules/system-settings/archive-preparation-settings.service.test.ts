import { ForbiddenException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../audit/audit-log.writer", () => ({
  writeAuditLogBestEffort: vi.fn(async () => undefined),
}));

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { PlatformAccessService } from "../auth/platform-access.service";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

import { ArchivePreparationSettingsService } from "./archive-preparation-settings.service";

const SETTINGS_KEY = "archive_preparation_settings";
const CACHE_KEY = "archive_preparation:settings";
const SETTINGS_DESCRIPTION =
  "Archive background preparation settings (batch sizes and embedding/rerank concurrency).";

const auditWriter = vi.mocked(writeAuditLogBestEffort);

type Mock = ReturnType<typeof vi.fn>;

type RawInput = Record<string, unknown>;

const build = (
  options: {
    isPlatformAdmin?: boolean;
    storedValue?: unknown;
    auditRejects?: boolean;
  } = {},
) => {
  const findUnique = vi.fn(async () =>
    options.storedValue === undefined
      ? null
      : { key: SETTINGS_KEY, value: options.storedValue },
  );
  const upsert = vi.fn(async () => undefined);
  const deleteMany = vi.fn(async () => ({ count: 1 }));
  const cacheDel = vi.fn(async () => undefined);
  const cacheWrap = vi.fn(
    async (
      _key: string,
      _ttl: number,
      loader: () => Promise<unknown>,
    ): Promise<unknown> => await loader(),
  );
  const assertPlatformAdmin = vi.fn(async () => {
    if (options.isPlatformAdmin === false) {
      throw new ForbiddenException("Platform admin access required");
    }
    return undefined;
  });

  const service = new ArchivePreparationSettingsService(
    { systemSetting: { findUnique, upsert, deleteMany } } as unknown as PrismaService,
    { del: cacheDel, wrap: cacheWrap } as unknown as CacheService,
    { assertPlatformAdmin } as unknown as PlatformAccessService,
  );

  if (options.auditRejects) {
    auditWriter.mockRejectedValue(new Error("audit down"));
  } else {
    auditWriter.mockImplementation(async () => undefined);
  }

  return {
    service,
    findUnique,
    upsert,
    deleteMany,
    cacheDel,
    cacheWrap,
    assertPlatformAdmin,
  };
};

const writtenSettings = (
  upsert: Mock,
  index = 0,
): Record<string, unknown> => {
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

describe("ArchivePreparationSettingsService", () => {
  beforeEach(() => {
    auditWriter.mockClear();
    auditWriter.mockImplementation(async () => undefined);
  });

  describe("DS1 platform write gate", () => {
    it("rejects a non-platform update before the DB write and the audit", async () => {
      const harness = build({ isPlatformAdmin: false });

      const caught = await harness.service
        .updateSettings("org-a", "org-admin", {
          jobBatchSize: 50,
          embeddingBatchSize: 50,
          embeddingMaxConcurrency: 4,
          rerankMaxConcurrency: 4,
        })
        .catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(ForbiddenException);
      expect((caught as ForbiddenException).message).toBe(
        "Platform admin access required",
      );
      expect(harness.upsert).not.toHaveBeenCalled();
      expect(harness.cacheDel).not.toHaveBeenCalled();
      expect(auditWriter).not.toHaveBeenCalled();
    });

    it("rejects a non-platform reset before the delete", async () => {
      const harness = build({ isPlatformAdmin: false });

      await expect(
        harness.service.resetToDefaults("org-a", "machine:tok"),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(harness.deleteMany).not.toHaveBeenCalled();
    });

    it("does not gate the read path", async () => {
      const harness = build({ isPlatformAdmin: false });

      const settings = await harness.service.getPublicSettings();

      expect(harness.assertPlatformAdmin).not.toHaveBeenCalled();
      expect(settings).toEqual({
        source: "default",
        jobBatchSize: 20,
        embeddingBatchSize: 20,
        embeddingMaxConcurrency: 1,
        rerankMaxConcurrency: 1,
      });
    });
  });

  describe("DTO-independent normalization", () => {
    it("rounds with JS Math.round and clamps to the bounds", async () => {
      const harness = build({ isPlatformAdmin: true });

      await harness.service.updateSettings("org-a", "platform-user", {
        jobBatchSize: 20.5 as unknown as number,
        embeddingBatchSize: 100.4 as unknown as number,
        embeddingMaxConcurrency: "3" as unknown as number,
        rerankMaxConcurrency: null as unknown as number,
      });

      expect(writtenSettings(harness.upsert)).toEqual({
        jobBatchSize: 21,
        embeddingBatchSize: 100,
        embeddingMaxConcurrency: 3,
        rerankMaxConcurrency: 1,
      });
    });

    it("treats null as Number(null)=0, distinct from a missing value", async () => {
      const harness = build({ isPlatformAdmin: true });

      await harness.service.updateSettings("org-a", "p", {
        jobBatchSize: null as unknown as number,
        embeddingBatchSize: null as unknown as number,
        embeddingMaxConcurrency: null as unknown as number,
        rerankMaxConcurrency: null as unknown as number,
      });

      // Every field clamps up to its lower bound; none keeps a default.
      expect(writtenSettings(harness.upsert)).toEqual({
        jobBatchSize: 1,
        embeddingBatchSize: 1,
        embeddingMaxConcurrency: 1,
        rerankMaxConcurrency: 1,
      });
    });

    it("clamps negatives and falls back for non-finite stored values", async () => {
      const harness = build({ isPlatformAdmin: true });

      await harness.service.updateSettings("org-a", "p", {
        jobBatchSize: -5 as unknown as number,
        embeddingBatchSize: Number.NaN as unknown as number,
        embeddingMaxConcurrency: 99 as unknown as number,
        rerankMaxConcurrency: 0 as unknown as number,
      });

      const value = writtenSettings(harness.upsert);
      expect(value.jobBatchSize).toBe(1);
      // NaN is not finite, so the default is used (not clamped to 1).
      expect(value.embeddingBatchSize).toBe(20);
      expect(value.embeddingMaxConcurrency).toBe(8);
      expect(value.rerankMaxConcurrency).toBe(1);
    });

    it("normalizes stored DB values on read", async () => {
      const harness = build({
        isPlatformAdmin: false,
        storedValue: {
          jobBatchSize: "35",
          embeddingBatchSize: 1.6,
          embeddingMaxConcurrency: true,
          rerankMaxConcurrency: {},
        },
      });

      const settings = await harness.service.getPublicSettings();

      expect(settings).toEqual({
        source: "db",
        jobBatchSize: 35,
        embeddingBatchSize: 2,
        // Number(true) === 1, then clamped into 1..8.
        embeddingMaxConcurrency: 1,
        // Number({}) is NaN, so the field falls back to its default.
        rerankMaxConcurrency: 1,
      });
    });
  });

  describe("write path", () => {
    it("refreshes description/isPublic on both branches and the actor id", async () => {
      const harness = build({ isPlatformAdmin: true });

      await harness.service.updateSettings("org-a", "platform-user", {
        jobBatchSize: 30,
        embeddingBatchSize: 30,
        embeddingMaxConcurrency: 2,
        rerankMaxConcurrency: 2,
      });

      const args = harness.upsert.mock.calls[0]?.[0] as {
        where: { key: string };
        create: { description: string; isPublic: boolean; updatedById: string };
        update: { description: string; isPublic: boolean; updatedById: string };
      };
      expect(args.where).toEqual({ key: SETTINGS_KEY });
      expect(args.create.description).toBe(SETTINGS_DESCRIPTION);
      expect(args.update.description).toBe(SETTINGS_DESCRIPTION);
      expect(args.create.isPublic).toBe(false);
      expect(args.update.isPublic).toBe(false);
      expect(args.create.updatedById).toBe("platform-user");
      expect(args.update.updatedById).toBe("platform-user");
      expect(harness.cacheDel).toHaveBeenCalledWith(CACHE_KEY);
    });

    it("awaits the audit and fails the request when it rejects", async () => {
      const harness = build({ isPlatformAdmin: true, auditRejects: true });

      await expect(
        harness.service.updateSettings("org-a", "p", {
          jobBatchSize: 10,
          embeddingBatchSize: 10,
          embeddingMaxConcurrency: 1,
          rerankMaxConcurrency: 1,
        }),
      ).rejects.toThrow("audit down");
    });

    it("audits the normalized four fields", async () => {
      const harness = build({ isPlatformAdmin: true });

      await harness.service.updateSettings("org-a", "platform-user", {
        jobBatchSize: 11.6 as unknown as number,
        embeddingBatchSize: 12,
        embeddingMaxConcurrency: 3,
        rerankMaxConcurrency: 4,
      });

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
      expect(args.data.action).toBe("archive_preparation_update");
      expect(args.data.metadata).toEqual({
        jobBatchSize: 12,
        embeddingBatchSize: 12,
        embeddingMaxConcurrency: 3,
        rerankMaxConcurrency: 4,
      });
    });
  });

  describe("reset", () => {
    it("deletes only the archive preparation row and audits {ok:true}", async () => {
      const harness = build({ isPlatformAdmin: true });

      const settings = await harness.service.resetToDefaults(
        "org-a",
        "platform-user",
      );

      expect(harness.deleteMany).toHaveBeenCalledWith({
        where: { key: SETTINGS_KEY },
      });
      const args = auditWriter.mock.calls[0]?.[0] as {
        data: { action: string; metadata: Record<string, unknown> };
      };
      expect(args.data.action).toBe("archive_preparation_reset");
      expect(args.data.metadata).toEqual({ ok: true });
      expect(harness.cacheDel).toHaveBeenCalledWith(CACHE_KEY);
      expect(settings).toEqual({
        source: "default",
        jobBatchSize: 20,
        embeddingBatchSize: 20,
        embeddingMaxConcurrency: 1,
        rerankMaxConcurrency: 1,
      });
    });
  });

  describe("cache shape", () => {
    it("caches the raw settings value (not an exists/value envelope) for 30s", async () => {
      const harness = build({
        isPlatformAdmin: false,
        storedValue: { jobBatchSize: 40 },
      });

      await harness.service.getPublicSettings();

      expect(harness.cacheWrap).toHaveBeenCalledTimes(1);
      expect(harness.cacheWrap.mock.calls[0]?.[0]).toBe(CACHE_KEY);
      expect(harness.cacheWrap.mock.calls[0]?.[1]).toBe(30);
    });
  });
});
