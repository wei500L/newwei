import type { EChartsOption } from 'echarts';

import type { ChartTheme } from '@/hooks/use-chart-theme';
import dayjs from '@/lib/dayjs';
import { getDefaultTimeZone, type SupportedLocale } from '@/lib/i18n';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface CandlestickChartPoint {
  timestamp: string;
  values: [number, number, number, number];
}

export interface BuildCandlestickChartOptionParams {
  title: string;
  points: CandlestickChartPoint[];
  unit?: string | null;
  locale: SupportedLocale;
  theme: ChartTheme;
}

function withOpacity(color: string, alpha: number): string {
  const normalizedAlpha = Math.min(Math.max(alpha, 0), 1);

  if (/^#([0-9a-f]{6})$/i.test(color)) {
    const hex = color.slice(1);
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${normalizedAlpha})`;
  }

  if (/^rgb\(/i.test(color)) {
    return color.replace(/^rgb\((.+)\)$/i, `rgba($1, ${normalizedAlpha})`);
  }

  if (/^rgba\(/i.test(color)) {
    return color.replace(
      /^rgba\((.+),\s*[\d.]+\)$/i,
      `rgba($1, ${normalizedAlpha})`,
    );
  }

  return color;
}

function resolveAxisDateFormat(
  locale: SupportedLocale,
  showTime: boolean,
): string {
  if (locale === 'en-US') {
    return showTime ? 'MMM D HH:mm' : 'MMM D';
  }

  return showTime ? 'MM-DD HH:mm' : 'MM-DD';
}

export function shouldShowCandlestickTime(timestamps: string[]): boolean {
  const sorted = timestamps
    .map((value) => dayjs(value).valueOf())
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const previous = sorted[index - 1];

    if (current === undefined || previous === undefined) {
      continue;
    }

    if (current - previous < ONE_DAY_MS) {
      return true;
    }
  }

  return false;
}

export function formatCandlestickAxisLabel(
  value: string,
  locale: SupportedLocale,
  showTime: boolean,
): string {
  const zonedValue = dayjs(value).tz(getDefaultTimeZone());

  if (!zonedValue.isValid()) {
    return '';
  }

  const dayjsLocale = locale === 'zh-CN' ? 'zh-cn' : 'en';
  return zonedValue
    .locale(dayjsLocale)
    .format(resolveAxisDateFormat(locale, showTime));
}

export function formatCandlestickAxisValue(
  value: number,
  locale: SupportedLocale,
  unit?: string | null,
): string {
  if (!Number.isFinite(value)) {
    return '';
  }

  const formattedValue = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 2,
  }).format(value);

  return unit ? `${formattedValue} ${unit}` : formattedValue;
}

export function buildCandlestickChartOption({
  title,
  points,
  unit,
  locale,
  theme,
}: BuildCandlestickChartOptionParams): EChartsOption {
  const timestamps = points.map((point) => point.timestamp);
  const showTime = shouldShowCandlestickTime(timestamps);
  const isDarkTheme = theme.echartsTheme === 'smart-dark';
  const axisLabelColor = withOpacity(
    isDarkTheme ? theme.colors.tooltipText : theme.colors.foreground,
    isDarkTheme ? 0.78 : 0.88,
  );
  const xAxisLabelColor = withOpacity(
    isDarkTheme ? theme.colors.tooltipText : theme.colors.foreground,
    isDarkTheme ? 0.68 : 0.76,
  );
  const xAxisLineColor = withOpacity(
    isDarkTheme ? theme.colors.tooltipText : theme.colors.foreground,
    isDarkTheme ? 0.48 : 0.3,
  );
  const sliderBackgroundColor = withOpacity(
    theme.colors.secondary,
    isDarkTheme ? 0.72 : 0.88,
  );
  const sliderFillerColor = withOpacity(
    theme.colors.primary,
    isDarkTheme ? 0.18 : 0.22,
  );

  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'cross',
        label: {
          backgroundColor: theme.colors.primary,
          color: theme.colors.tooltipText,
          fontFamily: theme.fontFamily,
        },
      },
      backgroundColor: theme.colors.tooltipBg,
      borderColor: theme.colors.border,
      borderWidth: 1,
      textStyle: {
        color: theme.colors.tooltipText,
        fontFamily: theme.fontFamily,
      },
    },
    grid: {
      left: 48,
      right: 24,
      top: 16,
      bottom: 66,
      containLabel: true,
    },
    dataZoom: [
      {
        type: 'inside',
      },
      {
        type: 'slider',
        showDetail: false,
        showDataShadow: false,
        brushSelect: false,
        height: 14,
        bottom: 8,
        borderColor: withOpacity(theme.colors.border, 0.82),
        backgroundColor: sliderBackgroundColor,
        fillerColor: sliderFillerColor,
        dataBackground: {
          lineStyle: {
            color: withOpacity(theme.colors.foreground, 0.38),
          },
          areaStyle: {
            color: withOpacity(theme.colors.secondary, 0.82),
          },
        },
        handleSize: '72%',
        handleStyle: {
          color: withOpacity(theme.colors.primary, 0.62),
          borderColor: withOpacity(theme.colors.border, 0.9),
        },
        textStyle: {
          color: 'transparent',
          fontFamily: theme.fontFamily,
        },
      },
    ],
    xAxis: {
      type: 'category',
      data: timestamps,
      boundaryGap: true,
      axisLine: {
        onZero: false,
        show: true,
        lineStyle: {
          color: xAxisLineColor,
          width: 1.25,
        },
      },
      axisTick: {
        show: false,
      },
      axisLabel: {
        color: xAxisLabelColor,
        fontFamily: theme.fontFamily,
        fontSize: 12,
        fontWeight: 500,
        margin: 14,
        hideOverlap: true,
        formatter: (value: unknown) =>
          typeof value === 'string'
            ? formatCandlestickAxisLabel(value, locale, showTime)
            : '',
      },
      splitLine: {
        show: false,
      },
    },
    yAxis: {
      scale: true,
      splitNumber: 4,
      axisLine: {
        show: false,
      },
      axisTick: {
        show: false,
      },
      splitLine: {
        show: true,
        lineStyle: {
          color: withOpacity(theme.colors.grid, isDarkTheme ? 0.9 : 0.8),
          type: 'dashed',
        },
      },
      axisLabel: {
        color: axisLabelColor,
        fontFamily: theme.fontFamily,
        fontSize: 13,
        fontWeight: 600,
        margin: 12,
        formatter: (value: unknown) =>
          typeof value === 'number'
            ? formatCandlestickAxisValue(value, locale, unit)
            : '',
      },
    },
    series: [
      {
        name: title,
        type: 'candlestick',
        barMinWidth: 10,
        barMaxWidth: 18,
        data: points.map((point) => point.values),
        itemStyle: {
          color: theme.colors.bullish,
          color0: theme.colors.bearish,
          borderColor: theme.colors.bullish,
          borderColor0: theme.colors.bearish,
        },
      },
    ],
  };
}
