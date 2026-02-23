import { describe, expect, it } from 'vitest';

import {
  AlertChannelType,
  AlertDeliveryStatus,
  AlertEventStatus,
  AlertMetricProvider,
  AlertSeverity
} from '../graphql/generated';
import {
  buildAlertExportJson,
  buildAlertExportRows,
  buildAlertStats,
  buildAlertTrend,
  buildRuleTrendAnalysis,
  buildSimilarAlerts,
  filterAlertEvents,
  resolveFilterTimeWindow,
  type AlertEventItem,
  type AlertFilterState
} from '../app/(app)/alerts/alert-center.utils';

const createEvent = (
  overrides: Partial<AlertEventItem> & Pick<AlertEventItem, 'id' | 'triggeredAt'>
): AlertEventItem => {
  const { id, triggeredAt, ...rest } = overrides;
  return {
    __typename: 'AlertEventModel',
    id,
    triggeredAt,
    metricValue: 42,
    changePercent: null,
    severity: AlertSeverity.Medium,
    status: AlertEventStatus.Delivered,
    message: 'Alert triggered',
    ruleId: 'rule-1',
    ruleName: 'Economic anomaly rule',
    metricProvider: AlertMetricProvider.EconomicAnomaly,
    metricSlug: 'economy.cpi',
    operator: null,
    thresholdValue: null,
    thresholdLower: null,
    thresholdUpper: null,
    changeWindowMin: null,
    context: { foo: 'bar' },
    deliveries: [
      {
        __typename: 'AlertDeliveryModel',
        id: `delivery-${id}`,
        status: AlertDeliveryStatus.Pending,
        channelType: AlertChannelType.Webhook,
        channelName: 'Ops webhook',
        target: 'https://example.com',
        sentAt: null,
        error: null
      }
    ],
    ...rest
  };
};

const defaultFilterState: AlertFilterState = {
  severities: [],
  statuses: [],
  providers: [],
  ruleKeyword: '',
  datePreset: '30d',
  customRangeMs: null
};

