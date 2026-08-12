import {
  SEARCH_REINDEX_ACTIVE_JOB_MAX_AGE_MS,
  SEARCH_REINDEX_MAX_RETAINED_JOBS,
  SEARCH_REINDEX_TERMINAL_JOB_TTL_MS,
  SearchReindexJobStore,
  type SearchReindexJob,
} from "./search-reindex-job.store";

function createRedisMock() {
  const store = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const sets = new Set<string>();
  return {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    del: jest.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
    expire: jest.fn(async () => 1),
    sadd: jest.fn(async (key: string, member: string) => {
      sets.add(`${key}:${member}`);
      return 1;
    }),
    smembers: jest.fn(async (key: string) =>
      Array.from(sets)
        .filter((entry) => entry.startsWith(`${key}:`))
        .map((entry) => entry.slice(key.length + 1)),
    ),
    srem: jest.fn(async () => 1),
    rpush: jest.fn(async (key: string, value: string) => {
      lists.set(key, [...(lists.get(key) ?? []), value]);
      return lists.get(key)!.length;
    }),
    lrange: jest.fn(async (key: string) => lists.get(key) ?? []),
    lrem: jest.fn(async (key: string, count: number, value: string) => {
      const current = lists.get(key) ?? [];
      const next = current.filter((entry, index) => {
        if (entry === value && index < count) {
          return false;
        }
        return entry !== value || index >= count;
      });
      lists.set(key, next);
      return 1;
    }),
  };
}

async function seedJob(
  store: SearchReindexJobStore,
  nowMs: number,
  index: number,
): Promise<SearchReindexJob> {
  const job = await store.create("org-1", new Date(nowMs + index));
  job.status = "completed";
  job.updatedAt = new Date(nowMs + index).toISOString();
  return job;
}

describe("SearchReindexJobStore", () => {
  it("prunes terminal jobs after the retention ttl", async () => {
    const redis = createRedisMock();
    const store = new SearchReindexJobStore(redis as any);
    const now = Date.now();
    const job = await store.create("org-1", new Date(now));
    await redis.set(
      `search:reindex:job:${job.id}`,
      JSON.stringify({
        ...job,
        status: "completed",
        updatedAt: new Date(
          now - SEARCH_REINDEX_TERMINAL_JOB_TTL_MS - 1,
        ).toISOString(),
      }),
    );

    await store.prune(now);

    expect(await store.getForOrg("org-1", job.id)).toBeNull();
  });

  it("prunes stale active jobs", async () => {
    const redis = createRedisMock();
    const store = new SearchReindexJobStore(redis as any);
    const now = Date.now();
    const job = await store.create("org-1", new Date(now));
    await redis.set(
      `search:reindex:job:${job.id}`,
      JSON.stringify({
        ...job,
        status: "running",
        updatedAt: new Date(
          now - SEARCH_REINDEX_ACTIVE_JOB_MAX_AGE_MS - 1,
        ).toISOString(),
      }),
    );

    await store.prune(now);

    expect(await store.getForOrg("org-1", job.id)).toBeNull();
  });

  it("caps retained terminal job history", async () => {
    const store = new SearchReindexJobStore(createRedisMock() as any);
    const now = Date.now();
    const jobs: SearchReindexJob[] = [];
    for (let index = 0; index <= SEARCH_REINDEX_MAX_RETAINED_JOBS; index += 1) {
      jobs.push(await seedJob(store, now, index));
    }

    await store.prune(now + SEARCH_REINDEX_MAX_RETAINED_JOBS + 1);

    expect(await store.getForOrg("org-1", jobs[0]!.id)).toBeNull();
    expect(
      await store.getForOrg(
        "org-1",
        jobs[SEARCH_REINDEX_MAX_RETAINED_JOBS]!.id,
      ),
    ).not.toBeNull();
  });

  it("tracks job lifecycle through running/completed", async () => {
    const store = new SearchReindexJobStore(createRedisMock() as any);
    const job = await store.create("org-1");
    expect(job.status).toBe("queued");

    const running = await store.markRunning(job.id);
    expect(running?.status).toBe("running");

    const completed = await store.markCompleted(job.id, 42);
    expect(completed?.status).toBe("completed");
    expect(completed?.indexed).toBe(42);

    const failed = await store.markFailed(job.id, "boom");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("boom");
  });
});
