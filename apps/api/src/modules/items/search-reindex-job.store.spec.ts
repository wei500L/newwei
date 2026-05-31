import {
  SEARCH_REINDEX_ACTIVE_JOB_MAX_AGE_MS,
  SEARCH_REINDEX_MAX_RETAINED_JOBS,
  SEARCH_REINDEX_TERMINAL_JOB_TTL_MS,
  SearchReindexJobStore,
} from "./search-reindex-job.store";

describe("SearchReindexJobStore", () => {
  it("prunes terminal jobs after the retention ttl", () => {
    const store = new SearchReindexJobStore();
    const now = Date.now();
    const job = store.create("org-1", new Date(now));
    job.status = "completed";
    job.updatedAt = new Date(
      now - SEARCH_REINDEX_TERMINAL_JOB_TTL_MS - 1,
    ).toISOString();

    store.prune(now);

    expect(store.getForOrg("org-1", job.id)).toBeNull();
  });

  it("prunes stale active jobs", () => {
    const store = new SearchReindexJobStore();
    const now = Date.now();
    const job = store.create("org-1", new Date(now));
    job.status = "running";
    job.updatedAt = new Date(
      now - SEARCH_REINDEX_ACTIVE_JOB_MAX_AGE_MS - 1,
    ).toISOString();

    store.prune(now);

    expect(store.getForOrg("org-1", job.id)).toBeNull();
  });

  it("caps retained terminal job history", () => {
    const store = new SearchReindexJobStore();
    const now = Date.now();
    const jobs = Array.from(
      { length: SEARCH_REINDEX_MAX_RETAINED_JOBS + 1 },
      (_, index) => {
        const job = store.create("org-1", new Date(now + index));
        job.status = "completed";
        job.updatedAt = new Date(now + index).toISOString();
        return job;
      },
    );

    store.prune(now + SEARCH_REINDEX_MAX_RETAINED_JOBS + 1);

    expect(store.getForOrg("org-1", jobs[0]!.id)).toBeNull();
    expect(
      store.getForOrg("org-1", jobs[SEARCH_REINDEX_MAX_RETAINED_JOBS]!.id),
    ).not.toBeNull();
  });
});
