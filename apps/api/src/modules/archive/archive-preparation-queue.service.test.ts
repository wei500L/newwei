import { beforeEach, describe, expect, it, vi } from "vitest";

import { CacheService } from "../cache/cache.service";

import { ArchivePreparationQueueService } from "./archive-preparation-queue.service";

const INDEX_KEY = "archive:preparation:status:index";
const ORG_A = "org-a";
const ORG_B = "org-b";

const statusKey = (scope: string, orgId: string, scopeValue: string): string =>
  ["archive", "preparation", "status", scope, orgId, scopeValue].join(":");

const updatedAt = "2026-01-02T03:04:05.000Z";

interface StoredValue {
  orgId?: string;
  scope: string;
  scopeValue: string;
  state: string;
  updatedAt: string;
  errorMessage?: string;
}

interface Entry {
  key: string;
  value: unknown;
}

const entry = (
  scope: string,
  orgId: string,
  scopeValue: string,
  state: string,
  errorMessage?: string,
  options: { omitOrgId?: boolean; value?: null } = {},
): Entry => ({
  key: statusKey(scope, orgId, scopeValue),
  value:
    options.value === null
      ? null
      : {
          scope,
          scopeValue,
          state,
          updatedAt,
          ...(options.omitOrgId ? {} : { orgId }),
          ...(errorMessage === undefined ? {} : { errorMessage }),
        },
});

const build = (entries: Entry[]) => {
  const zcard = vi.fn(async () => entries.length);
  const zrange = vi.fn(async () => entries.map((item) => item.key));
  const getMany = vi.fn(async (keys: string[]) =>
    keys.map(
      (key) => entries.find((item) => item.key === key)?.value ?? null,
    ),
  );
  const get = vi.fn(async (key: string) => {
    const found = entries.find((item) => item.key === key);
    return found ? found.value : null;
  });
  // The reader must never write, trim, renew or delete index entries.
  const set = vi.fn(async () => undefined);
  const zadd = vi.fn(async () => undefined);
  const zrem = vi.fn(async () => undefined);
  const delMany = vi.fn(async () => undefined);
  const del = vi.fn(async () => undefined);

  const service = new ArchivePreparationQueueService(
    {} as unknown as ConstructorParameters<
      typeof ArchivePreparationQueueService
    >[0],
    { zcard, zrange, getMany, get, set, zadd, zrem, delMany, del } as unknown as CacheService,
  );

  return { service, zcard, zrange, getMany, get, set, zadd, zrem, delMany, del };
};

