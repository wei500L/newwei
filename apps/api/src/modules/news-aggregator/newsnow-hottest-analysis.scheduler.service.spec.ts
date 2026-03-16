import { NewsnowHottestAnalysisSchedulerService } from './newsnow-hottest-analysis.scheduler.service';

describe('NewsnowHottestAnalysisSchedulerService', () => {
  const prisma = {
    org: {
      findMany: jest.fn(),
    },
  };
  const cache = {
    withLock: jest.fn(),
  };
  const globalSnapshot = {
    signature: 'signature-1',
    generatedAt: '2026-03-16T00:00:00.000Z',
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
    prisma.org.findMany.mockResolvedValue([
      { id: 'org-1' },
      { id: 'org-2' },
    ]);
    cache.withLock.mockImplementation(
      async (_key: string, _ttlMs: number, runner: () => Promise<unknown>) =>
        await runner(),
    );
    hottestAnalysis.ensureGlobalSnapshot.mockResolvedValue(globalSnapshot);
    hottestAnalysis.refreshProjectionForOrg.mockResolvedValue(undefined);
    service = new NewsnowHottestAnalysisSchedulerService(
      prisma as never,
      cache as never,
      hottestAnalysis as never,
    );
  });

  it('builds one global snapshot and refreshes each org projection inside a scheduler lock', async () => {
    await service.refreshScheduled();

    expect(prisma.org.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      select: { id: true },
    });
    expect(cache.withLock).toHaveBeenCalledWith(
      'cron:newsnow-hottest-analysis',
      expect.any(Number),
      expect.any(Function),
    );
    expect(hottestAnalysis.ensureGlobalSnapshot).toHaveBeenCalledTimes(1);
    expect(hottestAnalysis.refreshProjectionForOrg).toHaveBeenCalledTimes(2);
    expect(hottestAnalysis.refreshProjectionForOrg).toHaveBeenNthCalledWith(1, {
      orgId: 'org-1',
      allowAutoBridge: false,
      globalSnapshot,
    });
    expect(hottestAnalysis.refreshProjectionForOrg).toHaveBeenNthCalledWith(2, {
      orgId: 'org-2',
      allowAutoBridge: false,
      globalSnapshot,
    });
  });

  it('continues refreshing remaining orgs when one org fails', async () => {
    hottestAnalysis.refreshProjectionForOrg
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    await service.refreshScheduled();

    expect(hottestAnalysis.refreshProjectionForOrg).toHaveBeenCalledTimes(2);
  });

  it('skips scheduler work when there are no active orgs', async () => {
    prisma.org.findMany.mockResolvedValue([]);

    await service.refreshScheduled();

    expect(cache.withLock).not.toHaveBeenCalled();
    expect(hottestAnalysis.ensureGlobalSnapshot).not.toHaveBeenCalled();
    expect(hottestAnalysis.refreshProjectionForOrg).not.toHaveBeenCalled();
  });
});
