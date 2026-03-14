import type { EconomicDataFrequency, EconomicDataValueType } from "@prisma/client";

import type {
  AkshareParserConfig,
  AksharePayloadFilterConfig,
  AkshareRequestMethod,
} from "./akshare.types";

export type FinancialDataProviderKind = "akshare" | "finnhub" | "fred" | "yfinance";
export type FinancialDataProviderSecret = "finnhubApiKey" | "fredApiKey";
export type FinancialDataRequiredSecret = FinancialDataProviderSecret;
export type FinancialDataMainlineRole =
  | "canonical"
  | "derived"
  | "internal"
  | "fallback";
export type FredFinancialMetric = "latest" | "yoy" | "delta" | "percentOfMax";
export type FredFinancialValueTransform = "identity" | "millionsToTrillions";

export interface FinancialDataSnapshotMetadata {
  group: "markets" | "fed";
  bucket: "indices" | "sectors" | "commodities" | "indicators" | "money-printer";
  symbol?: string;
  name?: string;
  order?: number;
}

export interface FinancialDataVisualizationMetadata {
  preferredSourceFields?: string[];
  percentSourceFields?: string[];
}

export interface AkshareFinancialDataProviderConfig {
  kind: "akshare";
  functionName: string;
  endpoint: string;
  docUrl: string;
  method?: AkshareRequestMethod;
  defaultParams?: Record<string, string | number>;
  filter?: AksharePayloadFilterConfig;
  parser: AkshareParserConfig;
}

export interface FinnhubFinancialDataProviderConfig {
  kind: "finnhub";
  symbol: string;
  endpoint: "/quote";
  docUrl: string;
  metric: "quote_price";
  sourceField?: string;
}

export interface FredFinancialDataProviderConfig {
  kind: "fred";
  seriesId: string;
  endpoint: "/series/observations";
  docUrl: string;
  metric: FredFinancialMetric;
  sourceField?: string;
  lookback?: number;
  precision?: number;
  transform?: FredFinancialValueTransform;
}

export interface YfinanceFinancialDataProviderConfig {
  kind: "yfinance";
  symbol: string;
  endpoint: "/v8/finance/chart";
  docUrl: string;
  interval: "1d";
  period1: number;
  period2?: number | "now";
  includePrePost?: boolean;
  events?: string;
  sourceFields?: Partial<Record<"open" | "high" | "low" | "close" | "volume", string>>;
}

export type FinancialDataProviderConfig =
  | AkshareFinancialDataProviderConfig
  | FinnhubFinancialDataProviderConfig
  | FredFinancialDataProviderConfig
  | YfinanceFinancialDataProviderConfig;

export interface FinancialDataDefinitionMetadata {
  providerKind: FinancialDataProviderKind;
  providerConfig: FinancialDataProviderConfig;
  requiresSecret?: FinancialDataProviderSecret;
  defaultEnabled?: boolean;
  mainlineRole?: FinancialDataMainlineRole;
  snapshot?: FinancialDataSnapshotMetadata | null;
  dataViz?: FinancialDataVisualizationMetadata | null;
  tags?: string[];
}

export interface FinancialDataItemDefinition {
  id: string;
  slug: string;
  displayName: string;
  description?: string;
  categories: string[];
  sourceFunction: string;
  endpoint: string;
  docUrl: string;
  valueType: EconomicDataValueType;
  defaultUnit?: string;
  defaultFrequency: EconomicDataFrequency;
  providerConfig: FinancialDataProviderConfig;
  provider: FinancialDataProviderKind;
  requiresSecret?: FinancialDataProviderSecret;
  defaultEnabled?: boolean;
  mainlineRole?: FinancialDataMainlineRole;
  snapshot?: FinancialDataSnapshotMetadata | null;
  dataViz?: FinancialDataVisualizationMetadata | null;
  tags?: string[];
}

export interface FinancialDataItemConfig {
  itemId: string;
  slug: string;
  displayName: string;
  description?: string | null;
  categories: string[];
  sourceFunction: string;
  endpoint: string;
  docUrl?: string | null;
  valueType: EconomicDataValueType;
  defaultUnit?: string | null;
  defaultFrequency: EconomicDataFrequency;
  providerKind: FinancialDataProviderKind;
  providerConfig: FinancialDataProviderConfig;
  requiresSecret?: FinancialDataProviderSecret;
  defaultEnabled: boolean;
  mainlineRole: FinancialDataMainlineRole;
  snapshot?: FinancialDataSnapshotMetadata | null;
  dataViz?: FinancialDataVisualizationMetadata | null;
  tags?: string[];
}
