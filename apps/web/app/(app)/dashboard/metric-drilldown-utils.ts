import { AlertOperator, type MetricDrillDownDetailsQuery } from '@/graphql/generated';

export type DrilldownAlertEvent = MetricDrillDownDetailsQuery['relatedAlerts'][number];

export interface DrilldownAlertFact {
  key: 'current' | 'threshold' | 'change';
  value: string;
  tone: 'neutral' | 'bullish' | 'bearish';
}

const GENERIC_ALERT_MESSAGE_PATTERNS = [
  /^value\s+[-+]?\d+(?:\.\d+)?\s+is\s+/i,
  /^metric value\s+[-+]?\d+(?:\.\d+)?/i,
  /^alert triggered\b/i,
];

function normalizeText(value?: string | null): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function isGenericMetricAlertMessage(message?: string | null): boolean {
  const normalized = normalizeText(message);
  if (!normalized) {
    return false;
  }

  return GENERIC_ALERT_MESSAGE_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
}

export function formatMetricNumber(
  value: number,
  options?: { maximumFractionDigits?: number },
): string {
  const digits =
    typeof options?.maximumFractionDigits === 'number'
      ? Math.max(0, Math.min(4, Math.trunc(options.maximumFractionDigits)))
      : Math.abs(value) >= 100
        ? 0
        : Math.abs(value) >= 10
          ? 1
          : 2;

  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  }).format(value);
}

export function resolveAlertOperatorSymbol(
  operator?: AlertOperator | null,
): string | null {
  switch (operator) {
    case AlertOperator.Gt:
      return '>';
    case AlertOperator.Gte:
      return '>=';
    case AlertOperator.Lt:
      return '<';
    case AlertOperator.Lte:
      return '<=';
    case AlertOperator.Eq:
      return '=';
    case AlertOperator.WithinRange:
      return 'in';
    case AlertOperator.OutsideRange:
      return 'out';
    case AlertOperator.ChangeUpPct:
      return '+%';
    case AlertOperator.ChangeDownPct:
      return '-%';
    default:
      return null;
  }
}

export function buildMetricAlertHeadline(
  event: DrilldownAlertEvent,
  fallbackMetricLabel: string,
): string {
  const ruleName = normalizeText(event.ruleName);
  if (ruleName) {
    return ruleName;
  }

  const message = normalizeText(event.message);
  if (message && !isGenericMetricAlertMessage(message)) {
    return message;
  }

  const operator = resolveAlertOperatorSymbol(event.operator);
  if (
    operator &&
    typeof event.thresholdValue === 'number' &&
    Number.isFinite(event.thresholdValue)
  ) {
    return `${fallbackMetricLabel} ${operator} ${formatMetricNumber(event.thresholdValue)}`;
  }

  if (
    typeof event.thresholdLower === 'number' &&
    Number.isFinite(event.thresholdLower) &&
    typeof event.thresholdUpper === 'number' &&
    Number.isFinite(event.thresholdUpper)
  ) {
    return `${fallbackMetricLabel} ${formatMetricNumber(
      event.thresholdLower,
    )} - ${formatMetricNumber(event.thresholdUpper)}`;
  }

  return fallbackMetricLabel;
}

export function buildMetricAlertFacts(
  event: DrilldownAlertEvent,
  unit?: string | null,
): DrilldownAlertFact[] {
  const facts: DrilldownAlertFact[] = [];
  const normalizedUnit = normalizeText(unit);

  if (typeof event.metricValue === 'number' && Number.isFinite(event.metricValue)) {
    facts.push({
      key: 'current',
      value: `${formatMetricNumber(event.metricValue)}${normalizedUnit ? ` ${normalizedUnit}` : ''}`,
      tone: 'neutral',
    });
  }

  if (
    typeof event.thresholdLower === 'number' &&
    Number.isFinite(event.thresholdLower) &&
    typeof event.thresholdUpper === 'number' &&
    Number.isFinite(event.thresholdUpper)
  ) {
    facts.push({
      key: 'threshold',
      value: `${formatMetricNumber(event.thresholdLower)} - ${formatMetricNumber(event.thresholdUpper)}${normalizedUnit ? ` ${normalizedUnit}` : ''}`,
      tone: 'neutral',
    });
  } else if (
    typeof event.thresholdValue === 'number' &&
    Number.isFinite(event.thresholdValue)
  ) {
    const operator = resolveAlertOperatorSymbol(event.operator);
    facts.push({
      key: 'threshold',
      value: `${operator ?? ''}${formatMetricNumber(event.thresholdValue)}${normalizedUnit ? ` ${normalizedUnit}` : ''}`,
      tone:
        event.operator === AlertOperator.Lt || event.operator === AlertOperator.Lte
          ? 'bullish'
          : event.operator === AlertOperator.Gt || event.operator === AlertOperator.Gte
            ? 'bearish'
            : 'neutral',
    });
  }

  if (
    typeof event.changePercent === 'number' &&
    Number.isFinite(event.changePercent)
  ) {
    const sign = event.changePercent > 0 ? '+' : '';
    const windowSuffix =
      typeof event.changeWindowMin === 'number' && Number.isFinite(event.changeWindowMin)
        ? ` / ${Math.round(event.changeWindowMin)}m`
        : '';
    facts.push({
      key: 'change',
      value: `${sign}${formatMetricNumber(event.changePercent, {
        maximumFractionDigits: 1,
      })}%${windowSuffix}`,
      tone:
        event.changePercent > 0
          ? 'bearish'
          : event.changePercent < 0
            ? 'bullish'
            : 'neutral',
    });
  }

  return facts;
}

export function resolveMetricDrilldownSurface(isDark: boolean): {
  panelClassName: string;
  sectionCardClassName: string;
  mapShellClassName: string;
} {
  if (isDark) {
    return {
      panelClassName:
        'border border-[var(--border)] bg-slate-950/[0.86] shadow-[0_28px_60px_-36px_rgba(2,6,23,0.92)]',
      sectionCardClassName:
        'h-full border border-slate-700/80 bg-slate-950/[0.72] shadow-[0_20px_40px_-30px_rgba(2,6,23,0.88)]',
      mapShellClassName:
        'relative h-[400px] overflow-hidden rounded-xl border border-slate-700/70 bg-slate-950/[0.68]',
    };
  }

  return {
    panelClassName:
      'border border-[var(--border)] bg-white/[0.94] shadow-[0_22px_44px_-30px_rgba(15,23,42,0.2)]',
    sectionCardClassName:
      'h-full border border-slate-200/80 bg-white/[0.9] shadow-[0_16px_30px_-26px_rgba(15,23,42,0.14)]',
    mapShellClassName:
      'relative h-[400px] overflow-hidden rounded-xl border border-slate-200/80 bg-slate-50/90',
  };
}
