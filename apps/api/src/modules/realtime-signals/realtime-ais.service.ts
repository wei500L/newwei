import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";

import { buildAisRuntimeSemantics } from "./ais-runtime-semantics";
import { REALTIME_SIGNAL_METRIC_SLUGS } from "./realtime-signals.constants";
import {
  extractCountryCode,
  fetchJsonWithRetry,
  normalizeString,
  normalizeUrl,
  readArray,
  toFiniteNumber,
  toIsoTimestamp,
  isValidCoordinate,
} from "./realtime-signals.helpers";
import { RealtimeSignalsSnapshotStore } from "./realtime-signals.snapshot-store";
import type {
  RealtimeAisDensitySnapshot,
  RealtimeAisDisruptionSeverity,
  RealtimeAisDisruptionSnapshot,
  RealtimeAisLatestSnapshot,
  RealtimeAisRelayDiagnostics,
  RealtimeAisRelayStatusSnapshot,
  RealtimeAisVesselSnapshot,
  RealtimeSignalFetchResult,
  RealtimeSignalsRuntimeConfig,
} from "./realtime-signals.types";
import { RealtimeTransportPersistenceService } from "./realtime-transport-persistence.service";

const logger = createLogger({ name: "realtime-signals" });

@Injectable()
export class RealtimeAisService {
  private readonly aisRelayIssueCodeByOrg = new Map<string, string>();

  constructor(
    private readonly store: RealtimeSignalsSnapshotStore,
    private readonly transport: RealtimeTransportPersistenceService,
  ) {}

  private getAisSnapshotTtlSeconds(intervalSec: number) {
    const safeIntervalSec = Math.max(60, Math.trunc(intervalSec));
    return Math.max(10 * 60, safeIntervalSec * 2);
  }

