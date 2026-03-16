import { describe, expect, it } from 'vitest';

import {
  canReadNewsnowAnalysis,
  NewsnowAnalysisAccessKind,
  NewsnowDomesticOpinionEmptyReason,
  NewsnowHottestAnalysisEmptyReason,
  describeDomesticOpinionEmptyReason,
  describeHottestAnalysisEmptyReason,
  getNewsnowAnalysisAccessState,
  getNewsnowAnalysisPermissions,
} from '../app/(app)/newsnow/lib/newsnow-analysis-access';

describe('newsnow analysis access helpers', () => {
  it('extracts permissions from session payloads', () => {
    expect(
      getNewsnowAnalysisPermissions({
        permissions: ['items.read'],
      }),
    ).toEqual(['items.read']);
    expect(
      getNewsnowAnalysisPermissions({
        user: {
          permissions: ['items.write'],
        },
      }),
    ).toEqual(['items.write']);
    expect(getNewsnowAnalysisPermissions(undefined)).toEqual([]);
  });

  it('derives access state from auth status and permissions', () => {
    expect(getNewsnowAnalysisAccessState('loading', [])).toEqual({
      canQuery: false,
      kind: NewsnowAnalysisAccessKind.Loading,
    });
    expect(getNewsnowAnalysisAccessState('unauthenticated', [])).toEqual({
      canQuery: false,
      kind: NewsnowAnalysisAccessKind.Unauthenticated,
    });
    expect(getNewsnowAnalysisAccessState('authenticated', [])).toEqual({
      canQuery: false,
      kind: NewsnowAnalysisAccessKind.Forbidden,
    });
    expect(getNewsnowAnalysisAccessState('authenticated', ['items.read'])).toEqual({
      canQuery: true,
      kind: NewsnowAnalysisAccessKind.Available,
    });
    expect(getNewsnowAnalysisAccessState('authenticated', ['items.write'])).toEqual({
      canQuery: false,
      kind: NewsnowAnalysisAccessKind.Forbidden,
    });
  });

  it('requires items.read for NewsNow analysis access', () => {
    expect(canReadNewsnowAnalysis(['items.read'])).toBe(true);
    expect(canReadNewsnowAnalysis(['items.write'])).toBe(false);
  });

  it('describes hottest analysis empty reasons', () => {
    expect(
      describeHottestAnalysisEmptyReason(
        NewsnowHottestAnalysisEmptyReason.AllSourcesFailed,
      ),
    ).toContain('抓取全部失败');
  });

  it('describes domestic opinion empty reasons', () => {
    expect(
      describeDomesticOpinionEmptyReason(
        NewsnowDomesticOpinionEmptyReason.NoRecentSnapshotsOrPipelineData,
      ),
    ).toContain('热榜快照');
  });
});
