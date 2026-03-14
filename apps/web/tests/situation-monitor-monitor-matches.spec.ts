import { describe, expect, it } from 'vitest';

import type { SituationMonitorMatchResult } from '@/app/(app)/situation-monitor/types/situation-monitor-monitors';
import {
  buildMonitorMatchKey,
  collectMonitorMatchesForKeys,
  getDefaultMonitorGeoStatusLabel,
  getDefaultMonitorReasonLabel,
} from '@/app/(app)/situation-monitor/utils/monitor-matches';

function makeMatch(
  patch: Partial<SituationMonitorMatchResult>,
): SituationMonitorMatchResult {
  return {
    itemKey: 'id:item-1',
    itemType: 'headline',
    monitorId: 'monitor-1',
    monitorKind: 'manual',
    monitorName: 'Alpha',
    score: 0.6,
    geoStatus: 'matched',
    matchedTerms: ['chip'],
    reasons: [],
    title: 'Title',
    link: 'https://example.com/a',
    source: 'Example',
    timestamp: 1,
    ...patch,
  };
}

describe('situation-monitor monitor matches', () => {
  it('prefers item meta ids when building keys', () => {
    expect(buildMonitorMatchKey(' item-1 ', 'https://example.com/a', 'Title')).toBe(
      'id:item-1',
    );
  });

  it('falls back to link and title when item id is missing', () => {
    expect(buildMonitorMatchKey(undefined, 'https://example.com/a', 'Title')).toBe(
      'link:https://example.com/a::Title',
    );
  });

  it('dedupes multiple keys by monitor id and keeps the highest score', () => {
    const map = new Map<string, SituationMonitorMatchResult[]>([
      [
        'id:item-1',
        [
          makeMatch({ monitorId: 'monitor-1', monitorName: 'Alpha', score: 0.61 }),
          makeMatch({ monitorId: 'monitor-2', monitorName: 'Beta', score: 0.52 }),
        ],
      ],
      [
        'id:item-2',
        [
          makeMatch({ monitorId: 'monitor-1', monitorName: 'Alpha', score: 0.88 }),
          makeMatch({ monitorId: 'monitor-3', monitorName: 'Gamma', score: 0.41 }),
        ],
      ],
    ]);

    expect(collectMonitorMatchesForKeys(map, ['id:item-1', 'id:item-2'])).toEqual([
      expect.objectContaining({ monitorId: 'monitor-1', score: 0.88 }),
      expect.objectContaining({ monitorId: 'monitor-2', score: 0.52 }),
      expect.objectContaining({ monitorId: 'monitor-3', score: 0.41 }),
    ]);
  });

  it('provides stable default labels for reason and geo status', () => {
    expect(getDefaultMonitorReasonLabel('rerank')).toBe('Rerank accepted');
    expect(getDefaultMonitorGeoStatusLabel('country_match')).toBe('Country matched');
  });
});
