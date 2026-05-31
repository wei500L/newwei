import { ClassificationQualityAlertSchedulerService } from "./classification-quality-alert-scheduler.service";
import { recordSchedulerRun } from "./prometheus-metrics";

jest.mock("./prometheus-metrics", () => ({
  recordSchedulerRun: jest.fn(),
}));

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

describe("ClassificationQualityAlertSchedulerService", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("fans out org evaluations with configured concurrency", async () => {
    const releases = new Map([
      ["org-1", createDeferred<void>()],
      ["org-2", createDeferred<void>()],
      ["org-3", createDeferred<void>()],
    ]);
    const startedTwo = createDeferred<void>();
    let active = 0;
    let maxActive = 0;
    let started = 0;
    const service = createService({
      orgs: [{ id: "org-1" }, { id: "org-2" }, { id: "org-3" }],
      concurrency: 2,
      getSummary: jest.fn(async ({ orgId }: { orgId: string }) => {
        active += 1;
        started += 1;
        maxActive = Math.max(maxActive, active);
        if (started === 2) {
          startedTwo.resolve();
        }
        await releases.get(orgId)!.promise;
        active -= 1;
      }),
    });

    const run = service.evaluate();
    await startedTwo.promise;

    expect(maxActive).toBe(2);

    for (const release of releases.values()) {
      release.resolve();
    }
    await run;

    expect(recordSchedulerRun).toHaveBeenCalledTimes(3);
    expect(recordSchedulerRun).toHaveBeenCalledWith(
      "classification_quality_alerts",
      "success",
    );
  });

  it("skips org work when the org lock is already held", async () => {
    const getSummary = jest.fn();
    const service = createService({
      orgs: [{ id: "org-1" }],
      concurrency: 1,
      getSummary,
      withLock: jest.fn().mockResolvedValue(null),
    });

    await service.evaluate();

    expect(getSummary).not.toHaveBeenCalled();
    expect(recordSchedulerRun).not.toHaveBeenCalled();
  });

  it("records per-org failures without aborting the scheduler tick", async () => {
    const service = createService({
      orgs: [{ id: "org-1" }, { id: "org-2" }],
      concurrency: 2,
      getSummary: jest.fn(async ({ orgId }: { orgId: string }) => {
        if (orgId === "org-1") {
          throw new Error("summary failed");
        }
      }),
    });

    await service.evaluate();

    expect(recordSchedulerRun).toHaveBeenCalledWith(
      "classification_quality_alerts",
      "failure",
    );
    expect(recordSchedulerRun).toHaveBeenCalledWith(
      "classification_quality_alerts",
      "success",
    );
  });
});

function createService(options: {
  orgs: { id: string }[];
  concurrency: number;
  getSummary: jest.Mock;
  withLock?: jest.Mock;
}) {
  const prisma = {
    org: {
      findMany: jest.fn().mockResolvedValue(options.orgs),
    },
  };
  const cache = {
    withLock:
      options.withLock ??
      jest.fn(
        async (_key: string, _ttlMs: number, runner: () => Promise<any>) =>
          runner(),
      ),
  };
  const schedulerSettings = {
    getRuntimeSettings: jest.fn().mockResolvedValue({
      classificationQualityAlertOrgConcurrency: options.concurrency,
    }),
  };
  const classificationQuality = {
    getSummary: options.getSummary,
  };

  return new ClassificationQualityAlertSchedulerService(
    prisma as any,
    cache as any,
    schedulerSettings as any,
    classificationQuality as any,
  );
}
