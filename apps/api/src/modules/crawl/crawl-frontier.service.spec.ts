import { CrawlFrontierService } from './crawl-frontier.service';
import { normalizeCrawlSiteProfileConfig } from './crawl-frontier.utils';
import { CrawlStrategyLayeredExecutorService } from './crawl-strategy-layered-executor.service';
import { CrawlStrategyRootExecutorService } from './crawl-strategy-root-executor.service';

function createService(options?: {
  layeredExecutor?: CrawlStrategyLayeredExecutorService;
  strategyRecorder?: Record<string, jest.Mock>;
}) {
  const layeredExecutor =
    options?.layeredExecutor ??
    new CrawlStrategyLayeredExecutorService({} as any, {} as any, {} as any);
  const strategyRecorder = options?.strategyRecorder ?? ({} as any);
  const rootExecutor = new CrawlStrategyRootExecutorService(
    layeredExecutor,
    strategyRecorder as any,
  );
  return {
    layeredExecutor,
    strategyRecorder,
    rootExecutor,
    service: new CrawlFrontierService(
      {} as any,
      {} as any,
      {} as any,
      layeredExecutor,
      rootExecutor,
      strategyRecorder as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
    ),
  };
}

describe('CrawlFrontierService layered extraction tracing', () => {
  it('produces candidate-level decisions for low-score and trimmed layered candidates', () => {
    const { service } = createService();

    const extraction = (service as any).extractCandidates(
      {
        id: 'node-1',
        url: 'https://example.com/news',
        pageType: 'category',
      },
      normalizeCrawlSiteProfileConfig({
        allowedHosts: ['example.com'],
        layeredOptions: {
          scoreThreshold: 1,
          maxChildrenPerNode: 1,
        },
      }),
      [
        {
          url: 'https://example.com/news',
          links: {
            internal: [
              { href: '/news/high-a', text: 'High A', totalScore: 0.9 },
              { href: '/news/high-b', text: 'High B', totalScore: 0.8 },
              { href: '/news/low', text: 'Low', totalScore: -0.5 },
            ],
          },
        },
      ],
    );

    expect(extraction.candidates).toHaveLength(1);
    expect(extraction.diagnostics.rejectionCounts.low_score).toBe(1);
    expect(extraction.diagnostics.rejectionCounts.max_children_trimmed).toBe(1);
    expect(extraction.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'active',
          action: 'discovered',
          ruleHits: ['layered_candidate_selected'],
        }),
        expect.objectContaining({
          rejectedReason: 'low_score',
          nodeType: 'budget-control',
          status: 'rejected',
        }),
        expect.objectContaining({
          rejectedReason: 'max_children_trimmed',
          nodeType: 'budget-control',
          status: 'rejected',
        }),
      ]),
    );
  });

  it('records root seed branch completion as an explicit workflow event', async () => {
    const strategyRecorder = {
      appendEvent: jest.fn(),
    };
    const { service } = createService({
      strategyRecorder,
    });

    await (service as any).recordRootSeedBranchEvent({
      workflowRunId: 'workflow-run-1',
      node: {
        id: 'node-root',
        depth: 0,
        pageType: 'home',
      },
      seedStrategy: 'frontier_first',
      seedDiscovery: {
        created: 2,
        selectedPageTypeCounts: {
          home: 0,
          category: 0,
          list: 1,
          article: 1,
        },
        diagnostics: {
          candidateStats: {
            accepted: 5,
          },
          fallbackStage: 'seed',
          seedDiscoveryMode: 'robots',
          seedQuality: {
            passed: true,
          },
        },
      },
    });

    expect(strategyRecorder.appendEvent).toHaveBeenCalledWith(
      'workflow-run-1',
      expect.objectContaining({
        eventType: 'seed_branch_completed',
        triggerReason: 'seed_selected',
        beforeCount: 5,
        afterCount: 2,
        rescuedCount: 2,
      }),
    );
  });

  it('records native fallback as both a workflow step and event', async () => {
    const strategyRecorder = {
      appendEvent: jest.fn(),
      upsertStep: jest.fn(),
    };
    const { service } = createService({
      strategyRecorder,
    });

    await (service as any).recordNativeFallbackExecution({
      workflowRunId: 'workflow-run-1',
      node: {
        id: 'node-root',
      },
      createdCount: 1,
      minAcceptedResults: 3,
      minArticleResults: 2,
      nativeAcceptedArticles: 1,
      fallbackDiscoveryMetadata: {
        candidateStats: {
          selected: 2,
          rejected: 1,
        },
        rejectionCounts: {
          low_score: 1,
        },
      },
      triggerReason: 'native_accepted_below_threshold',
    });

    expect(strategyRecorder.upsertStep).toHaveBeenCalledWith(
      'workflow-run-1',
      expect.objectContaining({
        stepKey: 'frontier:node-root:native-fallback',
        nodeType: 'fallback-strategy',
        outputCount: 2,
        rejectedCount: 1,
      }),
    );
    expect(strategyRecorder.appendEvent).toHaveBeenCalledWith(
      'workflow-run-1',
      expect.objectContaining({
        eventType: 'native_to_layered_fallback',
        triggerReason: 'native_accepted_below_threshold',
        beforeCount: 1,
        afterCount: 3,
        rescuedCount: 2,
      }),
    );
  });

  it('records queued LLM judge candidate traces before async resolution', async () => {
    const { layeredExecutor, service } = createService();
    const recordCandidateDecisionSpy = jest
      .spyOn(layeredExecutor, 'recordCandidateDecision')
      .mockResolvedValue(undefined);

    await (service as any).recordQueuedLlmCandidateDecisions({
      workflowRunId: 'workflow-run-1',
      node: { id: 'node-root' },
      mode: 'seed',
      queuedAt: '2026-03-21T10:00:00.000Z',
      candidates: [
        {
          url: 'https://example.com/news/a',
          pageType: 'article',
          score: 1.2,
          freshnessScore: 0.8,
          metadata: {},
        },
      ],
    });

    expect(recordCandidateDecisionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowRunId: 'workflow-run-1',
        nodeType: 'branch',
        action: 'branched',
        ruleHits: ['llm_judge_deferred'],
        beforeSnapshot: expect.objectContaining({
          status: 'active',
          score: 1.2,
        }),
        afterSnapshot: expect.objectContaining({
          status: 'active',
          score: 1.2,
        }),
      }),
    );
  });

  it('records resolved LLM judge traces for dropped and retyped candidates', async () => {
    const { layeredExecutor, service } = createService();
    const recordCandidateDecisionSpy = jest
      .spyOn(layeredExecutor, 'recordCandidateDecision')
      .mockResolvedValue(undefined);

    await (service as any).recordResolvedLlmCandidateDecisions({
      workflowRunId: 'workflow-run-1',
      node: { id: 'node-root' },
      mode: 'discovery',
      inputCandidates: [
        {
          url: 'https://example.com/news/a',
          pageType: 'list',
          score: 0.9,
          freshnessScore: 0.4,
          metadata: {},
        },
        {
          url: 'https://example.com/news/b',
          pageType: 'list',
          score: 0.8,
          freshnessScore: 0.3,
          metadata: {},
        },
      ],
      resolvedCandidates: [
        {
          url: 'https://example.com/news/a',
          pageType: 'article',
          score: 1.1,
          freshnessScore: 0.4,
          metadata: {
            judgeMethod: 'llm',
          },
        },
      ],
      llmDiagnostics: {
        llmJudgeParsed: true,
        llmJudgeDecisions: [
          {
            url: 'https://example.com/news/a',
            action: 'fetch',
            confidence: 0.92,
            reason: 'story detail',
          },
          {
            url: 'https://example.com/news/b',
            action: 'drop',
            confidence: 0.95,
            appliedDrop: true,
            reason: 'utility page',
          },
        ],
      },
    });

    expect(recordCandidateDecisionSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        candidate: expect.objectContaining({
          url: 'https://example.com/news/a',
          pageType: 'article',
        }),
        action: 'branched',
        ruleHits: expect.arrayContaining(['llm_judge_resolved', 'llm_action:fetch', 'llm_judge_retyped']),
        scoreDelta: 0.2,
        beforeSnapshot: expect.objectContaining({
          pageType: 'list',
          status: 'active',
        }),
        afterSnapshot: expect.objectContaining({
          pageType: 'article',
          status: 'active',
        }),
      }),
    );
    expect(recordCandidateDecisionSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        candidate: expect.objectContaining({
          url: 'https://example.com/news/b',
        }),
        action: 'branched',
        rejectedReason: 'llm_judge_drop',
        ruleHits: ['llm_judge_resolved', 'llm_judge_drop'],
        afterSnapshot: expect.objectContaining({
          status: 'rejected',
          rejectedReason: 'llm_judge_drop',
        }),
      }),
    );
  });
});
