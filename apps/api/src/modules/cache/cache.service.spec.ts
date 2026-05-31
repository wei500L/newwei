import { CacheService } from "./cache.service";

class FakeRedis {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number>();

  async set(
    key: string,
    value: string,
    _ttlMode: string,
    ttlMs: number,
    mode: string,
  ): Promise<"OK" | null> {
    if (mode === "NX" && this.values.has(key)) {
      return null;
    }
    this.values.set(key, value);
    this.ttls.set(key, ttlMs);
    return "OK";
  }

  async eval(
    _script: string,
    _keyCount: number,
    key: string,
    token: string,
    ttlMs?: string,
  ): Promise<number> {
    if (this.values.get(key) !== token) {
      return 0;
    }
    if (ttlMs === undefined) {
      this.values.delete(key);
      this.ttls.delete(key);
      return 1;
    }
    this.ttls.set(key, Number(ttlMs));
    return 1;
  }

  async quit() {
    return "OK";
  }
}

describe("CacheService lock lease", () => {
  it("acquires, extends, and releases a token-scoped lock", async () => {
    const redis = new FakeRedis();
    const service = new CacheService(redis as any);

    const lease = await service.tryAcquireLock("search:reindex:org-1", 5_000);
    expect(lease).not.toBeNull();
    expect(redis.values.has("lock:search:reindex:org-1")).toBe(true);

    await expect(
      service.tryAcquireLock("search:reindex:org-1", 5_000),
    ).resolves.toBeNull();

    await lease!.extend(7_000);
    expect(redis.ttls.get("lock:search:reindex:org-1")).toBe(7_000);

    await lease!.release();
    expect(redis.values.has("lock:search:reindex:org-1")).toBe(false);
  });

  it("does not release a lock after ownership changes", async () => {
    const redis = new FakeRedis();
    const service = new CacheService(redis as any);

    const lease = await service.tryAcquireLock("search:reindex:org-1", 5_000);
    expect(lease).not.toBeNull();

    redis.values.set("lock:search:reindex:org-1", "other-token");

    await lease!.release();
    expect(redis.values.get("lock:search:reindex:org-1")).toBe("other-token");
  });
});
