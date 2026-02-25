export type AssistantJobPayload =
  | { type: "query"; runId: string; orgId?: string; traceId?: string }
  | { type: "report"; runId: string; orgId?: string; traceId?: string }
  | { type: "forecast"; runId: string; orgId?: string; traceId?: string };

export type AssistantKnowledgeSource = "site_db" | "web_search";

export interface AssistantQueryInput {
  message: string;
  conversationId?: string;
  knowledgeSource?: AssistantKnowledgeSource;
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
