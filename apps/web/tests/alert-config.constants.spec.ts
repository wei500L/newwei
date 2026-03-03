import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SYSTEM_METRIC_SLUG,
  SYSTEM_METRIC_SLUGS,
  systemMetricSlugs,
} from '@/app/(app)/dashboard/alert-config.constants';

describe('alert-config system metric presets', () => {
  it('maps exactly to shared system metric slugs', () => {
    expect(systemMetricSlugs.map((option) => option.value)).toEqual(
      Array.from(SYSTEM_METRIC_SLUGS),
    );
  });

  it('includes OREF system metric slugs', () => {
    const values = systemMetricSlugs.map((option) => option.value);

    expect(values).toEqual(
      expect.arrayContaining([
        'situation.oref.active_alerts',
        'situation.oref.history_24h',
      ]),
    );
  });

  it('keeps the default system metric slug in the preset list', () => {
    expect(SYSTEM_METRIC_SLUGS).toContain(DEFAULT_SYSTEM_METRIC_SLUG);
    expect(systemMetricSlugs.some((option) => option.value === DEFAULT_SYSTEM_METRIC_SLUG)).toBe(
      true,
    );
  });
});
