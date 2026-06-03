jest.mock("./news-events.service", () => ({
  NewsEventsService: class NewsEventsService {},
}));

import { NewsEventsIngestionService } from "./news-events-ingestion.service";

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

describe("NewsEventsIngestionService", () => {
  const createService = () => {
    const cache = {
      setIfAbsent: jest.fn().mockResolvedValue(true),
      withLock: jest.fn(),
    } as any;
    const prisma = {} as any;
    const activeOrgRegistry = {
      listActiveOrgs: jest.fn(),
    } as any;
    const schedulerSettings = {
      getRuntimeSettings: jest.fn().mockResolvedValue({
        newsEventsIngestionOrgConcurrency: 2,
      }),
    } as any;
    const settings = {} as any;
    const events = {} as any;
    const bertopic = {} as any;
    const service = new NewsEventsIngestionService(
      cache,
      prisma,
      activeOrgRegistry,
      schedulerSettings,
      settings,
      events,
      bertopic,
    );

    return {
      service,
      cache,
      prisma,
      activeOrgRegistry,
      schedulerSettings,
    };
  };

  it("fans out org ingestion with configured concurrency", async () => {
    const { service, cache, activeOrgRegistry, schedulerSettings } =
      createService();
    activeOrgRegistry.listActiveOrgs.mockResolvedValue([
      { id: "org-1" },
      { id: "org-2" },
      { id: "org-3" },
    ]);
    cache.withLock.mockImplementation(
      async (_key: string, _ttlMs: number, runner: () => Promise<unknown>) =>
        await runner(),
    );

    const startedTwo = createDeferred<void>();
    const releases = new Map(
      ["org-1", "org-2", "org-3"].map((orgId) => [
        orgId,
        createDeferred<void>(),
      ]),
    );
    let active = 0;
    let maxActive = 0;
    let started = 0;

    jest
      .spyOn(service as any, "ingestOrg")
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

    const runPromise = service.ingestRecentProcessedArticles();

    await startedTwo.promise;

    expect(schedulerSettings.getRuntimeSettings).toHaveBeenCalledTimes(1);
    expect(maxActive).toBe(2);

    releases.get("org-1")!.resolve();
    releases.get("org-2")!.resolve();
    releases.get("org-3")!.resolve();

    await runPromise;

    expect(cache.withLock).toHaveBeenCalledTimes(3);
    expect(cache.withLock).toHaveBeenNthCalledWith(
      1,
      "cron:news-events-ingestion:org:org-1",
      60_000,
      expect.any(Function),
    );
  });

  it("skips an org when its lock is already held", async () => {
    const { service, cache, activeOrgRegistry } = createService();
    activeOrgRegistry.listActiveOrgs.mockResolvedValue([
      { id: "org-1" },
      { id: "org-2" },
    ]);
    cache.withLock
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(
        async (_key: string, _ttlMs: number, runner: () => Promise<unknown>) =>
          await runner(),
      );
    const ingestOrg = jest
      .spyOn(service as any, "ingestOrg")
      .mockResolvedValue(undefined);

    await service.ingestRecentProcessedArticles();

    expect(ingestOrg).toHaveBeenCalledTimes(1);
    expect(ingestOrg).toHaveBeenCalledWith("org-2");
  });
});