  private normalizeAisMmsi(value: unknown) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(Math.trunc(value));
    }
    return normalizeString(value);
  }

  private logAisRelayStatusChange(
    orgId: string,
    snapshot: RealtimeAisLatestSnapshot,
  ) {
    const aisRuntime = buildAisRuntimeSemantics({ snapshot });
    const issueIdentity =
      aisRuntime.diagnostics.statusReasonCode ??
      aisRuntime.diagnostics.statusReason ??
      (snapshot.diagnostics.healthState === "degraded" ? "degraded" : "ok");
    const previousIssueIdentity = this.aisRelayIssueCodeByOrg.get(orgId);
    if (previousIssueIdentity === issueIdentity) {
      return;
    }

    this.aisRelayIssueCodeByOrg.set(orgId, issueIdentity);
    if (issueIdentity === "ok") {
      if (previousIssueIdentity && previousIssueIdentity !== "ok") {
        logger.info(
          {
            orgId,
            source: "ais",
            previousIssueCode: previousIssueIdentity,
            updatedAt: snapshot.updatedAt,
          },
          "AIS relay snapshot recovered",
        );
      }
      return;
    }

    logger.warn(
      {
        orgId,
        source: "ais",
        issueCode: aisRuntime.diagnostics.statusReasonCode,
        issueIdentity,
        issueReason: aisRuntime.diagnostics.statusReason,
        connected: snapshot.status.connected,
        messages: snapshot.status.messages,
        vessels: snapshot.status.vessels,
        positionReportsSeen: snapshot.diagnostics.positionReportsSeen,
        positionReportsProcessed: snapshot.diagnostics.positionReportsProcessed,
        ignoredPositionReports: snapshot.diagnostics.ignoredPositionReports,
        parseErrors: snapshot.diagnostics.parseErrors,
        updatedAt: snapshot.updatedAt,
      },
      "AIS relay snapshot reports degraded state",
    );
  }

  async fetchAisSignal(orgId: string, runtime: RealtimeSignalsRuntimeConfig) {
    const aisBase = normalizeUrl(runtime.aisRelay.baseUrl);
    if (!aisBase) {
      await this.store.clearLatestAisSnapshot(orgId);
      return [
        {
          metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.ais,
          value: 0,
          context: {
            source: "relay",
            configured: false,
            countryCodes: [],
          },
        },
      ] satisfies RealtimeSignalFetchResult[];
    }
    const headers = this.buildAisHeaders(runtime);
    const payload = await fetchJsonWithRetry(
      `${aisBase}/ais/snapshot?candidates=true`,
      runtime,
      headers ? { headers } : undefined,
    );
    const snapshot = this.buildAisLatestSnapshot(
      payload,
      `${aisBase}/ais/snapshot`,
    );
    this.logAisRelayStatusChange(orgId, snapshot);
    await this.store.setLatestAisSnapshot(
      orgId,
      snapshot,
      this.getAisSnapshotTtlSeconds(runtime.sources.ais.intervalSec),
    );
    await this.transport.persistAisTransportSnapshot(orgId, snapshot);

    const countries = new Set<string>();
    for (const disruption of snapshot.disruptions) {
      const code = extractCountryCode(disruption.region);
      if (code) {
        countries.add(code);
      }
    }

    return [
      {
        metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.ais,
        value: snapshot.disruptions.length,
        context: {
          source: "relay",
          configured: true,
          countryCodes: Array.from(countries),
        },
      },
    ] satisfies RealtimeSignalFetchResult[];
  }

  private buildAisLatestSnapshot(
    payload: unknown,
    sourceEndpoint: string,
  ): RealtimeAisLatestSnapshot {
    const {
      updatedAt,
      status,
      diagnostics,
      disruptions,
      density,
      candidateReports,
      vessels,
    } = this.readAisSnapshotPayload(payload);
    return {
      source: "relay",
      sourceEndpoint,
      updatedAt,
      status,
      diagnostics,
      disruptions,
      density,
      candidateReports,
      vessels,
      hasVesselSnapshot: Array.isArray(
        (payload as { vessels?: unknown } | null | undefined)?.vessels,
      ),
    };
  }

  private normalizeAisStatusPayload(
    value: unknown,
  ): RealtimeAisRelayStatusSnapshot {
    const record =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return {
      connected: record.connected === true,
      vessels: Math.max(0, Math.round(toFiniteNumber(record.vessels) ?? 0)),
      messages: Math.max(0, Math.round(toFiniteNumber(record.messages) ?? 0)),
      clients: Math.max(0, Math.round(toFiniteNumber(record.clients) ?? 0)),
      droppedMessages: Math.max(
        0,
        Math.round(toFiniteNumber(record.droppedMessages) ?? 0),
      ),
    };
  }

  private normalizeAisRelayDiagnostics(
    value: unknown,
  ): RealtimeAisRelayDiagnostics {
    const record =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const statusReasonCode = normalizeString(record.statusReasonCode);
    const statusReason = normalizeString(record.statusReason);
    const healthState =
      normalizeString(record.healthState) === "degraded" ? "degraded" : "ok";
    return {
      healthState,
      ...(statusReasonCode ? { statusReasonCode } : {}),
      ...(statusReason ? { statusReason } : {}),
      positionReportsSeen: Math.max(
        0,
        Math.round(toFiniteNumber(record.positionReportsSeen) ?? 0),
      ),
      positionReportsProcessed: Math.max(
        0,
        Math.round(toFiniteNumber(record.positionReportsProcessed) ?? 0),
      ),
      ignoredPositionReports: Math.max(
        0,
        Math.round(toFiniteNumber(record.ignoredPositionReports) ?? 0),
      ),
      parseErrors: Math.max(
        0,
        Math.round(toFiniteNumber(record.parseErrors) ?? 0),
      ),
      ...(normalizeString(record.lastHealthyAt)
        ? { lastHealthyAt: toIsoTimestamp(record.lastHealthyAt) }
        : {}),
      ...(normalizeString(record.lastIssueAt)
        ? { lastIssueAt: toIsoTimestamp(record.lastIssueAt) }
        : {}),
      ...(normalizeString(record.lastConnectedAt)
        ? { lastConnectedAt: toIsoTimestamp(record.lastConnectedAt) }
        : {}),
      ...(normalizeString(record.lastMessageAt)
        ? { lastMessageAt: toIsoTimestamp(record.lastMessageAt) }
        : {}),
      ...(normalizeString(record.lastUpstreamErrorAt)
        ? {
            lastUpstreamErrorAt: toIsoTimestamp(record.lastUpstreamErrorAt),
          }
        : {}),
      ...(normalizeString(record.lastUpstreamError)
        ? { lastUpstreamError: normalizeString(record.lastUpstreamError) }
        : {}),
      ...(normalizeString(record.lastParseErrorAt)
        ? { lastParseErrorAt: toIsoTimestamp(record.lastParseErrorAt) }
        : {}),
      ...(normalizeString(record.lastParseError)
        ? { lastParseError: normalizeString(record.lastParseError) }
        : {}),
    };
  }

  private normalizeAisDisruptionSeverity(
    value: unknown,
  ): RealtimeAisDisruptionSeverity {
    const normalized = normalizeString(value)?.toLowerCase();
    if (normalized === "high") {
      return "high";
    }
    if (normalized === "elevated" || normalized === "medium") {
      return "elevated";
    }
    return "low";
  }

  private normalizeAisDisruptionSnapshot(
    value: unknown,
    index: number,
  ): RealtimeAisDisruptionSnapshot | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const lat = toFiniteNumber(record.lat);
    const lng = toFiniteNumber(record.lon ?? record.lng);
    if (!isValidCoordinate(lat, lng)) {
      return null;
    }

    const id = normalizeString(record.id) ?? `ais-disruption-${index + 1}`;
    const name = normalizeString(record.name) ?? id;
    const type = normalizeString(record.type) ?? "unknown";
    return {
      id,
      name,
      type,
      lat: lat!,
      lng: lng!,
      severity: this.normalizeAisDisruptionSeverity(record.severity),
      ...(typeof toFiniteNumber(record.changePct) === "number"
        ? { changePct: toFiniteNumber(record.changePct)! }
        : {}),
      ...(typeof toFiniteNumber(record.windowHours) === "number"
        ? { windowHours: toFiniteNumber(record.windowHours)! }
        : {}),
      ...(typeof toFiniteNumber(record.vesselCount) === "number"
        ? { vesselCount: toFiniteNumber(record.vesselCount)! }
        : {}),
      ...(typeof toFiniteNumber(record.darkShips) === "number"
        ? { darkShips: toFiniteNumber(record.darkShips)! }
        : {}),
      ...(normalizeString(record.region)
        ? { region: normalizeString(record.region) }
        : {}),
      ...(normalizeString(record.description)
        ? { description: normalizeString(record.description) }
        : {}),
    };
  }

  private normalizeAisDensitySnapshot(
    value: unknown,
    index: number,
  ): RealtimeAisDensitySnapshot | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const lat = toFiniteNumber(record.lat);
    const lng = toFiniteNumber(record.lon ?? record.lng);
    const intensity = toFiniteNumber(record.intensity);
    if (!isValidCoordinate(lat, lng) || intensity === null) {
      return null;
    }

    return {
      id: normalizeString(record.id) ?? `ais-density-${index + 1}`,
      ...(normalizeString(record.name)
        ? { name: normalizeString(record.name) }
        : {}),
      lat: lat!,
      lng: lng!,
      intensity: Math.min(1, Math.max(0, intensity)),
      ...(typeof toFiniteNumber(record.deltaPct) === "number"
        ? { deltaPct: toFiniteNumber(record.deltaPct)! }
        : {}),
      ...(typeof toFiniteNumber(record.shipsPerDay) === "number"
        ? { shipsPerDay: toFiniteNumber(record.shipsPerDay)! }
        : {}),
      ...(normalizeString(record.note)
        ? { note: normalizeString(record.note) }
        : {}),
    };
  }

  private normalizeAisVesselSnapshot(
    value: unknown,
    fallbackObservedAt: string,
  ): RealtimeAisVesselSnapshot | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const mmsi = this.normalizeAisMmsi(
      record.mmsi ?? record.MMSI ?? record.MMSI_String,
    );
    const lat = toFiniteNumber(record.lat);
    const lng = toFiniteNumber(record.lon ?? record.lng);
    if (!mmsi || !isValidCoordinate(lat, lng)) {
      return null;
    }

    const shipType = toFiniteNumber(
      record.shipType ?? record.ship_type ?? record.ShipType,
    );
    const heading = toFiniteNumber(record.heading ?? record.TrueHeading);
    const speed = toFiniteNumber(record.speed ?? record.Sog);
    const course = toFiniteNumber(record.course ?? record.Cog);

    return {
      mmsi,
      ...(normalizeString(record.name ?? record.ShipName)
        ? { name: normalizeString(record.name ?? record.ShipName) }
        : {}),
      lat: lat!,
      lng: lng!,
      ...(typeof shipType === "number" ? { shipType } : {}),
      ...(typeof heading === "number" ? { heading } : {}),
      ...(typeof speed === "number" ? { speed } : {}),
      ...(typeof course === "number" ? { course } : {}),
      observedAt: toIsoTimestamp(
        record.observedAt ?? record.timestamp ?? fallbackObservedAt,
      ),
    };
  }

  private readAisSnapshotPayload(payload: unknown) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error(
        "AIS relay returned an invalid snapshot payload. Expected disruptions[] and density[].",
      );
    }

    const record = payload as {
      timestamp?: unknown;
      status?: unknown;
      diagnostics?: unknown;
      disruptions?: unknown;
      density?: unknown;
      candidateReports?: unknown;
      vessels?: unknown;
    };
    if (!Array.isArray(record.disruptions) || !Array.isArray(record.density)) {
      throw new Error(
        "AIS relay returned an invalid snapshot payload. Expected disruptions[] and density[].",
      );
    }

    const updatedAt = toIsoTimestamp(record.timestamp ?? new Date());
    return {
      updatedAt,
      status: this.normalizeAisStatusPayload(record.status),
      diagnostics: this.normalizeAisRelayDiagnostics(record.diagnostics),
      disruptions: record.disruptions
        .map((entry, index) =>
          this.normalizeAisDisruptionSnapshot(entry, index),
        )
        .filter((entry): entry is RealtimeAisDisruptionSnapshot =>
          Boolean(entry),
        ),
      density: record.density
        .map((entry, index) => this.normalizeAisDensitySnapshot(entry, index))
        .filter((entry): entry is RealtimeAisDensitySnapshot => Boolean(entry)),
      candidateReports: readArray(record.candidateReports)
        .map((entry) => this.normalizeAisVesselSnapshot(entry, updatedAt))
        .filter((entry): entry is RealtimeAisVesselSnapshot => Boolean(entry)),
      vessels: readArray(record.vessels)
        .map((entry) => this.normalizeAisVesselSnapshot(entry, updatedAt))
        .filter((entry): entry is RealtimeAisVesselSnapshot => Boolean(entry)),
    };
  }

  private buildAisHeaders(runtime: RealtimeSignalsRuntimeConfig) {
    const secret = runtime.aisRelay.sharedSecret?.trim();
    if (!secret) {
      return undefined;
    }
    return {
      Authorization: `Bearer ${secret}`,
    } satisfies Record<string, string>;
  }
}
