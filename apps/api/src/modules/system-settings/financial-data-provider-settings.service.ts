import { Injectable } from "@nestjs/common";

import {
  SituationMonitorSettingsPublic,
  SituationMonitorSettingsService,
} from "./situation-monitor-settings.service";

export interface FinancialDataProviderRuntimeConfig {
  finnhubApiKey?: string;
  fredApiKey?: string;
}

export interface FinancialDataProviderStatus {
  hasFinnhubApiKey: boolean;
  hasFredApiKey: boolean;
  finnhubApiKeySource: SituationMonitorSettingsPublic["finnhubApiKeySource"];
  fredApiKeySource: SituationMonitorSettingsPublic["fredApiKeySource"];
}

@Injectable()
export class FinancialDataProviderSettingsService {
  constructor(
    private readonly situationMonitorSettings: SituationMonitorSettingsService,
  ) {}

  async getProviderRuntimeConfig(): Promise<FinancialDataProviderRuntimeConfig> {
    const runtime =
      await this.situationMonitorSettings.getExternalApiRuntimeConfig();
    return {
      finnhubApiKey: runtime.finnhubApiKey,
      fredApiKey: runtime.fredApiKey,
    };
  }

  async getFinnhubApiKey(): Promise<string | undefined> {
    const runtime = await this.getProviderRuntimeConfig();
    return runtime.finnhubApiKey;
  }

  async getFredApiKey(): Promise<string | undefined> {
    const runtime = await this.getProviderRuntimeConfig();
    return runtime.fredApiKey;
  }

  async getProviderStatus(): Promise<FinancialDataProviderStatus> {
    const settings = await this.situationMonitorSettings.getPublicSettings();
    return {
      hasFinnhubApiKey: settings.hasFinnhubApiKey,
      hasFredApiKey: settings.hasFredApiKey,
      finnhubApiKeySource: settings.finnhubApiKeySource,
      fredApiKeySource: settings.fredApiKeySource,
    };
  }
}
