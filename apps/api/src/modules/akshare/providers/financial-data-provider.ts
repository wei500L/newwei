import { Injectable } from '@nestjs/common';

import type { FinancialDataItemConfig, FinancialDataProviderKind } from '../financial-data.types';
import type { ParsedDataPoint } from '../parsers';

export class FinancialDataProviderConfigurationError extends Error {
  constructor(
    message: string,
    readonly code: 'missing_api_key' | 'provider_disabled',
  ) {
    super(message);
    this.name = 'FinancialDataProviderConfigurationError';
  }
}

export interface FinancialDataProviderCleanup {
  deleteRecordedAts?: Date[];
}

export interface FinancialDataProviderFetchResult {
  payload: unknown;
  points: ParsedDataPoint[];
  cleanup?: FinancialDataProviderCleanup;
  requestParams?: Record<string, unknown>;
  method?: string;
  providerIdentity?: string;
}

export interface FinancialDataProvider {
  readonly kind: FinancialDataProviderKind;
  isConfigured(): Promise<boolean>;
  fetch(definition: FinancialDataItemConfig): Promise<FinancialDataProviderFetchResult>;
}

@Injectable()
export class FinancialDataProviderRegistry {
  private readonly providers = new Map<FinancialDataProviderKind, FinancialDataProvider>();

  register(provider: FinancialDataProvider): void {
    this.providers.set(provider.kind, provider);
  }

  get(kind: FinancialDataProviderKind): FinancialDataProvider {
    const provider = this.providers.get(kind);
    if (!provider) {
      throw new Error(`Unsupported financial data provider: ${kind}`);
    }
    return provider;
  }
}
