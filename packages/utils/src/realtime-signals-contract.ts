export const AIS_RELAY_REASON_CODES = [
  "ais_upstream_disconnected",
  "ais_upstream_no_messages_after_connect",
  "ais_upstream_stalled",
  "ais_position_reports_not_retained",
  "ais_position_reports_mostly_ignored",
  "ais_payload_parse_errors",
] as const;

export type AisRelayReasonCode = (typeof AIS_RELAY_REASON_CODES)[number];

export const AIS_PRODUCT_REASON_CODES = [
  "ais_snapshot_missing_vessels_contract",
] as const;

export type AisProductReasonCode = (typeof AIS_PRODUCT_REASON_CODES)[number];

export type AisSurfaceReasonCode = AisRelayReasonCode | AisProductReasonCode;

export interface RealtimeAisRuntimeDiagnostics {
  configured: boolean;
  connected: boolean;
  healthState: "ok" | "degraded";
  snapshotUpdatedAt?: string;
  allVesselsAvailable: boolean;
  candidateCount: number;
  vesselCount: number;
  disruptionsCount: number;
  densityRegions: number;
  messageCount: number;
  droppedMessages: number;
  positionReportsSeen: number;
  positionReportsProcessed: number;
  ignoredPositionReports: number;
  parseErrors: number;
  statusReasonCode?: AisSurfaceReasonCode;
  statusReason?: string;
  lastHealthyAt?: string;
  lastIssueAt?: string;
  lastConnectedAt?: string;
  lastMessageAt?: string;
  lastUpstreamErrorAt?: string;
  lastUpstreamError?: string;
  lastParseErrorAt?: string;
  lastParseError?: string;
}
