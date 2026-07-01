import { SentimentSnapshotIngestionService } from "./sentiment-snapshot.ingestion.service";

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

  return {
    promise,
    resolve,
    reject,
  };
}

describe("SentimentSnapshotIngestionService", () => {
  it("fans out org snapshot rebuild with configured concurrency", async () => {
    const cache = {
      setIfAbsent: jest.fn().mockResolvedValue(true),
      withLock: jest.fn(),
    } as any;
    const prisma = {} as any;
    const activeOrgRegistry = {
      listActiveOrgs: jest.fn().mockResolvedValue([
        { id: "org-1" },
        { id: "org-2" },
        { id: "org-3" },
      ]),
    } as any;
    const schedulerSettings = {
      getRuntimeSettings: jest.fn().mockResolvedValue({
        sentimentSnapshotOrgConcurrency: 2,
      }),
    } as any;
    const service = new SentimentSnapshotIngestionService(
      cache,
      prisma,
      activeOrgRegistry,
      schedulerSettings,
    );

    cache.withLock.mockImplementation(
      async (_key: string, _ttlMs: number, runner: () => Promise<unknown>) =>
        await runner(),
    );

    const releases = new Map(
      ["org-1", "org-2", "org-3"].map((orgId) => [
        orgId,
        createDeferred<void>(),
      ]),
    );
    const startedTwo = createDeferred<void>();
    let active = 0;
    let maxActive = 0;
    let started = 0;

    jest
      .spyOn(service as any, "rebuildOrg")
      .mockImplementation(async (orgId: string) => {
        started += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (started === 2) {
          startedTwo.resolve();
        }

        await releases.get(orgId)!.promise;
        active -= 1;
      });

    const runPromise = service.rebuildRecentSnapshots();

    await startedTwo.promise;
    expect(maxActive).toBe(2);

    releases.get("org-1")!.resolve();
    releases.get("org-2")!.resolve();
    releases.get("org-3")!.resolve();

    await runPromise;

    expect(cache.withLock).toHaveBeenNthCalledWith(
      1,
      "cron:sentiment-snapshot:org:org-1",
      300_000,
      expect.any(Function),
    );
  });
});