describe('alert-center utils', () => {
  it('filters events by severity, status, provider, keyword, and date range', () => {
    const events = [
      createEvent({
        id: 'evt-1',
        triggeredAt: '2026-01-20T10:00:00Z',
        severity: AlertSeverity.High,
        status: AlertEventStatus.Pending
      }),
      createEvent({
        id: 'evt-2',
        triggeredAt: '2026-01-28T10:00:00Z',
        severity: AlertSeverity.High,
        status: AlertEventStatus.Pending,
        metricProvider: AlertMetricProvider.EntitySentiment,
        ruleName: 'Sentiment spike'
      }),
      createEvent({
        id: 'evt-3',
        triggeredAt: '2026-01-29T10:00:00Z',
        severity: AlertSeverity.High,
        status: AlertEventStatus.Pending,
        metricProvider: AlertMetricProvider.EntitySentiment,
        ruleName: 'Sentiment spike alpha'
      })
    ];

    const filterState: AlertFilterState = {
      ...defaultFilterState,
      severities: [AlertSeverity.High],
      statuses: [AlertEventStatus.Pending],
      providers: [AlertMetricProvider.EntitySentiment],
      ruleKeyword: 'alpha',
      datePreset: '7d'
    };
    const window = resolveFilterTimeWindow(filterState, new Date('2026-01-30T00:00:00Z'));
    const filtered = filterAlertEvents(events, filterState, window);

    expect(filtered.map((event) => event.id)).toEqual(['evt-3']);
  });

  it('computes stats and false positive rate', () => {
    const events = [
      createEvent({ id: 'evt-1', triggeredAt: '2026-01-01T00:00:00Z', status: AlertEventStatus.Pending }),
      createEvent({ id: 'evt-2', triggeredAt: '2026-01-02T00:00:00Z', status: AlertEventStatus.Delivered }),
      createEvent({ id: 'evt-3', triggeredAt: '2026-01-03T00:00:00Z', status: AlertEventStatus.Failed }),
      createEvent({ id: 'evt-4', triggeredAt: '2026-01-04T00:00:00Z', status: AlertEventStatus.Confirmed }),
      createEvent({ id: 'evt-5', triggeredAt: '2026-01-05T00:00:00Z', status: AlertEventStatus.Ignored })
    ];

    const stats = buildAlertStats(events);
    expect(stats.total).toBe(5);
    expect(stats.pending).toBe(3);
    expect(stats.confirmed).toBe(1);
    expect(stats.ignored).toBe(1);
    expect(stats.falsePositiveRate).toBe(0.5);
  });

  it('builds daily trend buckets with severity distribution', () => {
    const events = [
      createEvent({
        id: 'evt-1',
        triggeredAt: '2026-01-01T03:00:00Z',
        severity: AlertSeverity.Low
      }),
      createEvent({
        id: 'evt-2',
        triggeredAt: '2026-01-01T08:00:00Z',
        severity: AlertSeverity.High
      }),
      createEvent({
        id: 'evt-3',
        triggeredAt: '2026-01-03T08:00:00Z',
        severity: AlertSeverity.Medium
      })
    ];

    const trend = buildAlertTrend(events, {
      startMs: new Date('2026-01-01T00:00:00Z').getTime(),
      endMs: new Date('2026-01-03T23:59:59Z').getTime()
    });

    expect(trend.length).toBeGreaterThanOrEqual(3);
    const byDate = new Map(trend.map((item) => [item.date, item]));
    expect(byDate.get('2026-01-01')).toMatchObject({ low: 1, medium: 0, high: 1, total: 2 });
    expect(byDate.get('2026-01-02')).toMatchObject({ total: 0 });
    expect(byDate.get('2026-01-03')).toMatchObject({ low: 0, medium: 1, high: 0, total: 1 });
  });

  it('ranks similar alerts by same rule then same metric', () => {
    const selected = createEvent({
      id: 'evt-1',
      triggeredAt: '2026-01-10T00:00:00Z',
      ruleId: 'rule-1',
      metricProvider: AlertMetricProvider.EconomicAnomaly,
      metricSlug: 'economy.cpi'
    });
    const sameRule = createEvent({
      id: 'evt-2',
      triggeredAt: '2026-01-09T00:00:00Z',
      ruleId: 'rule-1',
      metricProvider: AlertMetricProvider.SystemMetric,
      metricSlug: 'cpu.usage'
    });
    const sameMetric = createEvent({
      id: 'evt-3',
      triggeredAt: '2026-01-11T00:00:00Z',
      ruleId: 'rule-2',
      metricProvider: AlertMetricProvider.EconomicAnomaly,
      metricSlug: 'economy.cpi'
    });
    const unrelated = createEvent({
      id: 'evt-4',
      triggeredAt: '2026-01-12T00:00:00Z',
      ruleId: 'rule-3',
      metricProvider: AlertMetricProvider.EntityAssociation,
      metricSlug: 'entity.association'
    });

    const similar = buildSimilarAlerts(selected, [selected, sameMetric, unrelated, sameRule], 5);
    expect(similar.map((item) => item.event.id)).toEqual(['evt-2', 'evt-3']);
    expect(similar[0]?.reason).toBe('same_rule');
    expect(similar[1]?.reason).toBe('same_metric');
  });

  it('builds rule trend analysis with frequency and false positive rate', () => {
    const events = [
      createEvent({
        id: 'evt-1',
        triggeredAt: '2026-01-01T00:00:00Z',
        ruleId: 'rule-1',
        status: AlertEventStatus.Confirmed
      }),
      createEvent({
        id: 'evt-2',
        triggeredAt: '2026-01-01T06:00:00Z',
        ruleId: 'rule-1',
        status: AlertEventStatus.Ignored
      }),
      createEvent({
        id: 'evt-3',
        triggeredAt: '2026-01-02T00:00:00Z',
        ruleId: 'rule-1',
        status: AlertEventStatus.Ignored
      }),
      createEvent({
        id: 'evt-4',
        triggeredAt: '2026-01-03T00:00:00Z',
        ruleId: 'rule-2',
        status: AlertEventStatus.Pending
      })
    ];

    const analysis = buildRuleTrendAnalysis(
      'rule-1',
      events,
      {
        startMs: new Date('2026-01-01T00:00:00Z').getTime(),
        endMs: new Date('2026-01-02T23:59:59Z').getTime()
      }
    );

    expect(analysis.totalTriggers).toBe(3);
    expect(analysis.points).toHaveLength(2);
    expect(analysis.points[0]).toMatchObject({ date: '2026-01-01', triggers: 2, falsePositiveRate: 0.5 });
    expect(analysis.points[1]).toMatchObject({ date: '2026-01-02', triggers: 1, falsePositiveRate: 1 });
    expect(analysis.falsePositiveRate).toBeCloseTo(2 / 3, 6);
  });

  it('builds export rows with stable headers', () => {
    const events = [
      createEvent({
        id: 'evt-1',
        triggeredAt: '2026-01-01T00:00:00Z',
        thresholdValue: 12.5
      })
    ];

    const rows = buildAlertExportRows(events);
    expect(rows[0]).toEqual([
      'id',
      'triggeredAt',
      'severity',
      'status',
      'ruleName',
      'metricProvider',
      'metricSlug',
      'metricValue',
      'changePercent',
      'threshold',
      'message'
    ]);
    expect(rows[1]?.[0]).toBe('evt-1');
    expect(rows[1]?.[9]).toBe('12.5');
  });

  it('includes context and deliveries when full export is enabled', () => {
    const events = [
      createEvent({
        id: 'evt-1',
        triggeredAt: '2026-01-01T00:00:00Z',
        context: { region: 'apac' }
      })
    ];

    const rows = buildAlertExportRows(events, { includeContext: true, includeDeliveries: true });
    expect(rows[0]).toEqual([
      'id',
      'triggeredAt',
      'severity',
      'status',
      'ruleName',
      'metricProvider',
      'metricSlug',
      'metricValue',
      'changePercent',
      'threshold',
      'message',
      'context',
      'deliveries'
    ]);
    expect(typeof rows[1]?.[11]).toBe('string');
    expect(typeof rows[1]?.[12]).toBe('string');
  });

  it('builds JSON export with optional raw fields', () => {
    const events = [
      createEvent({
        id: 'evt-1',
        triggeredAt: '2026-01-01T00:00:00Z',
        context: { region: 'emea' }
      })
    ];

    const basic = buildAlertExportJson(events);
    expect(basic[0]).not.toHaveProperty('context');

    const full = buildAlertExportJson(events, { includeContext: true, includeDeliveries: true });
    expect(full[0]).toHaveProperty('context');
    expect(full[0]).toHaveProperty('deliveries');
  });
});
