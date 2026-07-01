import { describe, expect, it } from 'vitest';

import type { ChartTheme } from '@/hooks/use-chart-theme';

import {
  buildCandlestickChartOption,
  formatCandlestickAxisLabel,
  formatCandlestickAxisValue,
  shouldShowCandlestickTime,
} from '../app/(app)/dashboard/utils/candlestick-chart';

const chartTheme: ChartTheme = {
  echartsTheme: 'smart-dark',
  colors: {
    primary: '#6f9bff',
    bullish: '#34d399',
    bearish: '#fb923c',
    destructive: '#f87171',
    accent: '#f59e0b',
    background: 'transparent',
    foreground: '#cbd5e1',
    border: '#334155',
    grid: 'rgba(148, 163, 184, 0.22)',
    tooltipBg: 'rgba(2, 6, 23, 0.92)',
    tooltipText: '#e2e8f0',
    secondary: '#1e293b',
  },
  fontFamily: 'var(--font-mono), monospace',
};

describe('candlestick chart helpers', () => {
  it('detects intraday series and includes time in axis labels', () => {
    expect(
      shouldShowCandlestickTime([
        '2026-03-02T00:00:00.000Z',
        '2026-03-02T12:00:00.000Z',
      ]),
    ).toBe(true);

    expect(
      formatCandlestickAxisLabel(
        '2026-03-02T00:00:00.000Z',
        'zh-CN',
        true,
      ),
    ).toBe('03-02 08:00');
  });

  it('keeps daily series labels short and returns an empty string for invalid values', () => {
    expect(
      shouldShowCandlestickTime([
        '2026-03-02T00:00:00.000Z',
        '2026-03-04T00:00:00.000Z',
      ]),
    ).toBe(false);

    expect(
      formatCandlestickAxisLabel(
        '2026-03-02T00:00:00.000Z',
        'en-US',
        false,
      ),
    ).toBe('Mar 2');
    expect(formatCandlestickAxisLabel('invalid', 'en-US', false)).toBe('');
    expect(formatCandlestickAxisValue(104000, 'en-US', 'CNY')).toBe(
      '104,000 CNY',
    );
    expect(formatCandlestickAxisValue(Number.NaN, 'en-US', 'CNY')).toBe('');
  });

  it('builds a label-safe option without an in-chart title', () => {
    const option = buildCandlestickChartOption({
      title: 'Gold',
      unit: 'CNY',
      locale: 'zh-CN',
      theme: chartTheme,
      points: [
        {
          timestamp: '2026-03-02T00:00:00.000Z',
          values: [1155, 1148, 1142, 1160],
        },
        {
          timestamp: '2026-03-09T00:00:00.000Z',
          values: [1148, 1146, 1140, 1152],
        },
      ],
    });

    expect(option.title).toBeUndefined();
    expect(option.grid).toMatchObject({
      containLabel: true,
      bottom: 66,
      right: 24,
    });

    const dataZoom = Array.isArray(option.dataZoom)
      ? option.dataZoom
      : [option.dataZoom];
    expect(dataZoom).toHaveLength(2);
    expect(dataZoom[1]).toMatchObject({
      type: 'slider',
      showDetail: false,
      showDataShadow: false,
      brushSelect: false,
      height: 14,
    });

    const xAxis = Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis;
    expect(xAxis).toMatchObject({
      type: 'category',
      boundaryGap: true,
      axisLine: {
        show: true,
      },
    });
    const xAxisFormatter = (
      xAxis as {
        axisLabel?: { formatter?: (value: unknown) => string };
      }
    ).axisLabel?.formatter;
    expect(xAxisFormatter?.('2026-03-02T00:00:00.000Z')).toBe('03-02');

    const yAxis = Array.isArray(option.yAxis) ? option.yAxis[0] : option.yAxis;
    const yAxisFormatter = (
      yAxis as {
        axisLabel?: { formatter?: (value: unknown) => string };
      }
    ).axisLabel?.formatter;
    expect(yAxisFormatter?.(1200)).toBe('1,200 CNY');
  });
});
