import { Injectable } from '@nestjs/common';
import axios from 'axios';

import type {
  FinancialDataItemConfig,
  YfinanceFinancialDataProviderConfig,
} from '../financial-data.types';

import {
  type FinancialDataProviderCleanup,
  FinancialDataProvider,
  FinancialDataProviderFetchResult,
} from './financial-data-provider';

interface YfinanceChartMeta {
  currency?: string;
  exchangeName?: string;
  fullExchangeName?: string;
  instrumentType?: string;
  regularMarketPrice?: number;
  symbol?: string;
}

interface YfinanceChartQuote {
  close?: Array<number | null>;
  high?: Array<number | null>;
  low?: Array<number | null>;
  open?: Array<number | null>;
  volume?: Array<number | null>;
}

interface YfinanceChartResult {
  indicators?: {
    quote?: YfinanceChartQuote[];
  };
  meta?: YfinanceChartMeta;
  timestamp?: number[];
}

interface YfinanceChartError {
  code?: string;
  description?: string;
}

interface YfinanceChartResponse {
  chart?: {
    error?: YfinanceChartError | null;
    result?: YfinanceChartResult[];
  };
}

@Injectable()
export class YfinanceFinancialDataProvider implements FinancialDataProvider {
  // This provider mirrors yfinance history semantics for config and payload
  // shape, but the Nest backend talks to Yahoo Finance's chart endpoint
  // directly via HTTP instead of embedding the Python yfinance project.
  readonly kind = 'yfinance' as const;

  async isConfigured(): Promise<boolean> {
    return true;
  }

  async fetch(definition: FinancialDataItemConfig): Promise<FinancialDataProviderFetchResult> {
    const provider = this.assertProviderConfig(definition);
    const requestParams = this.buildRequestParams(provider);
    const payload = await this.fetchChart(provider);
    const chartError = payload.chart?.error;
    if (chartError) {
      throw new Error(
        `yfinance_chart_error:${chartError.code ?? 'unknown'}:${chartError.description ?? 'unknown'}`,
      );
    }

    const result = payload.chart?.result?.[0];
    const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
    const quote = result?.indicators?.quote?.[0];
    if (!result || !quote || timestamps.length === 0) {
      throw new Error(`yfinance_history_empty:${provider.symbol}`);
    }

    const sourceFields = {
      open: provider.sourceFields?.open ?? 'open',
      high: provider.sourceFields?.high ?? 'high',
      low: provider.sourceFields?.low ?? 'low',
      close: provider.sourceFields?.close ?? 'close',
      volume: provider.sourceFields?.volume,
    } as const;

    const baseMeta = {
      currency: result.meta?.currency ?? null,
      displaySymbol: definition.snapshot?.symbol ?? provider.symbol,
      exchangeName: result.meta?.fullExchangeName ?? result.meta?.exchangeName ?? null,
      instrumentType: result.meta?.instrumentType ?? null,
      providerSymbol: result.meta?.symbol ?? provider.symbol,
      regularMarketPrice: this.normalizeFiniteNumber(result.meta?.regularMarketPrice),
    };

    const incompleteRecordedAts: Date[] = [];
    const points = timestamps.flatMap((timestamp, index) => {
      const recordedAt = new Date(timestamp * 1000);
      const ohlcEntries = [
        {
          sourceField: sourceFields.open,
          value: this.normalizeFiniteNumber(quote.open?.[index]),
        },
        {
          sourceField: sourceFields.high,
          value: this.normalizeFiniteNumber(quote.high?.[index]),
        },
        {
          sourceField: sourceFields.low,
          value: this.normalizeFiniteNumber(quote.low?.[index]),
        },
        {
          sourceField: sourceFields.close,
          value: this.normalizeFiniteNumber(quote.close?.[index]),
        },
      ] as const;

      const hasCompleteOhlc = ohlcEntries.every(
        (entry) => Boolean(entry.sourceField) && entry.value !== null,
      );
      if (!hasCompleteOhlc) {
        incompleteRecordedAts.push(recordedAt);
        return [];
      }

      const entries = [
        ...ohlcEntries,
        ...(sourceFields.volume
          ? [
              {
                sourceField: sourceFields.volume,
                value: this.normalizeFiniteNumber(quote.volume?.[index]),
              },
            ]
          : []),
      ];

      return entries
        .filter(
          (entry): entry is { sourceField: string; value: number } =>
            Boolean(entry.sourceField) && entry.value !== null,
        )
        .map((entry) => ({
          recordedAt,
          value: entry.value,
          unit: definition.defaultUnit ?? undefined,
          dataType: definition.valueType,
          sourceField: entry.sourceField,
          meta: baseMeta,
        }));
    });

    if (points.length === 0) {
      throw new Error(`yfinance_history_points_empty:${provider.symbol}`);
    }

    const cleanup = this.buildCleanup(incompleteRecordedAts);

    return {
      payload,
      points,
      ...(cleanup ? { cleanup } : {}),
      requestParams,
      method: 'GET',
      providerIdentity: provider.symbol,
    };
  }

