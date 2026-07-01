import { describe, expect, it } from 'vitest';

import {
  AlertEventStatus,
  AlertOperator,
  AlertSeverity,
  type MetricDrillDownDetailsQuery,
} from '../graphql/generated';
import {
  buildMetricAlertFacts,
  buildMetricAlertHeadline,
  isGenericMetricAlertMessage,
  resolveMetricDrilldownSurface,
} from '../app/(app)/dashboard/metric-drilldown-utils';

type DrilldownAlertEvent = MetricDrillDownDetailsQuery['relatedAlerts'][number];

function createAlertEvent(
  overrides: Partial<DrilldownAlertEvent> = {},
): DrilldownAlertEvent {
  return {
    __typename: 'AlertEventModel',
    id: 'alert-1',
    severity: AlertSeverity.Medium,
    message: 'Value 48 is >= 20',
    triggeredAt: '2026-04-08T10:00:00.000Z',
    status: AlertEventStatus.Delivered,
    metricValue: 48,
    changePercent: 12.4,
    ruleName: null,
    metricSlug: 'global-conflict-index',
    operator: AlertOperator.Gte,
    thresholdValue: 20,
    thresholdLower: null,
    thresholdUpper: null,
    changeWindowMin: 60,
    context: null,
    ...overrides,
  };
}

describe('metric drilldown alert formatting', () => {
  it('detects low-signal numeric alert messages', () => {
    expect(isGenericMetricAlertMessage('Value 48 is >= 20')).toBe(true);
    expect(isGenericMetricAlertMessage('Refineries disrupted near the Black Sea')).toBe(false);
  });

  it('prefers rule names over generic numeric messages', () => {
    const event = createAlertEvent({ ruleName: 'Conflict escalation threshold' });

    expect(buildMetricAlertHeadline(event, 'Global Conflict Index')).toBe(
      'Conflict escalation threshold',
    );
  });

  it('builds readable fact chips from thresholds and percent change', () => {
    const event = createAlertEvent();
    const facts = buildMetricAlertFacts(event, 'pts');

    expect(facts).toEqual([
      { key: 'current', value: '48 pts', tone: 'neutral' },
      { key: 'threshold', value: '>=20 pts', tone: 'bearish' },
      { key: 'change', value: '+12.4% / 60m', tone: 'bearish' },
    ]);
  });
});

describe('metric drilldown surfaces', () => {
  it('keeps dark surfaces non-white', () => {
    const surface = resolveMetricDrilldownSurface(true);

    expect(surface.panelClassName).toContain('bg-slate-950');
    expect(surface.sectionCardClassName).toContain('bg-slate-950');
    expect(surface.mapShellClassName).toContain('bg-slate-950');
  });

  it('keeps light surfaces bright and bordered', () => {
    const surface = resolveMetricDrilldownSurface(false);

    expect(surface.panelClassName).toContain('bg-white');
    expect(surface.sectionCardClassName).toContain('border-slate-200');
    expect(surface.mapShellClassName).toContain('bg-slate-50');
  });
});
