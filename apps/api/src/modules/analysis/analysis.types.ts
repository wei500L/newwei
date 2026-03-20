import type { SeriesPoint } from "./anomaly-detector";

export type AnalysisJobPayload =
  | { type: "correlation"; analysisId: string; orgId?: string; traceId?: string }
  | { type: "anomaly"; analysisId: string; orgId?: string; traceId?: string }
  | { type: "geo_transport"; analysisId: string; orgId?: string; traceId?: string };

export interface CorrelationInput {
  indicatorName: string;
  value: number;
  changePercent: number;
  startDate: string;
  endDate: string;
  newsSummaries: string[];
}

export interface AnomalyInput {
  metric: string;
  timestamp: string;
  value: number;
  deviationPercent: number;
  newsList: string[];
  policyList: string[];
  series?: SeriesPoint[];
}

export type GeoTransportKind = "aircraft" | "vessel";

export interface GeoTransportInput {
  transportKinds: GeoTransportKind[];
  startDate: string;
  endDate: string;
  bbox?: [number, number, number, number];
  objectKeys?: string[];
}
