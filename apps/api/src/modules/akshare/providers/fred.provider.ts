import { Injectable } from '@nestjs/common';

import { FinancialDataProviderSettingsService } from '../../system-settings/financial-data-provider-settings.service';

import type {
  FinancialDataItemConfig,
  FredFinancialDataProviderConfig,
  FredFinancialValueTransform,
} from '../financial-data.types';

import {
  FinancialDataProvider,
  FinancialDataProviderConfigurationError,
  FinancialDataProviderFetchResult,
} from './financial-data-provider';

interface FredObservation {
  date?: string;
  value?: string;
}

interface FredSeriesResponse {
  observations?: FredObservation[];
}

@Injectable()
export class FredFinancialDataProvider implements FinancialDataProvider {
  readonly kind = 'fred' as const;

  constructor(private readonly settings: FinancialDataProviderSettingsService) {}

  async isConfigured(): Promise<boolean> {
    return Boolean(await this.settings.getFredApiKey());
  }

  async fetch(definition: FinancialDataItemConfig): Promise<FinancialDataProviderFetchResult> {
    const provider = this.assertProviderConfig(definition);
    const apiKey = await this.settings.getFredApiKey();
    if (!apiKey) {
      throw new FinancialDataProviderConfigurationError('missing_api_key:fredApiKey', 'missing_api_key');
    }

    const observations = await this.fetchSeriesObservations(apiKey, provider);
    if (observations.length === 0) {
      throw new Error(`fred_observations_empty:${provider.seriesId}`);
    }

    const latestObservation = observations[0];
    const value = this.computeValue(observations, provider);
    const recordedAt = this.toRecordedAt(latestObservation?.date);
    const meta = this.buildMeta(observations, provider, value);

    return {
      payload: { observations },
      requestParams: {
        series_id: provider.seriesId,
        metric: provider.metric,
        limit: this.resolveLimit(provider),
      },
      method: 'GET',
      providerIdentity: provider.seriesId,
      points: [
        {
          recordedAt,
          value,
          unit: definition.defaultUnit ?? undefined,
          dataType: definition.valueType,
          sourceField: provider.sourceField ?? 'value',
          meta,
        },
      ],
    };
  }

  private assertProviderConfig(definition: FinancialDataItemConfig): FredFinancialDataProviderConfig {
    const provider = definition.providerConfig;
    if (provider.kind !== 'fred') {
      throw new Error(`Expected fred provider config for ${definition.slug}`);
    }
    return provider;
  }

  private async fetchSeriesObservations(
    apiKey: string,
    provider: FredFinancialDataProviderConfig,
  ): Promise<FredObservation[]> {
    const url = new URL('https://api.stlouisfed.org/fred/series/observations');
    url.searchParams.set('series_id', provider.seriesId);
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('file_type', 'json');
    url.searchParams.set('sort_order', 'desc');
    url.searchParams.set('limit', String(this.resolveLimit(provider)));

    const response = await this.fetchJson<FredSeriesResponse>(url.toString(), 12_000);
    return Array.isArray(response.observations) ? response.observations : [];
  }

  private resolveLimit(provider: FredFinancialDataProviderConfig): number {
    switch (provider.metric) {
      case 'yoy':
        return Math.max(14, provider.lookback ?? 14);
      case 'percentOfMax':
        return Math.max(52, provider.lookback ?? 260);
      case 'delta':
      case 'latest':
      default:
        return Math.max(2, provider.lookback ?? 2);
    }
  }

