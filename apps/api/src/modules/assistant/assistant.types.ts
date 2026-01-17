export type AssistantJobPayload =
  | { type: "query"; runId: string; traceId?: string }
  | { type: "report"; runId: string; traceId?: string }
  | { type: "forecast"; runId: string; traceId?: string };

export interface AssistantQueryInput {
  message: string;
}

export type AssistantReportPeriod = "daily" | "weekly";

export interface AssistantReportInput {
  period: AssistantReportPeriod;
  topic?: string;
  limit?: number;
}

export type AssistantForecastModelKind = "ets" | "arima";

export interface AssistantForecastInput {
  series: string;
  lookbackDays?: number;
  sourceField?: string;
  confidenceLevel?: number;
  modelKind?: AssistantForecastModelKind;
  seasonalPeriod?: number;
}
