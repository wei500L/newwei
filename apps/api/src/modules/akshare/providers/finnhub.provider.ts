import { Injectable } from '@nestjs/common';
import { EconomicDataValueType } from '@prisma/client';

import { FinancialDataProviderSettingsService } from '../../system-settings/financial-data-provider-settings.service';
import type {
  FinancialDataItemConfig,
  FinnhubFinancialDataProviderConfig,
} from '../financial-data.types';

import {
  FinancialDataProvider,
  FinancialDataProviderConfigurationError,
  FinancialDataProviderFetchResult,
} from './financial-data-provider';

interface FinnhubQuoteResponse {
  c?: number;
  d?: number;
  dp?: number;
  h?: number;
  l?: number;
  o?: number;
  pc?: number;
  t?: number;
}

@Injectable()
export class FinnhubFinancialDataProvider implements FinancialDataProvider {
  readonly kind = 'finnhub' as const;

  constructor(private readonly settings: FinancialDataProviderSettingsService) {}

  async isConfigured(): Promise<boolean> {
    return Boolean(await this.settings.getFinnhubApiKey());
  }

  async fetch(definition: FinancialDataItemConfig): Promise<FinancialDataProviderFetchResult> {
    const provider = this.assertProviderConfig(definition);
    const apiKey = await this.settings.getFinnhubApiKey();
    if (!apiKey) {
      throw new FinancialDataProviderConfigurationError('missing_api_key:finnhubApiKey', 'missing_api_key');
    }

    const url = new URL(`https://finnhub.io/api/v1${provider.endpoint}`);
    url.searchParams.set('symbol', provider.symbol);
    url.searchParams.set('token', apiKey);

    const payload = await this.fetchJson<FinnhubQuoteResponse>(url.toString(), 10_000);
    const current = typeof payload.c === 'number' && Number.isFinite(payload.c) ? payload.c : null;
    if (current === null) {
      throw new Error(`finnhub_quote_missing_price:${provider.symbol}`);
    }

    const timestampSeconds =
      typeof payload.t === 'number' && Number.isFinite(payload.t) && payload.t > 0
        ? payload.t
        : Math.floor(Date.now() / 1000);

    return {
      payload,
      requestParams: { symbol: provider.symbol },
      method: 'GET',
      providerIdentity: provider.symbol,
      points: [
        {
          recordedAt: new Date(timestampSeconds * 1000),
          value: current,
          unit: definition.defaultUnit ?? 'USD',
          dataType: definition.valueType ?? EconomicDataValueType.price,
          sourceField: provider.sourceField ?? 'price',
          meta: {
            displaySymbol: definition.snapshot?.symbol ?? provider.symbol,
            providerSymbol: provider.symbol,
            change: typeof payload.d === 'number' && Number.isFinite(payload.d) ? payload.d : null,
            changePercent: typeof payload.dp === 'number' && Number.isFinite(payload.dp) ? payload.dp : null,
            open: typeof payload.o === 'number' && Number.isFinite(payload.o) ? payload.o : null,
            high: typeof payload.h === 'number' && Number.isFinite(payload.h) ? payload.h : null,
            low: typeof payload.l === 'number' && Number.isFinite(payload.l) ? payload.l : null,
            previousClose: typeof payload.pc === 'number' && Number.isFinite(payload.pc) ? payload.pc : null,
          },
        },
      ],
    };
  }

  private assertProviderConfig(definition: FinancialDataItemConfig): FinnhubFinancialDataProviderConfig {
    const provider = definition.providerConfig;
    if (provider.kind !== 'finnhub') {
      throw new Error(`Expected finnhub provider config for ${definition.slug}`);
    }
    return provider;
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
