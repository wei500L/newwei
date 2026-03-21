import { normalizeCrawlSiteProfileConfig } from './crawl-frontier.utils';
import { CrawlStrategyLayeredExecutorService } from './crawl-strategy-layered-executor.service';

describe('CrawlStrategyLayeredExecutorService', () => {
  it('records seed-to-frontier fallback when seed materialization fails the quality gate', async () => {
    const strategyRecorder = {
      appendEvent: jest.fn(),
      upsertStep: jest.fn(),
      recordCandidateTrace: jest.fn(),
    } as any;
    const service = new CrawlStrategyLayeredExecutorService(
      {
        crawlFrontierNode: {
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn(),
        },
      } as any,
      {
        enqueueFrontierNode: jest.fn(),
      } as any,
      strategyRecorder,
    );

    const outcome = await service.materializeSeedCandidates({
      workflowRunId: 'workflow-run-1',
      node: {
        id: 'node-1',
        orgId: 'org-1',
      } as any,
      run: {
        id: 'run-1',
        seedUrl: 'https://example.com',
        maxDepth: 3,
        maxPages: 10,
      },
      taskId: 'task-1',
      profile: {
        id: 'profile-1',
        config: normalizeCrawlSiteProfileConfig({}),
      } as any,
      candidates: [
        {
          url: 'https://example.com/news/a',
          pageType: 'article',
          score: 1.2,
          freshnessScore: 0.9,
          metadata: {},
        },
        {
          url: 'https://example.com/news/b',
          pageType: 'article',
          score: 1.1,
          freshnessScore: 0.8,
          metadata: {},
        },
      ],
      sitemapDiagnostics: {
        seedMethod: 'sitemap',
        discoveryMode: 'robots',
      },
      qualityThresholds: {
        minCandidates: 3,
      },
      discoveredCount: 2,
    });

    expect(outcome.created).toBe(0);
    expect(outcome.diagnostics.fallbackStage).toBe('frontier');
    expect(strategyRecorder.appendEvent).toHaveBeenCalledWith(
      'workflow-run-1',
      expect.objectContaining({
        eventType: 'seed_to_frontier_fallback',
        triggerReason: 'seed_low_quality',
      }),
    );
    expect(strategyRecorder.recordCandidateTrace).toHaveBeenCalledWith(
      'workflow-run-1',
      expect.objectContaining({
        url: 'https://example.com/news/a',
      }),
      expect.objectContaining({
        action: 'filtered',
        rejectedReason: 'seed_low_quality',
        beforeSnapshot: expect.objectContaining({ status: 'active' }),
        afterSnapshot: expect.objectContaining({
          status: 'rejected',
          rejectedReason: 'seed_low_quality',
        }),
      }),
    );
  });

  it('records native root candidate traces across classify, score, budget and persist', async () => {
    const strategyRecorder = {
      appendEvent: jest.fn(),
      upsertStep: jest.fn(),
      recordCandidateTrace: jest.fn(),
    } as any;
    const prisma = {
      crawlFrontierNode: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'frontier-node-1' }),
      },
    } as any;
    const service = new CrawlStrategyLayeredExecutorService(
      prisma,
      {
        enqueueFrontierNode: jest.fn(),
      } as any,
      strategyRecorder,
    );

    const result = await service.materializeNativeDiscoveryCandidates({
      workflowRunId: 'workflow-run-1',
      node: {
        id: 'node-root',
        orgId: 'org-1',
        url: 'https://example.com',
        pageType: 'home',
      } as any,
      run: {
        id: 'run-1',
        maxDepth: 3,
        maxPages: 10,
      },
      profile: {
        id: 'profile-1',
        config: normalizeCrawlSiteProfileConfig({
          allowedHosts: ['example.com'],
        }),
      } as any,
      persistedResults: [
        {
          id: 'crawl-result-1',
          sourceUrl: 'https://example.com/2026/03/21/story',
        },
      ],
      rawResultsByUrl: new Map([
        [
          'https://example.com/2026/03/21/story',
          {
            url: 'https://example.com/2026/03/21/story',
            statusCode: 200,
          },
        ],
      ]),
    });

    expect(result.acceptedCount).toBe(1);
    expect(result.createdCount).toBe(1);
    expect(prisma.crawlFrontierNode.create).toHaveBeenCalledTimes(1);
    expect(
      strategyRecorder.recordCandidateTrace.mock.calls.map((call: unknown[]) => call[2].action),
    ).toEqual(['classified', 'scored', 'budgeted', 'persisted']);
    expect(strategyRecorder.recordCandidateTrace).toHaveBeenLastCalledWith(
      'workflow-run-1',
      expect.objectContaining({
        url: 'https://example.com/2026/03/21/story',
      }),
      expect.objectContaining({
        action: 'persisted',
        afterSnapshot: expect.objectContaining({
          status: 'selected',
        }),
      }),
    );
    expect(strategyRecorder.upsertStep).toHaveBeenCalledWith(
      'workflow-run-1',
      expect.objectContaining({
        stepKey: 'frontier:node-root:materialize-native',
        nodeType: 'persist-result',
        outputCount: 1,
      }),
    );
  });

  it('scores native candidates before rejecting them by production budget', async () => {
    const strategyRecorder = {
      appendEvent: jest.fn(),
      upsertStep: jest.fn(),
      recordCandidateTrace: jest.fn(),
    } as any;
    const service = new CrawlStrategyLayeredExecutorService(
      {
        crawlFrontierNode: {
          findMany: jest.fn().mockResolvedValue([
            {
              canonicalUrl: 'https://example.com/existing',
              urlFingerprint: 'https://example.com/existing',
              pageType: 'article',
            },
          ]),
          create: jest.fn(),
        },
      } as any,
      {
        enqueueFrontierNode: jest.fn(),
      } as any,
      strategyRecorder,
    );

    const result = await service.materializeNativeDiscoveryCandidates({
      workflowRunId: 'workflow-run-1',
      node: {
        id: 'node-root',
        orgId: 'org-1',
        url: 'https://example.com',
        pageType: 'home',
      } as any,
      run: {
        id: 'run-1',
        maxDepth: 3,
        maxPages: 1,
      },
      profile: {
        id: 'profile-1',
        config: normalizeCrawlSiteProfileConfig({
          allowedHosts: ['example.com'],
        }),
      } as any,
      persistedResults: [
        {
          id: 'crawl-result-1',
          sourceUrl: 'https://example.com/2026/03/21/story',
        },
      ],
      rawResultsByUrl: new Map([
        [
          'https://example.com/2026/03/21/story',
          {
            url: 'https://example.com/2026/03/21/story',
            statusCode: 200,
          },
        ],
      ]),
    });

    expect(result.createdCount).toBe(0);
    expect(
      strategyRecorder.recordCandidateTrace.mock.calls.map((call: unknown[]) => call[2].action),
    ).toEqual(['classified', 'scored', 'budgeted']);
    expect(strategyRecorder.recordCandidateTrace).toHaveBeenLastCalledWith(
      'workflow-run-1',
      expect.objectContaining({
        url: 'https://example.com/2026/03/21/story',
      }),
      expect.objectContaining({
        action: 'budgeted',
        rejectedReason: 'run_budget_exhausted',
        beforeSnapshot: expect.objectContaining({
          score: expect.any(Number),
          freshnessScore: expect.any(Number),
          status: 'active',
        }),
        afterSnapshot: expect.objectContaining({
          score: expect.any(Number),
          freshnessScore: expect.any(Number),
          status: 'rejected',
          rejectedReason: 'run_budget_exhausted',
        }),
      }),
    );
  });
});
