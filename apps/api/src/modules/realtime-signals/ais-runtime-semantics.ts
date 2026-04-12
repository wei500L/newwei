import {
  AIS_RELAY_REASON_CODES,
  type RealtimeAisRuntimeDiagnostics,
} from "@modular/utils";

import type {
  RealtimeAisRelayDiagnostics,
  RealtimeAisLatestSnapshot,
  RealtimeSignalSourceState,
} from "./realtime-signals.types";

const AIS_SNAPSHOT_MISSING_VESSELS_CONTRACT_REASON =
  "AIS relay reports tracked vessels, but the snapshot payload omits vessels[] and only exposes aggregated signals.";
const AIS_RELAY_REASON_CODE_SET = new Set<string>(AIS_RELAY_REASON_CODES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readConfigured(sourceState?: Pick<RealtimeSignalSourceState, "context"> | null) {
  const context = isRecord(sourceState?.context) ? sourceState.context : undefined;
  return context?.configured === false ? false : true;
}

function readSnapshotDiagnostics(
  snapshot: RealtimeAisLatestSnapshot,
): RealtimeAisRelayDiagnostics {
  return snapshot.diagnostics ?? {
    healthState: "ok",
    positionReportsSeen: 0,
    positionReportsProcessed: 0,
    ignoredPositionReports: 0,
    parseErrors: 0,
  };
}

function readRelayReason(snapshot: RealtimeAisLatestSnapshot) {
  const diagnostics = readSnapshotDiagnostics(snapshot);
  const statusReasonCode = normalizeString(diagnostics.statusReasonCode);
  const statusReason = normalizeString(diagnostics.statusReason);
  if (!statusReasonCode && !statusReason) {
    return undefined;
  }
  return {
    ...(statusReasonCode && AIS_RELAY_REASON_CODE_SET.has(statusReasonCode)
      ? { code: statusReasonCode as RealtimeAisRuntimeDiagnostics["statusReasonCode"] }
      : {}),
    ...(statusReason ? { reason: statusReason } : {}),
  };
}

function readProductReason(snapshot: RealtimeAisLatestSnapshot) {
  if (snapshot.status.vessels <= 0 || snapshot.hasVesselSnapshot) {
    return undefined;
  }

  return {
    code: "ais_snapshot_missing_vessels_contract" as const,
    reason: AIS_SNAPSHOT_MISSING_VESSELS_CONTRACT_REASON,
  };
}

export interface AisRuntimeSemantics {
  diagnostics: RealtimeAisRuntimeDiagnostics;
  statusReasonCode?: string;
  statusReason?: string;
}

export function buildAisRuntimeSemantics(params: {
  snapshot?: RealtimeAisLatestSnapshot | null;
  sourceState?: Pick<
    RealtimeSignalSourceState,
    "context" | "lastError" | "lastErrorCode" | "status"
  > | null;
}): AisRuntimeSemantics {
  const configured = readConfigured(params.sourceState);

  if (!params.snapshot) {
    return {
      diagnostics: {
        configured,
        connected: false,
        healthState: "ok",
        allVesselsAvailable: false,
        candidateCount: 0,
        vesselCount: 0,
        disruptionsCount: 0,
        densityRegions: 0,
        messageCount: 0,
        droppedMessages: 0,
        positionReportsSeen: 0,
        positionReportsProcessed: 0,
        ignoredPositionReports: 0,
        parseErrors: 0,
      },
      ...(params.sourceState?.status === "error" &&
      normalizeString(params.sourceState.lastError)
        ? {
            statusReasonCode: normalizeString(params.sourceState.lastErrorCode),
            statusReason: normalizeString(params.sourceState.lastError),
          }
        : {}),
    };
  }

  const relayReason = readRelayReason(params.snapshot);
  const productReason = relayReason ? undefined : readProductReason(params.snapshot);
  const diagnosticsReason = relayReason ?? productReason;
  const snapshotDiagnostics = readSnapshotDiagnostics(params.snapshot);
  const fallbackSourceError =
    params.sourceState?.status === "error" &&
    normalizeString(params.sourceState.lastError)
      ? {
          statusReasonCode: normalizeString(params.sourceState.lastErrorCode),
          statusReason: normalizeString(params.sourceState.lastError),
        }
      : undefined;

  return {
    diagnostics: {
      configured,
      connected: params.snapshot.status.connected,
      healthState: snapshotDiagnostics.healthState,
      snapshotUpdatedAt: params.snapshot.updatedAt,
      allVesselsAvailable: params.snapshot.hasVesselSnapshot,
      candidateCount: params.snapshot.candidateReports.length,
      vesselCount: params.snapshot.status.vessels,
      disruptionsCount: params.snapshot.disruptions.length,
      densityRegions: params.snapshot.density.length,
      messageCount: params.snapshot.status.messages,
      droppedMessages: params.snapshot.status.droppedMessages,
      positionReportsSeen: snapshotDiagnostics.positionReportsSeen,
      positionReportsProcessed: snapshotDiagnostics.positionReportsProcessed,
      ignoredPositionReports: snapshotDiagnostics.ignoredPositionReports,
      parseErrors: snapshotDiagnostics.parseErrors,
      ...(diagnosticsReason?.code
        ? { statusReasonCode: diagnosticsReason.code }
        : {}),
      ...(diagnosticsReason?.reason ? { statusReason: diagnosticsReason.reason } : {}),
      ...(snapshotDiagnostics.lastHealthyAt
        ? { lastHealthyAt: snapshotDiagnostics.lastHealthyAt }
        : {}),
      ...(snapshotDiagnostics.lastIssueAt
        ? { lastIssueAt: snapshotDiagnostics.lastIssueAt }
        : {}),
      ...(snapshotDiagnostics.lastConnectedAt
        ? { lastConnectedAt: snapshotDiagnostics.lastConnectedAt }
        : {}),
      ...(snapshotDiagnostics.lastMessageAt
        ? { lastMessageAt: snapshotDiagnostics.lastMessageAt }
        : {}),
      ...(snapshotDiagnostics.lastUpstreamErrorAt
        ? { lastUpstreamErrorAt: snapshotDiagnostics.lastUpstreamErrorAt }
        : {}),
      ...(snapshotDiagnostics.lastUpstreamError
        ? { lastUpstreamError: snapshotDiagnostics.lastUpstreamError }
        : {}),
      ...(snapshotDiagnostics.lastParseErrorAt
        ? { lastParseErrorAt: snapshotDiagnostics.lastParseErrorAt }
        : {}),
      ...(snapshotDiagnostics.lastParseError
        ? { lastParseError: snapshotDiagnostics.lastParseError }
        : {}),
    },
    ...(diagnosticsReason?.code
      ? { statusReasonCode: diagnosticsReason.code }
      : fallbackSourceError?.statusReasonCode
        ? { statusReasonCode: fallbackSourceError.statusReasonCode }
        : {}),
    ...(diagnosticsReason?.reason
      ? { statusReason: diagnosticsReason.reason }
      : fallbackSourceError?.statusReason
        ? { statusReason: fallbackSourceError.statusReason }
        : {}),
  };
}
