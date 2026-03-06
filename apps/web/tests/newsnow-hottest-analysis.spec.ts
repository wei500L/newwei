import { describe, expect, it } from 'vitest';

import {
  buildItemAnalysisBadges,
  selectTopHottestCandidates,
} from '../app/(app)/newsnow/lib/newsnow-hottest-analysis';

describe('newsnow hottest analysis helpers', () => {
  it('builds item badges from analysis state', () => {
    expect(
      buildItemAnalysisBadges({
        sourceId: 'weibo',
        itemId: '1',
        clusterId: 'cluster-1',
        theme: 'OpenAI 新模型',
        candidateLabel: 'OpenAI 新模型',
        candidateSummary: null,
        reason: null,
        topics: [],
        entities: ['OpenAI'],
        contentKind: 'article',
        sourceCount: 3,
        heatScore: 0.8,
        freshnessScore: 0.9,
        candidateScore: 0.85,
        isNew: true,
        isRising: false,
        bridgeEligible: true,
        bridgeStatus: 'eligible',
      }),
    ).toEqual([
      { key: 'theme', label: 'OpenAI 新模型', tone: 'violet' },
      { key: 'cross-source', label: '跨源 3', tone: 'amber' },
      { key: 'new', label: '新热', tone: 'emerald' },
      { key: 'eligible', label: '可深读', tone: 'slate' },
    ]);
  });

  it('sorts candidates by score then support', () => {
    const selected = selectTopHottestCandidates(
      [
        {
          candidateId: 'b',
          label: 'B',
          summary: null,
          reason: null,
          themes: [],
          entities: [],
          sourceIds: ['a'],
          sourceCount: 1,
          itemCount: 2,
          heatScore: 0.7,
          freshnessScore: 0.6,
          candidateScore: 0.72,
          itemRefs: [],
        },
        {
          candidateId: 'a',
          label: 'A',
          summary: null,
          reason: null,
          themes: [],
          entities: [],
          sourceIds: ['a', 'b'],
          sourceCount: 2,
          itemCount: 2,
          heatScore: 0.7,
          freshnessScore: 0.6,
          candidateScore: 0.82,
          itemRefs: [],
        },
      ],
      1,
    );

    expect(selected.map((item) => item.candidateId)).toEqual(['a']);
  });
});
