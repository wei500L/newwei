export type RelayHealthState = "ok" | "degraded";

export interface RelayHealthDiagnostics {
  healthState: RelayHealthState;
  statusReasonCode?: string;
  statusReason?: string;
  positionReportsSeen: number;
  positionReportsProcessed: number;
  ignoredPositionReports: number;
  parseErrors: number;
  lastHealthyAt?: string;
  lastIssueAt?: string;
  lastConnectedAt?: string;
  lastMessageAt?: string;
  lastUpstreamErrorAt?: string;
  lastUpstreamError?: string;
  lastParseErrorAt?: string;
  lastParseError?: string;
}

export interface RelayHealthSnapshot {
  connected: boolean;
  vessels: number;
  messages: number;
  droppedMessages: number;
  densityZones: number;
  sharedSecretEnabled: boolean;
  diagnostics: RelayHealthDiagnostics;
}

export function buildRelayLivenessPayload(now = new Date()) {
  return {
    status: "ok" as const,
    service: "ais-relay" as const,
    now: now.toISOString(),
  };
}

export function buildRelayHealthPayload(snapshot: RelayHealthSnapshot) {
  return {
    status: snapshot.diagnostics.healthState,
    connected: snapshot.connected,
    vessels: snapshot.vessels,
    messages: snapshot.messages,
    droppedMessages: snapshot.droppedMessages,
    densityZones: snapshot.densityZones,
    sharedSecretEnabled: snapshot.sharedSecretEnabled,
    diagnostics: snapshot.diagnostics,
  };
}
