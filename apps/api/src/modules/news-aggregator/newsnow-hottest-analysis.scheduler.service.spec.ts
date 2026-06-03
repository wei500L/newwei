jest.mock("./newsnow-hottest-analysis.service", () => ({
  NewsnowHottestAnalysisService: class NewsnowHottestAnalysisService {},
}));

import { NewsnowHottestAnalysisSchedulerService } from "./newsnow-hottest-analysis.scheduler.service";

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

describe("NewsnowHottestAnalysisSchedulerService", () => {
  const prisma = {
    org: {
      findMany: jest.fn(),
    },
  };
  const cache = {
    setIfAbsent: jest.fn(),
    withLock: jest.fn(),
  };
  const schedulerSettings = {
    getRuntimeSettings: jest.fn(),
  };
  const globalSnapshot = {
    signature: "signature-1",
    generatedAt: "2026-03-16T00:00:00.000Z",
    diagnostics: {
      sourcesRequested: 1,
      sourcesSucceeded: 1,
      sourcesFailed: 0,
      sourceItemsFetched: 3,
    },
    errors: [],
    totalDomesticSourceCount: 1,
    globalMaxHeatValue: 1000,
    signalSeeds: [],
    clusters: [],
    clusterInsights: [],
  };
  const hottestAnalysis = {
    ensureGlobalSnapshot: jest.fn(),
    refreshProjectionForOrg: jest.fn(),
  };

  let service: NewsnowHottestAnalysisSchedulerService;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.org.findMany.mockResolvedValue([{ id: "org-1" }, { id: "org-2" }]);
    cache.setIfAbsent.mockResolvedValue(true);
    cache.withLock.mockImplementation(
      async (_key: string, _ttlMs: number, runner: () => Promise<unknown>) =>
        await runner(),
    );
    schedulerSettings.getRuntimeSettings.mockResolvedValue({
      newsnowHottestAnalysisOrgConcurrency: 2,
    });
    hottestAnalysis.ensureGlobalSnapshot.mockResolvedValue(globalSnapshot);
    hottestAnalysis.refreshProjectionForOrg.mockResolvedValue(undefined);
    service = new NewsnowHottestAnalysisSchedulerService(
      prisma as never,
      cache as never,
      schedulerSettings as never,
      hottestAnalysis as never,
    );
  });

  it("builds one global snapshot and refreshes each org projection inside a scheduler lock", async () => {
    await service.refreshScheduled();

    expect(prisma.org.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      select: { id: true },
    });
    expect(cache.setIfAbsent).toHaveBeenCalledWith(
      "cron:newsnow-hottest-analysis:tick-gate",
      expect.any(Object),
      585,
    );
    expect(cache.withLock).toHaveBeenCalledWith(
      "cron:newsnow-hottest-analysis:org:org-1",
      expect.any(Number),
      expect.any(Function),
    );
    expect(schedulerSettings.getRuntimeSettings).toHaveBeenCalledTimes(1);
    expect(hottestAnalysis.ensureGlobalSnapshot).toHaveBeenCalledTimes(1);
    expect(hottestAnalysis.refreshProjectionForOrg).toHaveBeenCalledTimes(2);
    expect(hottestAnalysis.refreshProjectionForOrg).toHaveBeenNthCalledWith(1, {
      orgId: "org-1",
      allowAutoBridge: false,
      globalSnapshot,
    });
    expect(hottestAnalysis.refreshProjectionForOrg).toHaveBeenNthCalledWith(2, {
      orgId: "org-2",
      allowAutoBridge: false,
      globalSnapshot,
    });
  });

  it("fans out org refreshes with configured concurrency", async () => {
    prisma.org.findMany.mockResolvedValue([
      { id: "org-1" },
      { id: "org-2" },
      { id: "org-3" },
    ]);
    schedulerSettings.getRuntimeSettings.mockResolvedValue({
      newsnowHottestAnalysisOrgConcurrency: 2,
    });

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

    hottestAnalysis.refreshProjectionForOrg.mockImplementation(
      async ({ orgId }: { orgId: string }) => {
        started += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (started === 2) {
          startedTwo.resolve();
        }

        await releases.get(orgId)!.promise;
        active -= 1;
      },
    );

    const runPromise = service.refreshScheduled();

    await startedTwo.promise;
    expect(maxActive).toBe(2);

    releases.get("org-1")!.resolve();
    releases.get("org-2")!.resolve();
    releases.get("org-3")!.resolve();

    await runPromise;
  });

  it("skips snapshot building when another scheduler runner already claimed the tick", async () => {
    cache.setIfAbsent.mockResolvedValue(false);

    await service.refreshScheduled();

    expect(prisma.org.findMany).not.toHaveBeenCalled();
    expect(cache.withLock).not.toHaveBeenCalled();
    expect(schedulerSettings.getRuntimeSettings).not.toHaveBeenCalled();
    expect(hottestAnalysis.ensureGlobalSnapshot).not.toHaveBeenCalled();
    expect(hottestAnalysis.refreshProjectionForOrg).not.toHaveBeenCalled();
  });

  it("continues refreshing remaining orgs when one org fails", async () => {
    hottestAnalysis.refreshProjectionForOrg
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    await service.refreshScheduled();

    expect(hottestAnalysis.refreshProjectionForOrg).toHaveBeenCalledTimes(2);
  });

  it("skips scheduler work when there are no active orgs", async () => {
    prisma.org.findMany.mockResolvedValue([]);

    await service.refreshScheduled();

    expect(cache.withLock).not.toHaveBeenCalled();
    expect(schedulerSettings.getRuntimeSettings).not.toHaveBeenCalled();
    expect(hottestAnalysis.ensureGlobalSnapshot).not.toHaveBeenCalled();
    expect(hottestAnalysis.refreshProjectionForOrg).not.toHaveBeenCalled();
  });
});
