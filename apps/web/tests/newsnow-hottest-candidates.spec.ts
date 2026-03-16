import { describe, expect, it } from 'vitest';

import {
  NewsnowDataState,
  NewsnowDomesticOpinionEmptyReason,
} from '../app/(app)/newsnow/lib/newsnow-analysis-access';
import { buildDomesticOpinionSparklinePath, shouldShowDomesticOpinionPanel } from '../app/(app)/newsnow/lib/newsnow-domestic-opinion';

describe('newsnow domestic opinion helpers', () => {
  it('builds a deterministic sparkline path for trend values', () => {
    const path = buildDomesticOpinionSparklinePath([0.2, 0.6, 0.4], 220, 60);

    expect(path).toMatch(/^M /);
    expect(path).toContain('L');
  });

  it('decides when the domestic opinion panel should be visible', () => {
    expect(
      shouldShowDomesticOpinionPanel({
        domesticOpinion: {
          generatedAt: '2026-03-13T10:00:00.000Z',
          dataState: NewsnowDataState.Ready,
          emptyReason: null,
          diagnostics: {
            requestedHours: 24,
            snapshotCount: 1,
            pipelineBucketCount: 0,
          },
          latest: {
            bucketStart: '2026-03-13T10:00:00.000Z',
            indexValue: 0.64,
            attentionScore: 0.61,
            breadthScore: 0.58,
            freshnessScore: 0.62,
            sentimentPressure: 0.24,
            candidateCount: 3,
          },
          trend: [],
          topKeywords: [],
          topCandidates: [],
          breakdown: {
            latest: {
              bucketStart: '2026-03-13T10:00:00.000Z',
              newsnow: {
                bucketStart: '2026-03-13T10:00:00.000Z',
                indexValue: 0.64,
                attentionScore: 0.61,
                breadthScore: 0.58,
                freshnessScore: 0.62,
                sentimentPressure: 0.24,
                candidateCount: 3,
              },
              pipeline: null,
            },
            trend: [],
            topKeywords: {
              newsnow: [],
              pipeline: [],
            },
          },
        },
      }),
    ).toBe(true);
    expect(
      shouldShowDomesticOpinionPanel({
        domesticOpinion: {
          generatedAt: '2026-03-13T10:00:00.000Z',
          dataState: NewsnowDataState.Empty,
          emptyReason:
            NewsnowDomesticOpinionEmptyReason.NoRecentSnapshotsOrPipelineData,
          diagnostics: {
            requestedHours: 24,
            snapshotCount: 0,
            pipelineBucketCount: 0,
          },
          latest: null,
          trend: [],
          topKeywords: [],
          topCandidates: [],
          breakdown: {
            latest: null,
            trend: [],
            topKeywords: {
              newsnow: [],
              pipeline: [],
            },
          },
        },
      }),
    ).toBe(true);
    expect(
      shouldShowDomesticOpinionPanel({
        isError: true,
      }),
    ).toBe(true);
    expect(
      shouldShowDomesticOpinionPanel({
        isLoading: true,
      }),
    ).toBe(true);
    expect(
      shouldShowDomesticOpinionPanel({
        domesticOpinion: undefined,
      }),
    ).toBe(false);
  });

  it('returns an empty sparkline path for empty trend values', () => {
    expect(buildDomesticOpinionSparklinePath([], 220, 60)).toBe('');
  });

  it('returns null-like visibility when no state is present', () => {
    expect(
      shouldShowDomesticOpinionPanel({
        domesticOpinion: undefined,
        isLoading: false,
        isError: false,
      }),
    ).toBe(false);
  });
});