  private assertProviderConfig(definition: FinancialDataItemConfig): YfinanceFinancialDataProviderConfig {
    const provider = definition.providerConfig;
    if (provider.kind !== 'yfinance') {
      throw new Error(`Expected yfinance provider config for ${definition.slug}`);
    }
    return provider;
  }

  private buildRequestParams(provider: YfinanceFinancialDataProviderConfig): Record<string, unknown> {
    return {
      symbol: provider.symbol,
      interval: provider.interval,
      period1: provider.period1,
      period2: this.resolvePeriod2(provider),
      includePrePost: provider.includePrePost ?? false,
      events: provider.events ?? 'div,splits',
    };
  }

  private async fetchChart(provider: YfinanceFinancialDataProviderConfig): Promise<YfinanceChartResponse> {
    const params = this.buildRequestParams(provider);
    // Use Yahoo Finance's public chart API directly so this provider stays
    // self-contained in the Node service.
    const url = new URL(
      `${this.getBaseUrl()}${provider.endpoint}/${encodeURIComponent(provider.symbol)}`,
    );
    url.searchParams.set('interval', String(params.interval));
    url.searchParams.set('period1', String(params.period1));
    url.searchParams.set('period2', String(params.period2));
    url.searchParams.set('includePrePost', String(params.includePrePost));
    url.searchParams.set('events', String(params.events));

    return this.fetchJsonWithRetry<YfinanceChartResponse>(url.toString(), 12_000, 3);
  }

  private getBaseUrl(): string {
    return 'https://query1.finance.yahoo.com';
  }

  private buildCleanup(recordedAts: Date[]): FinancialDataProviderCleanup | undefined {
    if (recordedAts.length === 0) {
      return undefined;
    }

    const uniqueRecordedAts = new Map<number, Date>();
    for (const recordedAt of recordedAts) {
      uniqueRecordedAts.set(recordedAt.getTime(), recordedAt);
    }

    return {
      deleteRecordedAts: Array.from(uniqueRecordedAts.values()).sort(
        (a, b) => a.getTime() - b.getTime(),
      ),
    };
  }

  private resolvePeriod2(provider: YfinanceFinancialDataProviderConfig): number {
    if (typeof provider.period2 === 'number' && Number.isFinite(provider.period2)) {
      return provider.period2;
    }
    return Math.floor(Date.now() / 1000);
  }

  private async fetchJsonWithRetry<T>(url: string, timeoutMs: number, attempts: number): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
      try {
        return await this.fetchJson<T>(url, timeoutMs);
      } catch (error) {
        lastError = error;
        if (attempt === attempts || !this.isRetryableError(error)) {
          break;
        }
        await this.delay(Math.min(500 * attempt, 1_500));
      }
    }

    throw lastError;
  }

  private async fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
    const response = await axios.get<string>(url, {
      headers: {
        accept: 'application/json',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      },
      maxRedirects: 3,
      responseType: 'text',
      timeout: timeoutMs,
      transformResponse: [(value) => value],
      validateStatus: () => true,
    });
    const raw =
      typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data ?? {});

    if (response.status < 200 || response.status >= 300) {
      const snippet = raw.trim().slice(0, 160) || response.statusText;
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${snippet}`);
    }

    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      throw new Error(
        `yfinance_invalid_json:${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  private isRetryableError(error: unknown): boolean {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

    return (
      message.includes('http 429') ||
      message.includes('http 502') ||
      message.includes('http 503') ||
      message.includes('http 504') ||
      message.includes('timed out') ||
      message.includes('timeout') ||
      message.includes('fetch failed') ||
      message.includes('aborted')
    );
  }

  private normalizeFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
