import {
  SITUATION_OREF_ACTIVE_ALERTS_METRIC_SLUG,
  SITUATION_OREF_HISTORY_24H_METRIC_SLUG,
} from '@modular/utils';

export const SITUATION_MONITOR_OREF_METRICS_CACHE_KEY =
  'situation-monitor:signals:metrics:oref:v1';

export const SITUATION_MONITOR_OREF_ACTIVE_ALERTS_METRIC_SLUG =
  SITUATION_OREF_ACTIVE_ALERTS_METRIC_SLUG;

export const SITUATION_MONITOR_OREF_HISTORY_24H_METRIC_SLUG =
  SITUATION_OREF_HISTORY_24H_METRIC_SLUG;

export interface SituationMonitorDefaultAlertRuleDefinition {
  slug: string;
  name: string;
  description: string;
  thresholdValue: number;
}

export const SITUATION_MONITOR_DEFAULT_OREF_ALERT_RULES: readonly SituationMonitorDefaultAlertRuleDefinition[] = [
  {
    slug: SITUATION_MONITOR_OREF_ACTIVE_ALERTS_METRIC_SLUG,
    name: 'Situation Monitor: OREF Active Alerts',
    description: 'Trigger when OREF active alerts are detected.',
    thresholdValue: 1,
  },
  {
    slug: SITUATION_MONITOR_OREF_HISTORY_24H_METRIC_SLUG,
    name: 'Situation Monitor: OREF 24h Alert Volume Spike',
    description: 'Trigger when OREF 24h alert volume exceeds baseline.',
    thresholdValue: 25,
  },
] as const;
