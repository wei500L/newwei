import type { EconomicDataFrequency, EconomicDataValueType } from "@prisma/client";

export type AkshareRequestMethod = "GET" | "POST";

export interface AkshareDataFieldConfig {
  field: string;
  label?: string;
  unit?: string;
  dataType?: EconomicDataValueType;
  decimalScale?: number;
}

export interface AkshareTimeseriesParserConfig {
  type: "timeseries";
  timestampField: string;
  timestampFormat?: string;
  categoryField?: string;
  valueFields: AkshareDataFieldConfig[];
}

export interface AkshareLatestParserConfig {
  type: "latest";
  timestampField?: string;
  categoryField?: string;
  valueFields: AkshareDataFieldConfig[];
}

export interface AkshareYieldCurveParserConfig {
  type: "yieldCurve";
  dateField: string;
  seriesFields: AkshareDataFieldConfig[];
}

export interface AkshareMacroParserConfig {
  type: "macro";
  periodField: string;
  categoryField?: string;
  valueFields: AkshareDataFieldConfig[];
}

export interface AkshareYearMonthParserConfig {
  type: "yearMonth";
  yearField: string;
  monthField: string;
  dayField?: string;
  categoryField?: string;
  valueFields: AkshareDataFieldConfig[];
}

export type AkshareParserConfig =
  | AkshareTimeseriesParserConfig
  | AkshareLatestParserConfig
  | AkshareYieldCurveParserConfig
  | AkshareMacroParserConfig
  | AkshareYearMonthParserConfig;

export interface AkshareDataItemDefinition {
  id: string;
  slug: string;
  displayName: string;
  description?: string;
  categories: string[];
  sourceFunction: string;
  endpoint: string;
  docUrl: string;
  method?: AkshareRequestMethod;
  defaultParams?: Record<string, string | number>;
  valueType: EconomicDataValueType;
  defaultUnit?: string;
  defaultFrequency: EconomicDataFrequency;
  parser: AkshareParserConfig;
  tags?: string[];
}

export interface AkshareDataItemMetadata {
  method?: AkshareRequestMethod;
  defaultParams?: Record<string, string | number> | null;
  parser?: AkshareParserConfig;
  tags?: string[];
}

export interface AkshareDataItemConfig {
  itemId: string;
  slug: string;
  displayName: string;
  description?: string | null;
  categories: string[];
  sourceFunction: string;
  endpoint: string;
  docUrl?: string | null;
  method: AkshareRequestMethod;
  defaultParams?: Record<string, string | number> | null;
  valueType: EconomicDataValueType;
  defaultUnit?: string | null;
  defaultFrequency: EconomicDataFrequency;
  parser: AkshareParserConfig;
  tags?: string[];
}

export interface AkshareJobPayload {
  dataItemId: string;
  triggeredById?: string;
  traceId?: string;
}
