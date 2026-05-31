import { ConflictException } from "@nestjs/common";

import { SearchReindexJobStore } from "./search-reindex-job.store";
import { SearchReindexService } from "./search-reindex.service";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function createLease() {
  const stopRenew = jest.fn();
  return {
    extend: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    startAutoRenew: jest.fn(() => stopRenew),
    stopRenew,
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("SearchReindexService", () => {
  it("starts one reindex job and records completion", async () => {
    const deferred = createDeferred<{ indexed: number }>();
    const elasticsearch = {
      reindexOrg: jest.fn().mockReturnValue(deferred.promise),
    };
    const lease = createLease();
    const cache = {
      tryAcquireLock: jest.fn().mockResolvedValue(lease),
    };
    const jobs = new SearchReindexJobStore();
    const service = new SearchReindexService(
      elasticsearch as any,
      cache as any,
      jobs,
    );

    const job = await service.startReindex("org-1");

    expect(cache.tryAcquireLock).toHaveBeenCalledWith(
      "search:reindex:org:org-1",
      5 * 60_000,
    );
    expect(elasticsearch.reindexOrg).toHaveBeenCalledWith("org-1");
    expect(service.getReindexJob("other-org", job.id)).toBeNull();

    deferred.resolve({ indexed: 42 });
    await flushPromises();

    expect(service.getReindexJob("org-1", job.id)).toMatchObject({
      status: "completed",
      indexed: 42,
    });
    expect(lease.stopRenew).toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalled();
  });

  it("rejects duplicate reindex submissions before creating a job", async () => {
    const service = new SearchReindexService(
      { reindexOrg: jest.fn() } as any,
      { tryAcquireLock: jest.fn().mockResolvedValue(null) } as any,
      new SearchReindexJobStore(),
    );

    await expect(service.startReindex("org-1")).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("records failed reindex jobs and releases the lock", async () => {
    const lease = createLease();
    const service = new SearchReindexService(
      { reindexOrg: jest.fn().mockRejectedValue(new Error("boom")) } as any,
      { tryAcquireLock: jest.fn().mockResolvedValue(lease) } as any,
      new SearchReindexJobStore(),
    );

    const job = await service.startReindex("org-1");
    await flushPromises();

    expect(service.getReindexJob("org-1", job.id)).toMatchObject({
      status: "failed",
      error: "boom",
    });
    expect(lease.release).toHaveBeenCalled();
  });
});