describe("ArchivePreparationQueueService status reads", () => {
  let harness: ReturnType<typeof build>;

  beforeEach(() => {
    harness = build([]);
  });

  describe("DS4 single snapshot", () => {
    it("derives counts and the recent list from one read of the index", async () => {
      harness = build([
        entry("digest", ORG_A, "2026-01-01", "READY"),
        entry("digest", ORG_A, "2026-01-02", "FAILED", "boom"),
      ]);

      const status = await harness.service.getOperationalStatus(ORG_A);

      // Previously `getRecentStatuses` and `getScopedCounts` each ran their own
      // ZCARD/ZRANGE/MGET, so a worker update in between could make one
      // response contradict itself. One pass is what makes it self-consistent.
      expect(harness.zcard).toHaveBeenCalledTimes(1);
      expect(harness.zrange).toHaveBeenCalledTimes(1);
      expect(harness.getMany).toHaveBeenCalledTimes(1);
      expect(harness.zrange).toHaveBeenCalledWith(INDEX_KEY, 0, 1);
      expect(status.counts).toEqual({
        waiting: 0,
        active: 0,
        completed: 1,
        failed: 1,
        delayed: 0,
      });
      expect(status.pending).toBe(0);
      expect(status.recentStatuses).toHaveLength(2);
      expect(typeof status.updatedAt).toBe("string");
    });

    it("maps every state into the documented counters", async () => {
      harness = build([
        entry("digest", ORG_A, "a", "QUEUED"),
        entry("digest", ORG_A, "b", "PROCESSING"),
        entry("calendar", ORG_A, "c", "PARTIAL"),
        entry("calendar", ORG_A, "d", "READY"),
        entry("digest", ORG_A, "e", "FAILED"),
        entry("digest", ORG_A, "f", "IDLE"),
      ]);

      const status = await harness.service.getOperationalStatus(ORG_A);

      expect(status.counts).toEqual({
        waiting: 1,
        active: 2,
        completed: 1,
        failed: 1,
        // The derived status index is not BullMQ's delayed set: this stays 0.
        delayed: 0,
      });
      expect(status.pending).toBe(3);
      // IDLE is not counted anywhere.
      expect(status.recentStatuses).toHaveLength(6);
    });

    it("counts the whole snapshot but caps the recent list at 10", async () => {
      harness = build(
        Array.from({ length: 14 }, (_unused, index) =>
          entry("digest", ORG_A, `v${index}`, "READY"),
        ),
      );

      const status = await harness.service.getOperationalStatus(ORG_A);

      expect(status.counts.completed).toBe(14);
      expect(status.recentStatuses).toHaveLength(10);
    });

    it("keeps the index order, reversed, and skips expired records", async () => {
      harness = build([
        entry("digest", ORG_A, "oldest", "READY"),
        { key: statusKey("digest", ORG_A, "expired"), value: null },
        entry("digest", ORG_A, "newest", "PROCESSING"),
      ]);

      const status = await harness.service.getOperationalStatus(ORG_A);

      expect(status.recentStatuses.map((item) => item.scopeValue)).toEqual([
        "newest",
        "oldest",
      ]);
    });
  });

  describe("organisation isolation", () => {
    it("returns only the caller's records without leaking keys or orgId", async () => {
      harness = build([
        entry("digest", ORG_A, "a-old", "READY"),
        entry("digest", ORG_B, "b-only", "READY"),
        entry("digest", ORG_A, "a-new", "READY"),
      ]);

      const status = await harness.service.getOperationalStatus(ORG_A);
      const serialized = JSON.stringify(status);

      expect(status.recentStatuses.map((item) => item.scopeValue)).toEqual([
        "a-new",
        "a-old",
      ]);
      expect(serialized).not.toContain("b-only");
      expect(serialized).not.toContain(ORG_B);
      expect(serialized).not.toContain(ORG_A);
      expect(serialized).not.toContain(INDEX_KEY);
      expect(serialized).not.toContain("orgId");
    });

    it("falls back to the fifth key segment when orgId is missing", async () => {
      harness = build([
        entry("digest", ORG_A, "legacy", "READY", undefined, {
          omitOrgId: true,
        }),
      ]);

      const mine = await harness.service.getOperationalStatus(ORG_A);
      const other = await harness.service.getOperationalStatus(ORG_B);

      expect(mine.recentStatuses.map((item) => item.scopeValue)).toEqual([
        "legacy",
      ]);
      expect(other.recentStatuses).toHaveLength(0);
      expect(other.counts.completed).toBe(0);
    });
  });

  describe("DS3 public error redaction", () => {
    it("redacts the credential patterns in toPublicStatusRecord", async () => {
      harness = build([
        entry(
          "digest",
          ORG_A,
          "v",
          "FAILED",
          "call failed: Bearer tok.abc-1 password=pw token=t1 api_key=k1 secret=s1",
        ),
      ]);

      const status = await harness.service.getOperationalStatus(ORG_A);
      const message = status.recentStatuses[0]?.errorMessage;

      expect(message).toBe(
        "call failed: Bearer [REDACTED] password=[REDACTED] token=[REDACTED] api_key=[REDACTED] secret=[REDACTED]",
      );
    });

    it("redacts the credential patterns in getStatus as well", async () => {
      harness = build([
        {
          key: statusKey("digest", ORG_A, "2026-01-01"),
          value: {
            orgId: ORG_A,
            scope: "digest",
            scopeValue: "2026-01-01",
            state: "FAILED",
            updatedAt,
            errorMessage: "Bearer tok.abc-1",
          },
        },
      ]);

      const status = await harness.service.getDigestStatus(ORG_A, "2026-01-01");

      expect(status?.errorMessage).toBe("Bearer [REDACTED]");
    });

    it("leaves an ordinary message untouched", async () => {
      harness = build([
        entry("digest", ORG_A, "v", "FAILED", "S3 upload timed out after 30s"),
      ]);

      const status = await harness.service.getOperationalStatus(ORG_A);

      expect(status.recentStatuses[0]?.errorMessage).toBe(
        "S3 upload timed out after 30s",
      );
    });

    it("preserves an empty message and nulls a missing one", async () => {
      harness = build([
        entry("digest", ORG_A, "empty", "FAILED", ""),
        entry("digest", ORG_A, "missing", "READY"),
      ]);

      const status = await harness.service.getOperationalStatus(ORG_A);

      expect(
        status.recentStatuses.find((item) => item.scopeValue === "empty")
          ?.errorMessage,
      ).toBe("");
      expect(
        status.recentStatuses.find((item) => item.scopeValue === "missing")
          ?.errorMessage,
      ).toBeNull();
    });

    it("never rewrites the stored record in Redis", async () => {
      const stored: StoredValue = {
        orgId: ORG_A,
        scope: "digest",
        scopeValue: "v",
        state: "FAILED",
        updatedAt,
        errorMessage: "token=keep-me-in-redis",
      };
      harness = build([{ key: statusKey("digest", ORG_A, "v"), value: stored }]);

      await harness.service.getOperationalStatus(ORG_A);

      // The public mapping is a copy: the fixture object is untouched.
      expect(stored.errorMessage).toBe("token=keep-me-in-redis");
      expect(harness.set).not.toHaveBeenCalled();
      expect(harness.zadd).not.toHaveBeenCalled();
      expect(harness.zrem).not.toHaveBeenCalled();
      expect(harness.delMany).not.toHaveBeenCalled();
      expect(harness.del).not.toHaveBeenCalled();
    });
  });

  describe("failure semantics", () => {
    it("propagates a Redis failure instead of reporting a zeroed status", async () => {
      harness = build([]);
      harness.zcard.mockRejectedValue(new Error("redis unavailable"));

      await expect(
        harness.service.getOperationalStatus(ORG_A),
      ).rejects.toThrow("redis unavailable");
    });

    it("returns an empty status for an empty index without reading members", async () => {
      harness = build([]);

      const status = await harness.service.getOperationalStatus(ORG_A);

      expect(harness.zrange).not.toHaveBeenCalled();
      expect(harness.getMany).not.toHaveBeenCalled();
      expect(status).toMatchObject({
        pending: 0,
        counts: {
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
        },
        recentStatuses: [],
      });
    });
  });
});
