import {
  CommonTimeZone,
  parseDateTime,
  toISODateString,
} from '@modular/utils';
import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { lastValueFrom } from 'rxjs';

import { EnvService } from '../../config/config.service';

import { AkshareParserService } from '../akshare-parser.service';
import type {
  AkshareFinancialDataProviderConfig,
  FinancialDataItemConfig,
} from '../financial-data.types';
import type { ParsedDataPoint } from '../parsers';

import {
  FinancialDataProvider,
  FinancialDataProviderConfigurationError,
  FinancialDataProviderFetchResult,
} from './financial-data-provider';

@Injectable()
export class AkshareFinancialDataProvider implements FinancialDataProvider {
  readonly kind = 'akshare' as const;

  constructor(
    private readonly http: HttpService,
    private readonly env: EnvService,
    private readonly parserService: AkshareParserService,
  ) {}

  async isConfigured(): Promise<boolean> {
    return this.env.akshareConfig.enabled;
  }

  async fetch(definition: FinancialDataItemConfig): Promise<FinancialDataProviderFetchResult> {
    const provider = this.assertProviderConfig(definition);
    if (!(await this.isConfigured())) {
      throw new FinancialDataProviderConfigurationError('akshare_disabled', 'provider_disabled');
    }

    const params = provider.defaultParams ? this.resolveParams(provider.defaultParams) : {};
    const payload = await this.executeRequest(provider, params);
    const filteredPayload = this.applyPayloadFilter(payload, provider.filter);
    const points = this.parserService.parsePayload(provider.parser, filteredPayload, {
      slug: definition.slug,
    });

    return {
      payload,
      points,
      requestParams: params,
      method: provider.method ?? 'GET',
    };
  }

  private assertProviderConfig(definition: FinancialDataItemConfig): AkshareFinancialDataProviderConfig {
    const provider = definition.providerConfig;
    if (provider.kind !== 'akshare') {
      throw new Error(`Expected akshare provider config for ${definition.slug}`);
    }
    return provider;
  }

  private async executeRequest(
    definition: AkshareFinancialDataProviderConfig,
    params: Record<string, string | number>,
  ): Promise<unknown> {
    const config = this.env.akshareConfig;
    const url = definition.endpoint.startsWith('http')
      ? definition.endpoint
      : `${config.baseUrl.replace(/\/$/, '')}${definition.endpoint.startsWith('/') ? '' : '/'}${definition.endpoint}`;
    const method = definition.method ?? 'GET';
    const request = async () => {
      const observable = this.http.request({
        method,
        url,
        params: method === 'GET' ? params : undefined,
        data: method === 'POST' ? params : undefined,
        timeout: config.timeoutMs,
      });
      const response = await lastValueFrom(observable);
      return response.data;
    };

    return this.retry(request, config.maxRetries);
  }

  private resolveParams(params: Record<string, string | number>) {
    const resolved: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(params)) {
      resolved[key] = typeof value === 'string' ? this.resolveParamTemplate(value) : value;
    }
    return resolved;
  }

  private resolveParamTemplate(value: string) {
    return value.replace(/\$\{TODAY_YYYYMMDD([+-]\d+)?\}/g, (_match, deltaRaw) => {
      const deltaDays = typeof deltaRaw === 'string' ? Number(deltaRaw) : 0;
      if (!Number.isFinite(deltaDays)) {
        return this.getShanghaiDateYYYYMMDD(0);
      }
      return this.getShanghaiDateYYYYMMDD(deltaDays);
    });
  }

  private getShanghaiDateYYYYMMDD(deltaDays: number) {
    const now = new Date();
    const todayShanghai = toISODateString(now, CommonTimeZone.AsiaShanghai);
    const midnightShanghai =
      parseDateTime(`${todayShanghai} 00:00:00`, { timeZone: CommonTimeZone.AsiaShanghai }) ?? now;
    const shifted = new Date(midnightShanghai.getTime() + deltaDays * 24 * 60 * 60 * 1000);
    return toISODateString(shifted, CommonTimeZone.AsiaShanghai).replace(/-/g, '');
  }

  private async retry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt === attempts) {
          break;
        }
        const delayMs = Math.min(2000 * attempt, 10_000);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  private toRecordArray(payload: unknown): Record<string, unknown>[] {
    if (Array.isArray(payload)) {
      return payload.filter(
        (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item),
      );
    }
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      return [payload as Record<string, unknown>];
    }
    return [];
  }

  private normalizeNumeric(value: unknown): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed || trimmed === '--' || trimmed === '-' || trimmed.toLowerCase() === 'nan' || trimmed.toLowerCase() === 'null') {
        return null;
      }
      const sanitized = trimmed.replace(/,/g, '');
      const parsed = Number(sanitized);
      return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
  }

  private selectBestRecord(records: Record<string, unknown>[], filter: NonNullable<AkshareFinancialDataProviderConfig['filter']>) {
    const preferField = filter.preferNonZeroField;
    const rankBy = filter.rankBy;
    const rankOrder = filter.rankOrder ?? 'desc';

    let best = records[0];
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const row of records) {
      const preferredValue = preferField ? this.normalizeNumeric(row[preferField]) : null;
      const hasPreferred = preferField ? Boolean(preferredValue && preferredValue > 0) : true;

      const rankValue = rankBy ? this.normalizeNumeric(row[rankBy]) ?? 0 : 0;
      const normalizedRank = rankOrder === 'asc' ? -rankValue : rankValue;
      const score = (hasPreferred ? 1 : 0) * 1_000_000_000_000 + normalizedRank;

      if (score > bestScore) {
        best = row;
        bestScore = score;
      }
    }

    return best;
  }

  private applyPayloadFilter(payload: unknown, filter: AkshareFinancialDataProviderConfig['filter']): unknown {
    if (!filter) {
      return payload;
    }

    const records = this.toRecordArray(payload);
    if (records.length === 0) {
      throw new Error(`Payload filter expects record array (field=${filter.field})`);
    }

    const matches = records.filter((row) => String(row[filter.field] ?? '').trim() === filter.equals);
    if (matches.length === 0) {
      throw new Error(`Expected record not found: ${filter.field}=${filter.equals}`);
    }

    const mode = filter.mode ?? 'first';
    if (mode === 'all') {
      return matches;
    }
    if (mode === 'best') {
      return this.selectBestRecord(matches, filter);
    }
    return matches[0];
  }
}
