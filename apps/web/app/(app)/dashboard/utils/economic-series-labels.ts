import type { TFunction } from 'i18next';

import type { EconomicSeriesMap } from '@/hooks/useEconomicData';
import { resolveLocale, type SupportedLocale } from '@/lib/i18n';

export interface EconomicSeriesLabelConfig {
  labelKey: string;
  fallback: Record<SupportedLocale, string>;
}

export const ECONOMIC_SERIES_LABELS: Readonly<
  Record<string, EconomicSeriesLabelConfig>
> = {
  shanghai_composite_index: {
    labelKey: 'dashboard.economicSeries.shanghaiCompositeIndex',
    fallback: {
      'en-US': 'Shanghai Composite Index (Daily)',
      'zh-CN': '上证指数日线',
    },
  },
  csi300_index: {
    labelKey: 'dashboard.economicSeries.csi300Index',
    fallback: {
      'en-US': 'CSI 300 Index (Daily)',
      'zh-CN': '沪深300指数日线',
    },
  },
  sz_component_index: {
    labelKey: 'dashboard.economicSeries.szComponentIndex',
    fallback: {
      'en-US': 'Shenzhen Component Index (Daily)',
      'zh-CN': '深证成指日线',
    },
  },
  csi1000_index: {
    labelKey: 'dashboard.economicSeries.csi1000Index',
    fallback: {
      'en-US': 'CSI 1000 Index (Daily)',
      'zh-CN': '中证1000指数日线',
    },
  },
  sp500_index: {
    labelKey: 'dashboard.economicSeries.sp500Index',
    fallback: {
      'en-US': 'S&P 500 Index',
      'zh-CN': '标普500指数',
    },
  },
  usd_cny_spot: {
    labelKey: 'dashboard.economicSeries.usdCnySpot',
    fallback: {
      'en-US': 'USD/CNY Spot Exchange Rate',
      'zh-CN': '美元兑人民币即期汇率',
    },
  },
  eur_cny_spot: {
    labelKey: 'dashboard.economicSeries.eurCnySpot',
    fallback: {
      'en-US': 'EUR/CNY Spot Exchange Rate',
      'zh-CN': '欧元兑人民币即期汇率',
    },
  },
  bitcoin_spot_price: {
    labelKey: 'dashboard.economicSeries.bitcoinSpotPrice',
    fallback: {
      'en-US': 'Bitcoin Spot Price',
      'zh-CN': '比特币实时价格',
    },
  },
} as const;

export interface ResolveEconomicSeriesLabelOptions {
  slug: string;
  locale?: string;
  t: TFunction;
  seriesMap?: EconomicSeriesMap;
}

export function getEconomicSeriesLabelFallback(
  slug: string,
  locale?: string,
): string {
  const resolvedLocale = resolveLocale(locale);
  const config = ECONOMIC_SERIES_LABELS[slug];

  if (!config) {
    return slug;
  }

  return config.fallback[resolvedLocale];
}

export function resolveEconomicSeriesLabel({
  slug,
  locale,
  t,
  seriesMap,
}: ResolveEconomicSeriesLabelOptions): string {
  const resolvedLocale = resolveLocale(locale);
  const backendName = seriesMap?.[slug]?.name?.trim();

  if (resolvedLocale === 'zh-CN' && backendName) {
    return backendName;
  }

  const defaultValue = getEconomicSeriesLabelFallback(slug, resolvedLocale);
  const labelKey = ECONOMIC_SERIES_LABELS[slug]?.labelKey;

  if (labelKey) {
    return t(labelKey, { defaultValue });
  }

  if (backendName) {
    return backendName;
  }

  return defaultValue;
}

export function formatAxisLabelMultiline(
  label: string,
  maxCharsPerLine: number,
  maxLines = 2,
): string {
  const normalizedLabel = label.trim();
  if (!normalizedLabel || maxCharsPerLine <= 0 || maxLines <= 0) {
    return normalizedLabel;
  }

  const chars = Array.from(normalizedLabel);
  if (chars.length <= maxCharsPerLine) {
    return normalizedLabel;
  }

  const lines: string[] = [];

  for (let lineIndex = 0; lineIndex < maxLines; lineIndex += 1) {
    const start = lineIndex * maxCharsPerLine;
    if (start >= chars.length) {
      break;
    }

    const end = start + maxCharsPerLine;
    if (lineIndex === maxLines - 1 && end < chars.length) {
      const visibleChars = chars
        .slice(start, start + Math.max(maxCharsPerLine - 1, 1))
        .join('')
        .trimEnd();
      lines.push(`${visibleChars}…`);
      return lines.join('\n');
    }

    lines.push(chars.slice(start, end).join('').trimEnd());
  }

  return lines.join('\n');
}
