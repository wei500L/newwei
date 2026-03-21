import { NotFoundException } from '@nestjs/common';

import { normalizeCrawlSiteProfileConfig } from './crawl-frontier.utils';
import { CrawlStrategyRuntimeService } from './crawl-strategy-runtime.service';
import { CrawlStrategyWorkflowNodeType } from './crawl-strategy.types';

describe('CrawlStrategyRuntimeService.replayRun', () => {
  it('replays bound workflow runs against the original version and inputs', async () => {
    const recorder = {
      getRun: jest.fn().mockResolvedValue({
        id: 'run-1',
        workflow: { id: 'wf-1', name: 'Workflow A' },
        workflowVersion: { id: 'ver-2', version: 2, name: 'Version 2' },
        input: {
          seedUrl: 'https://example.com/news',
          profileId: 'profile-1',
          maxCandidates: 50,
        },
        graphSnapshot: {},
      }),
    } as any;
    const service = new CrawlStrategyRuntimeService(
      {} as any,
      {} as any,
      recorder,
      {} as any,
    );
    const trialRunSpy = jest
      .spyOn(service, 'trialRunWorkflow')
      .mockResolvedValue({ runId: 'replay-1' } as any);

    await service.replayRun('org-1', 'user-1', 'run-1');

    expect(trialRunSpy).toHaveBeenCalledWith('org-1', 'user-1', 'wf-1', {
      workflowVersionId: 'ver-2',
      seedUrl: 'https://example.com/news',
      profileId: 'profile-1',
      newsSourceId: undefined,
      maxCandidates: 50,
      runKind: 'trial',
    });
  });

  it('returns an explicit error for legacy bridge runs', async () => {
    const recorder = {
      getRun: jest.fn().mockResolvedValue({
        id: 'run-legacy',
        workflow: null,
        workflowVersion: null,
        input: {},
        graphSnapshot: { version: 1 },
      }),
    } as any;
    const service = new CrawlStrategyRuntimeService(
      {} as any,
      {} as any,
      recorder,
      {} as any,
    );

    await expect(
      service.replayRun('org-1', 'user-1', 'run-legacy'),
    ).rejects.toEqual(
      expect.objectContaining<Partial<NotFoundException>>({
        message:
          'Legacy bridge workflow runs are observable but cannot be replayed until they are bound to a published workflow version',
      }),
    );
  });
});

describe('CrawlStrategyRuntimeService candidate trace semantics', () => {
  it('records before/after snapshots across classifier, scorer, budget and persist nodes', () => {
    const service = new CrawlStrategyRuntimeService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const candidate = {
      id: 'candidate:1',
      url: 'https://example.com/news/2026/03/21/story',
      status: 'active',
      rejectedByNodeId: null,
      rejectedReason: null,
      sourceNodeId: 'seed',
      metadata: {},
      trace: [],
    } as any;
    const context = {
      effectiveProfileConfig: normalizeCrawlSiteProfileConfig({}),
    } as any;

    (service as any).executePageTypeClassifier(
      context,
      {
        id: 'classifier',
        type: CrawlStrategyWorkflowNodeType.PageTypeClassifier,
        config: {},
      },
      [candidate],
    );
    (service as any).executeUrlScorer(
      context,
      {
        id: 'scorer',
        type: CrawlStrategyWorkflowNodeType.UrlScorer,
        config: {},
      },
      [candidate],
    );
    const budgeted = (service as any).executeBudgetControl(
      {
        id: 'budget',
        type: CrawlStrategyWorkflowNodeType.BudgetControl,
        config: { minScore: 0, keepTopK: 1 },
      },
      [candidate],
    );
    const persisted = (service as any).executePersistResult(
      {
        id: 'persist',
        type: CrawlStrategyWorkflowNodeType.PersistResult,
        config: { selectTopK: 1 },
      },
      budgeted.outputs.default,
    );

    expect(persisted.outputs.default).toHaveLength(1);
    expect(candidate.status).toBe('selected');
    expect(candidate.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'classifier',
          action: 'classified',
          beforeSnapshot: expect.objectContaining({ pageType: null }),
          afterSnapshot: expect.objectContaining({
            pageType: expect.any(String),
            status: 'active',
          }),
        }),
        expect.objectContaining({
          nodeId: 'scorer',
          action: 'scored',
          scoreDelta: expect.any(Number),
          ruleHits: ['url_scored'],
          beforeSnapshot: expect.objectContaining({ score: null }),
          afterSnapshot: expect.objectContaining({ score: expect.any(Number) }),
        }),
        expect.objectContaining({
          nodeId: 'budget',
          action: 'budgeted',
          ruleHits: ['kept_by_budget'],
          beforeSnapshot: expect.objectContaining({ status: 'active' }),
          afterSnapshot: expect.objectContaining({ status: 'active' }),
        }),
        expect.objectContaining({
          nodeId: 'persist',
          action: 'persisted',
          ruleHits: ['selected_for_persistence'],
          beforeSnapshot: expect.objectContaining({ status: 'active' }),
          afterSnapshot: expect.objectContaining({ status: 'selected' }),
          details: expect.objectContaining({
            selectTopK: 1,
            rank: 1,
          }),
        }),
      ]),
    );
  });
});
