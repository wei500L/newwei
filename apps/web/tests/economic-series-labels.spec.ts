import fs from 'node:fs';
import path from 'node:path';

import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import {
  ECONOMIC_SERIES_LABELS,
  getEconomicSeriesLabelFallback,
  resolveEconomicSeriesLabel,
} from '../app/(app)/dashboard/utils/economic-series-labels';
import { EconomicDataValueType } from '../graphql/generated';
import type { EconomicSeriesMap } from '../hooks/useEconomicData';

const webRoot = path.resolve(__dirname, '..');

const readLocale = (name: 'en' | 'zh') =>
  JSON.parse(
    fs.readFileSync(path.resolve(webRoot, `lib/locales/${name}.json`), 'utf8'),
  ) as Record<string, unknown>;

const getDeepValue = (
  value: Record<string, unknown>,
  pathKey: string,
): unknown =>
  pathKey.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') {
      return undefined;
    }

    return (current as Record<string, unknown>)[segment];
  }, value);

const createTranslator = (translations: Record<string, string>) =>
  ((key: string, options?: { defaultValue?: string }) =>
    translations[key] ?? options?.defaultValue ?? key) as TFunction;

describe('economic series labels', () => {
  it('prefers backend displayName for zh-CN when series data is present', () => {
    const seriesMap = {
      shanghai_composite_index: {
        name: '上证指数日线',
        unit: 'pts',
        metadata: null,
        dataType: EconomicDataValueType.Index,
        fields: {},
      },
    } as EconomicSeriesMap;

    const label = resolveEconomicSeriesLabel({
      slug: 'shanghai_composite_index',
      locale: 'zh-CN',
      t: createTranslator({}),
      seriesMap,
    });

    expect(label).toBe('上证指数日线');
  });

  it('falls back to configured zh-CN full names when series data is absent', () => {
    const label = resolveEconomicSeriesLabel({
      slug: 'eur_cny_spot',
      locale: 'zh-CN',
      t: createTranslator({}),
    });

    expect(label).toBe(getEconomicSeriesLabelFallback('eur_cny_spot', 'zh-CN'));
  });

  it('uses english full names instead of zh backend names in en-US', () => {
    const label = resolveEconomicSeriesLabel({
      slug: 'usd_cny_spot',
      locale: 'en-US',
      t: createTranslator({
        'dashboard.economicSeries.usdCnySpot': 'USD/CNY Spot Exchange Rate',
      }),
      seriesMap: {
        usd_cny_spot: {
          name: '美元兑人民币即期汇率',
          unit: 'CNY',
          metadata: null,
          dataType: EconomicDataValueType.Fx,
          fields: {},
        },
      } as EconomicSeriesMap,
    });

    expect(label).toBe('USD/CNY Spot Exchange Rate');
  });

  it('never returns raw dashboard translation keys for configured series', () => {
    const t = createTranslator({});

    for (const slug of Object.keys(ECONOMIC_SERIES_LABELS)) {
      const label = resolveEconomicSeriesLabel({
        slug,
        locale: 'en-US',
        t,
      });

      expect(label.startsWith('dashboard.')).toBe(false);
    }
  });

  it('covers shared series labels and heatmap strings in both locale files', () => {
    const en = readLocale('en');
    const zh = readLocale('zh');

    for (const config of Object.values(ECONOMIC_SERIES_LABELS)) {
      expect(getDeepValue(en, config.labelKey)).toBeTypeOf('string');
      expect(getDeepValue(zh, config.labelKey)).toBeTypeOf('string');
    }

    for (const key of [
      'dashboard.economicShort.heatmap.tooltip',
      'dashboard.economicShort.heatmap.buckets.1d',
      'dashboard.economicShort.heatmap.buckets.3d',
      'dashboard.economicShort.heatmap.buckets.7d',
    ]) {
      expect(getDeepValue(en, key)).toBeTypeOf('string');
      expect(getDeepValue(zh, key)).toBeTypeOf('string');
    }
  });
});
