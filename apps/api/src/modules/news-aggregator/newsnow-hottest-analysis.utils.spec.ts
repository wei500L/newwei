import { describe, expect, it } from '@jest/globals';

import {
  buildBridgeExternalId,
  buildGlobalInputSignature,
  buildHeuristicClusters,
  buildSignalKey,
  computeCandidateScore,
  computeFreshness,
  computeHeatScore,
  computeTitleSimilarity,
  normalizeTitle,
  parseHeatValue,
} from './newsnow-hottest-analysis.utils';

describe('newsnow hottest analysis utils', () => {
  it('parses chinese heat units', () => {
    expect(parseHeatValue('1016 万热度')).toBe(10_160_000);
    expect(parseHeatValue('6.3万讨论')).toBe(63_000);
    expect(parseHeatValue('1.2亿热度')).toBe(120_000_000);
  });

  it('normalizes title punctuation and casing', () => {
    expect(normalizeTitle(' OpenAI：发布 GPT-5.4！ ')).toBe('openai 发布 gpt 5 4');
  });

  it('scores similar chinese titles above threshold', () => {
    const similarity = computeTitleSimilarity(
      'OpenAI发布最强专业模型GPT-5.4，自动操作电脑',
      'OpenAI发布最强专业模型GPT-5.4 自动操作电脑',
    );
    expect(similarity).toBeGreaterThan(0.7);
  });

  it('clusters cross-source similar titles', () => {
    const cluster = buildHeuristicClusters([
      {
        signalKey: buildSignalKey({ sourceId: 'a', title: 'OpenAI发布最强专业模型GPT-5.4', url: 'https://a.com/1' }),
        sourceId: 'a',
        sourceName: 'A',
        sourceHome: null,
        sourceUpdatedTime: null,
        itemId: '1',
        title: 'OpenAI发布最强专业模型GPT-5.4',
        url: 'https://a.com/1',
        mobileUrl: null,
        hoverSummary: null,
        heatText: '10万热度',
        heatValue: 100_000,
        rank: 1,
        capturedAt: new Date().toISOString(),
        normalizedTitle: normalizeTitle('OpenAI发布最强专业模型GPT-5.4'),
        authority: 0.6,
        state: null,
        isNew: true,
        isRising: false,
        freshnessScore: 1,
      },
      {
        signalKey: buildSignalKey({ sourceId: 'b', title: 'OpenAI发布最强专业模型GPT-5.4 自动操作电脑', url: 'https://b.com/2' }),
        sourceId: 'b',
        sourceName: 'B',
        sourceHome: null,
        sourceUpdatedTime: null,
        itemId: '2',
        title: 'OpenAI发布最强专业模型GPT-5.4 自动操作电脑',
        url: 'https://b.com/2',
        mobileUrl: null,
        hoverSummary: null,
        heatText: '9万热度',
        heatValue: 90_000,
        rank: 2,
        capturedAt: new Date().toISOString(),
        normalizedTitle: normalizeTitle('OpenAI发布最强专业模型GPT-5.4 自动操作电脑'),
        authority: 0.7,
        state: null,
        isNew: true,
        isRising: false,
        freshnessScore: 1,
      },
    ]);

    expect(cluster).toHaveLength(1);
    expect(cluster[0]?.sourceIds).toEqual(['a', 'b']);
  });

  it('boosts freshness for new and rising entries', () => {
    expect(computeFreshness({ nowMs: Date.now(), state: null, rank: 1 })).toMatchObject({
      freshnessScore: 1,
      isNew: true,
    });

    const state = {
      firstSeenAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      lastSeenAt: new Date().toISOString(),
      lastRank: 8,
    };
    const scored = computeFreshness({ nowMs: Date.now(), state, rank: 2 });
    expect(scored.freshnessScore).toBeGreaterThan(0.7);
    expect(scored.isRising).toBe(true);
  });

  it('generates deterministic bridge ids and bounded scores', () => {
    expect(buildBridgeExternalId('weibo', 'https://example.com/article')).toBe(
      buildBridgeExternalId('weibo', 'https://example.com/article'),
    );
    expect(
      computeHeatScore({
        rank: 1,
        rankCap: 10,
        heatValue: 100_000,
        maxHeatValue: 200_000,
        sourceCount: 3,
        authority: 0.5,
      }),
    ).toBeGreaterThan(0.5);
    expect(
      computeCandidateScore({
        heatScore: 0.8,
        freshnessScore: 0.7,
        sourceCount: 3,
        authority: 0.6,
        confidence: 0.9,
      }),
    ).toBeLessThanOrEqual(1);
  });

  it('builds a stable global input signature for identical source payloads', () => {
    const first = buildGlobalInputSignature({
      entries: [
        {
          sourceId: 'source-a',
          failed: false,
          items: [
            {
              id: '1',
              title: 'OpenAI 发布新模型',
              url: 'https://example.com/a',
              heatText: '10万热度',
              rank: 1,
            },
          ],
        },
      ],
    });
    const second = buildGlobalInputSignature({
      entries: [
        {
          sourceId: 'source-a',
          failed: false,
          items: [
            {
              id: '1',
              title: 'OpenAI 发布新模型',
              url: 'https://example.com/a',
              heatText: '10万热度',
              rank: 1,
            },
          ],
        },
      ],
    });

    expect(first).toBe(second);
  });

  it('ignores updated time-only changes in the global input signature', () => {
    const base = buildGlobalInputSignature({
      entries: [
        {
          sourceId: 'source-a',
          failed: false,
          items: [
            {
              id: '1',
              title: 'OpenAI 发布新模型',
              url: 'https://example.com/a',
              heatText: '10万热度',
              rank: 1,
            },
          ],
        },
      ],
    });
    const changed = buildGlobalInputSignature({
      entries: [
        {
          sourceId: 'source-a',
          failed: false,
          items: [
            {
              id: '1',
              title: 'OpenAI 发布新模型',
              url: 'https://example.com/a',
              heatText: '10万热度',
              rank: 1,
            },
          ],
        },
      ],
    });

    expect(changed).toBe(base);
  });

  it('changes the global input signature when rank payload changes', () => {
    const base = buildGlobalInputSignature({
      entries: [
        {
          sourceId: 'source-a',
          failed: false,
          items: [
            {
              id: '1',
              title: 'OpenAI 发布新模型',
              url: 'https://example.com/a',
              heatText: '10万热度',
              rank: 1,
            },
          ],
        },
      ],
    });
    const changed = buildGlobalInputSignature({
      entries: [
        {
          sourceId: 'source-a',
          failed: false,
          items: [
            {
              id: '1',
              title: 'OpenAI 发布新模型',
              url: 'https://example.com/a',
              heatText: '10万热度',
              rank: 2,
            },
          ],
        },
      ],
    });

    expect(changed).not.toBe(base);
  });

  it('does not let error message text change the failure signature', () => {
    const first = buildGlobalInputSignature({
      entries: [
        {
          sourceId: 'source-a',
          failed: true,
          items: [],
        },
      ],
    });
    const second = buildGlobalInputSignature({
      entries: [
        {
          sourceId: 'source-a',
          failed: true,
          items: [],
        },
      ],
    });

    expect(first).toBe(second);
  });

  it('favors cross-source heat and authority in the revised heat score', () => {
    const strongCrossSource = computeHeatScore({
      rank: 3,
      rankCap: 10,
      heatValue: 180_000,
      maxHeatValue: 200_000,
      sourceCount: 4,
      authority: 0.9,
    });
    const singleSource = computeHeatScore({
      rank: 1,
      rankCap: 10,
      heatValue: 20_000,
      maxHeatValue: 200_000,
      sourceCount: 1,
      authority: 0.3,
    });

    expect(strongCrossSource).toBeGreaterThan(singleSource);
  });

  it('keeps candidate ranking sensitive to support and freshness under the new weights', () => {
    const strongCandidate = computeCandidateScore({
      heatScore: 0.78,
      freshnessScore: 0.82,
      sourceCount: 4,
      authority: 0.7,
      confidence: 0.6,
    });
    const weakCandidate = computeCandidateScore({
      heatScore: 0.82,
      freshnessScore: 0.25,
      sourceCount: 1,
      authority: 0.4,
      confidence: 0.6,
    });

    expect(strongCandidate).toBeGreaterThan(weakCandidate);
  });
});
