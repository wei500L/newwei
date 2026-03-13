import { NewsnowHottestAnalysisService } from './newsnow-hottest-analysis.service';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createSourceResponse(items: Array<{ id: string; title: string; url: string; info?: string }>) {
  return {
    updatedTime: '2026-03-06T00:00:00.000Z',
    items: items.map((item) => ({
      id: item.id,
      title: item.title,
      url: item.url,
      extra: item.info ? { info: item.info } : undefined,
    })),
  };
}

describe('NewsnowHottestAnalysisService', () => {
  const cacheFactory = () => ({
    get: jest.fn(),
    getMany: jest.fn(),
    set: jest.fn(),
    withLock: jest.fn(),
  });

  const aggregatorFactory = () => ({
    getMetadata: jest.fn(),
    fetchSource: jest.fn(),
    resolveByUrl: jest.fn(),
  });

  const liteLlmFactory = () => ({
    acompletion: jest.fn(),
  });

  const itemsServiceFactory = () => ({
    create: jest.fn(),
  });

  const domesticOpinionIndexFactory = () => ({
    persistSnapshots: jest.fn(),
  });

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('skips auto-bridge creation unless the caller explicitly allows it', async () => {
    const cache = cacheFactory();
    cache.get.mockResolvedValue(null);
    cache.getMany.mockResolvedValue([]);
    cache.set.mockResolvedValue(undefined);
    cache.withLock.mockImplementation(async (_key: string, _ttlMs: number, runner: () => Promise<unknown>) => await runner());

    const aggregator = aggregatorFactory();
    aggregator.getMetadata.mockReturnValue({
      columns: { hottest: { sources: ['thepaper'] } },
      sources: {
        thepaper: { name: 'Reuters', home: 'https://www.reuters.com' },
      },
    });
    aggregator.fetchSource.mockResolvedValue(
      createSourceResponse([
        {
          id: '1',
          title: 'Target story',
          url: 'https://example.com/target-story',
          info: '1000',
        },
      ]),
    );
    aggregator.resolveByUrl.mockResolvedValue({ matched: false });

    const liteLlm = liteLlmFactory();
    liteLlm.acompletion.mockRejectedValue(new Error('llm disabled'));

    const itemsService = itemsServiceFactory();
    const domesticOpinionIndex = domesticOpinionIndexFactory();
    itemsService.create.mockResolvedValue({ id: 'item-1' });

    const service = new NewsnowHottestAnalysisService(
      cache as never,
      aggregator as never,
      liteLlm as never,
      itemsService as never,
      domesticOpinionIndex as never,
    );

    const result = await service.getHottestAnalysis({
      orgId: 'org-1',
      userId: 'user-1',
    });

    expect(itemsService.create).not.toHaveBeenCalled();
    expect(result.bySource.thepaper?.['1']?.bridgeEligible).toBe(true);
    expect(result.bySource.thepaper?.['1']?.bridgeStatus).toBe('eligible');
  });

  it('waits for another in-flight refresh to populate cache instead of rebuilding in parallel', async () => {
    const cacheStore = new Map<string, unknown>();
    const firstRefreshStarted = createDeferred<void>();
    const releaseFirstRefresh = createDeferred<void>();
    let lockHeld = false;

    const cache = cacheFactory();
    cache.get.mockImplementation(async (key: string) => cacheStore.get(key) ?? null);
    cache.getMany.mockResolvedValue([]);
    cache.set.mockImplementation(async (key: string, value: unknown) => {
      cacheStore.set(key, value);
    });
    cache.withLock.mockImplementation(async (_key: string, _ttlMs: number, runner: () => Promise<unknown>) => {
      if (lockHeld) {
        return null;
      }
      lockHeld = true;
      firstRefreshStarted.resolve(undefined);
      try {
        await releaseFirstRefresh.promise;
        return await runner();
      } finally {
        lockHeld = false;
      }
    });

    const aggregator = aggregatorFactory();
    aggregator.getMetadata.mockReturnValue({
      columns: { hottest: { sources: ['source-a'] } },
      sources: {
        'source-a': { name: 'Reuters', home: 'https://www.reuters.com' },
      },
    });
    aggregator.fetchSource.mockResolvedValue(
      createSourceResponse([
        {
          id: '1',
          title: 'Shared refresh target',
          url: 'https://example.com/shared-refresh-target',
          info: '1000',
        },
      ]),
    );
    aggregator.resolveByUrl.mockResolvedValue({ matched: false });

    const liteLlm = liteLlmFactory();
    liteLlm.acompletion.mockRejectedValue(new Error('llm disabled'));

    const itemsService = itemsServiceFactory();
    const domesticOpinionIndex = domesticOpinionIndexFactory();

    const serviceA = new NewsnowHottestAnalysisService(
      cache as never,
      aggregator as never,
      liteLlm as never,
      itemsService as never,
      domesticOpinionIndex as never,
    );
    const serviceB = new NewsnowHottestAnalysisService(
      cache as never,
      aggregator as never,
      liteLlm as never,
      itemsService as never,
      domesticOpinionIndex as never,
    );

    const first = serviceA.getHottestAnalysis({
      orgId: 'org-1',
      userId: 'user-1',
      forceRefresh: true,
    });
    await firstRefreshStarted.promise;
    const second = serviceB.getHottestAnalysis({
      orgId: 'org-1',
      userId: 'user-2',
      forceRefresh: true,
    });

    releaseFirstRefresh.resolve(undefined);

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(aggregator.fetchSource).toHaveBeenCalledTimes(1);
    expect(firstResult.cached).toBe(false);
    expect(secondResult.cached).toBe(true);
  });

  it('resolves existing matches for bridge-eligible targets beyond the prioritized slice', async () => {
    const cache = cacheFactory();
    cache.get.mockResolvedValue(null);
    cache.getMany.mockResolvedValue([]);
    cache.set.mockResolvedValue(undefined);
    cache.withLock.mockImplementation(async (_key: string, _ttlMs: number, runner: () => Promise<unknown>) => await runner());

    const sourceIds = Array.from({ length: 49 }, (_, index) => `source-${index + 1}`);
    const targetUrl = 'https://example.com/existing-target';

    const aggregator = aggregatorFactory();
    aggregator.getMetadata.mockReturnValue({
      columns: { hottest: { sources: [...sourceIds, 'thepaper'] } },
      sources: Object.fromEntries([
        ...sourceIds.map((sourceId) => [sourceId, { name: sourceId, home: `https://${sourceId}.example.com` }]),
        ['thepaper', { name: 'Reuters', home: 'https://www.reuters.com' }],
      ]),
    });
    aggregator.fetchSource.mockImplementation(async (sourceId: string) => {
      if (sourceId === 'thepaper') {
        return createSourceResponse([
          {
            id: '1',
            title: 'Thepaper rank one',
            url: 'newsnow://thepaper/one',
            info: '1000',
          },
          {
            id: '2',
            title: 'Thepaper rank two',
            url: 'newsnow://thepaper/two',
            info: '900',
          },
          {
            id: '3',
            title: 'Thepaper rank three target',
            url: targetUrl,
            info: '800',
          },
        ]);
      }

      return createSourceResponse([
        {
          id: `${sourceId}-1`,
          title: `${sourceId} rank one`,
          url: `https://example.com/${sourceId}/1`,
          info: '1000',
        },
        {
          id: `${sourceId}-2`,
          title: `${sourceId} rank two`,
          url: `https://example.com/${sourceId}/2`,
          info: '900',
        },
      ]);
    });
    aggregator.resolveByUrl.mockImplementation(async (url: string) => {
      if (url === targetUrl) {
        return {
          matched: true,
          itemId: 'existing-item-1',
          matchedUrl: targetUrl,
        };
      }
      return { matched: false };
    });

    const liteLlm = liteLlmFactory();
    liteLlm.acompletion.mockRejectedValue(new Error('llm disabled'));

    const itemsService = itemsServiceFactory();
    const domesticOpinionIndex = domesticOpinionIndexFactory();
    itemsService.create.mockResolvedValue({ id: 'new-item-1' });

    const service = new NewsnowHottestAnalysisService(
      cache as never,
      aggregator as never,
      liteLlm as never,
      itemsService as never,
      domesticOpinionIndex as never,
    );

    const result = await service.getHottestAnalysis({
      orgId: 'org-1',
      userId: 'user-1',
      allowAutoBridge: true,
    });

    expect(aggregator.resolveByUrl).toHaveBeenCalledWith(targetUrl);
    expect(itemsService.create).not.toHaveBeenCalled();
    expect(result.bySource.thepaper?.['3']?.bridgeStatus).toBe('existing');
    expect(result.bySource.thepaper?.['3']?.matchedItemId).toBe('existing-item-1');
  });
});
