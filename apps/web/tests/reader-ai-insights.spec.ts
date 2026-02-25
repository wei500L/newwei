import { describe, expect, it } from 'vitest';

import { buildReaderAiInsights } from '../app/(reader)/read/items/[id]/reader-ai-insights';

describe('reader ai insights', () => {
  it('extracts timeline, actors and relations from processed result', () => {
    const insights = buildReaderAiInsights({
      published_at: '2026-02-24T10:00:00.000Z',
      summary: '公司盈利增长，但同时面临监管调查风险。',
      sentiment_label: 'neutral',
      quality_score: 0.82,
      key_points: ['2月24日 公司宣布上调全年指引', '同日监管机构启动调查'],
      entities: [
        { name: '示例公司', type: 'company', confidence: 0.92 },
        { name: '监管机构', type: 'organization', confidence: 0.8 }
      ],
      kg_relations: [
        {
          subject: { name: '示例公司', type: 'company' },
          predicate: 'affects_company',
          object: { name: '上游行业', type: 'industry' },
          confidence: 0.74,
          evidence: '原文证据'
        }
      ]
    });

    expect(insights.hasData).toBe(true);
    expect(insights.timeline.length).toBeGreaterThan(0);
    expect(insights.actors.map((actor) => actor.name)).toContain('示例公司');
    expect(insights.relations[0]?.predicate).toBe('affects_company');
    expect(insights.controversies.length).toBeGreaterThan(0);
  });

  it('returns empty structure when result is invalid', () => {
    const insights = buildReaderAiInsights(null);

    expect(insights.hasData).toBe(false);
    expect(insights.actors).toEqual([]);
    expect(insights.relations).toEqual([]);
    expect(insights.timeline).toEqual([]);
    expect(insights.controversies).toEqual([]);
  });
});
