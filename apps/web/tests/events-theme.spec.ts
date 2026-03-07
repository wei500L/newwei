import { describe, expect, it } from 'vitest';

import {
  resolveEventMetricSurface,
  resolveEventRowSurface,
  resolveFutureEventHintStyle,
} from '../app/(app)/events/components/event-visuals';

describe('events theme visuals', () => {
  it('uses dark, non-white metric surfaces in dark mode', () => {
    const heat = resolveEventMetricSurface('heat', true);
    const credibility = resolveEventMetricSurface('credibility', true);

    expect(String(heat.containerStyle.background)).toContain('rgba(15, 23, 42, 0.94)');
    expect(String(credibility.containerStyle.background)).toContain(
      'rgba(15, 23, 42, 0.94)',
    );
    expect(heat.trailColor).toBe('rgba(127, 29, 29, 0.34)');
    expect(credibility.trailColor).toBe('rgba(6, 78, 59, 0.3)');
  });

  it('uses cyan-accented dark surfaces for scheduled events', () => {
    const futureRow = resolveEventRowSurface({
      heatPercent: 72,
      isDark: true,
      isFutureEvent: true,
    });

    expect(String(futureRow.border)).toContain('103, 232, 249');
    expect(String(futureRow.background)).toContain('rgba(8, 47, 73, 0.92)');
    expect(resolveFutureEventHintStyle(true)).toMatchObject({
      color: '#67e8f9',
      fontWeight: 600,
    });
  });

  it('keeps light theme variants readable', () => {
    const lightMetric = resolveEventMetricSurface('heat', false);
    const lightRow = resolveEventRowSurface({
      heatPercent: 54,
      isDark: false,
      isFutureEvent: false,
    });

    expect(String(lightMetric.containerStyle.background)).toContain(
      'rgba(255, 241, 242, 0.96)',
    );
    expect(String(lightRow.background)).toContain('rgba(255, 241, 242');
    expect(resolveFutureEventHintStyle(false)).toMatchObject({
      color: '#0f766e',
      fontWeight: 600,
    });
  });
});