  private computeValue(observations: FredObservation[], provider: FredFinancialDataProviderConfig): number {
    const precision = provider.precision ?? 2;

    switch (provider.metric) {
      case 'latest': {
        const current = this.transformValue(this.parseValue(observations[0]?.value), provider.transform);
        if (current === null) {
          throw new Error(`fred_latest_missing_value:${provider.seriesId}`);
        }
        return this.round(current, precision);
      }
      case 'delta': {
        const current = this.transformValue(this.parseValue(observations[0]?.value), provider.transform);
        const previous = this.transformValue(this.parseValue(observations[1]?.value), provider.transform);
        if (current === null || previous === null) {
          throw new Error(`fred_delta_missing_value:${provider.seriesId}`);
        }
        return this.round(current - previous, precision);
      }
      case 'yoy': {
        if (observations.length < 13) {
          throw new Error(`fred_yoy_insufficient_history:${provider.seriesId}`);
        }
        const current = this.parseValue(observations[0]?.value);
        const yearAgo = this.parseValue(observations[12]?.value);
        if (current === null || yearAgo === null || yearAgo === 0) {
          throw new Error(`fred_yoy_invalid_series:${provider.seriesId}`);
        }
        return this.round(((current - yearAgo) / yearAgo) * 100, precision);
      }
      case 'percentOfMax': {
        const values = observations
          .map((observation) => this.parseValue(observation.value))
          .filter((value): value is number => value !== null && Number.isFinite(value));
        const current = values[0] ?? null;
        const max = values.reduce<number | null>((best, value) => (best === null ? value : Math.max(best, value)), null);
        if (current === null || max === null || max === 0) {
          throw new Error(`fred_percent_of_max_invalid_series:${provider.seriesId}`);
        }
        return this.round((current / max) * 100, precision);
      }
      default:
        throw new Error(`Unsupported fred metric: ${(provider as { metric?: string }).metric ?? 'unknown'}`);
    }
  }

  private buildMeta(
    observations: FredObservation[],
    provider: FredFinancialDataProviderConfig,
    currentValue: number,
  ): Record<string, unknown> {
    switch (provider.metric) {
      case 'latest': {
        const currentRaw = this.transformValue(this.parseValue(observations[0]?.value), provider.transform);
        const previousRaw = this.transformValue(this.parseValue(observations[1]?.value), provider.transform);
        const delta =
          currentRaw !== null && previousRaw !== null
            ? this.round(currentRaw - previousRaw, provider.precision ?? 2)
            : null;
        const changePercent =
          currentRaw !== null && previousRaw !== null && previousRaw !== 0
            ? this.round(((currentRaw - previousRaw) / previousRaw) * 100, provider.precision ?? 2)
            : null;
        return {
          seriesId: provider.seriesId,
          previous: previousRaw,
          delta,
          changePercent,
        };
      }
      case 'yoy': {
        if (observations.length < 14) {
          return { seriesId: provider.seriesId };
        }
        const prevMonth = this.parseValue(observations[1]?.value);
        const prevYearAgo = this.parseValue(observations[13]?.value);
        const previousYoy =
          prevMonth !== null && prevYearAgo !== null && prevYearAgo !== 0
            ? this.round(((prevMonth - prevYearAgo) / prevYearAgo) * 100, provider.precision ?? 2)
            : null;
        return {
          seriesId: provider.seriesId,
          previous: previousYoy,
          delta: previousYoy !== null ? this.round(currentValue - previousYoy, provider.precision ?? 2) : null,
        };
      }
      case 'delta': {
        const currentRaw = this.transformValue(this.parseValue(observations[0]?.value), provider.transform);
        const previousRaw = this.transformValue(this.parseValue(observations[1]?.value), provider.transform);
        return {
          seriesId: provider.seriesId,
          current: currentRaw,
          previous: previousRaw,
        };
      }
      case 'percentOfMax': {
        const values = observations
          .map((observation) => this.transformValue(this.parseValue(observation.value), provider.transform))
          .filter((value): value is number => value !== null && Number.isFinite(value));
        const max = values.reduce<number | null>((best, value) => (best === null ? value : Math.max(best, value)), null);
        return {
          seriesId: provider.seriesId,
          current: values[0] ?? null,
          max,
        };
      }
      default:
        return { seriesId: provider.seriesId };
    }
  }

  private parseValue(value: string | undefined): number | null {
    if (!value || value === '.') {
      return null;
    }
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private transformValue(value: number | null, transform: FredFinancialValueTransform | undefined): number | null {
    if (value === null) {
      return null;
    }
    if (transform === 'millionsToTrillions') {
      return value / 1_000_000;
    }
    return value;
  }

  private toRecordedAt(date: string | undefined): Date {
    if (!date) {
      return new Date();
    }
    const recordedAt = new Date(`${date}T00:00:00.000Z`);
    return Number.isNaN(recordedAt.getTime()) ? new Date() : recordedAt;
  }

  private round(value: number, precision: number): number {
    const factor = 10 ** Math.max(0, precision);
    return Math.round(value * factor) / factor;
  }

  private async fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: 'application/json',
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
