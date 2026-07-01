import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";

import type { AisRelayReasonCode } from "@modular/utils";
import { config as loadEnv } from "dotenv";
import { WebSocket, type RawData } from "ws";

import {
  getNumber,
  isLikelyMilitaryCandidate,
  normalizeMmsi,
  normalizeString,
} from "./candidate-classification";
import {
  buildRelayHealthPayload,
  buildRelayLivenessPayload,
  type RelayHealthDiagnostics,
  type RelayHealthState,
} from "./health";
import { closeUpstreamSocketForShutdown } from "./shutdown";

loadEnv({ path: path.resolve(process.cwd(), "../../.env") });

const AISSTREAM_URL =
  normalizeString(
    process.env.AISSTREAM_URL ?? process.env.AIS_RELAY_UPSTREAM_URL,
  ) ?? "wss://stream.aisstream.io/v0/stream";
const GRID_SIZE_DEG = 2;
const DENSITY_WINDOW_MS = 30 * 60 * 1_000;
const GAP_THRESHOLD_MS = 60 * 60 * 1_000;
const DARK_SHIP_FRESHNESS_MS = 10 * 60 * 1_000;
const CANDIDATE_RETENTION_MS = 2 * 60 * 60 * 1_000;
const MAX_DENSITY_ZONES = 200;
const MAX_DENSITY_CELLS = 5_000;
const RECONNECT_DELAY_MS = 5_000;
const SNAPSHOT_CACHE_TTL_MS = Math.max(
  2_000,
  readPositiveInt(process.env.AIS_SNAPSHOT_INTERVAL_MS, 5_000),
);
const UPSTREAM_QUEUE_HARD_CAP = readPositiveInt(
  process.env.AIS_UPSTREAM_QUEUE_HARD_CAP,
  8_000,
);
const UPSTREAM_DRAIN_BATCH = readPositiveInt(
  process.env.AIS_UPSTREAM_DRAIN_BATCH,
  250,
);
const UPSTREAM_DRAIN_BUDGET_MS = readPositiveInt(
  process.env.AIS_UPSTREAM_DRAIN_BUDGET_MS,
  20,
);
const RELAY_HEALTH_MIN_POSITION_REPORTS = readPositiveInt(
  process.env.AIS_RELAY_HEALTH_MIN_POSITION_REPORTS,
  25,
);
const RELAY_HEALTH_MAX_IGNORED_RATIO_PERCENT = readPositiveInt(
  process.env.AIS_RELAY_HEALTH_MAX_IGNORED_RATIO_PERCENT,
  85,
  1,
);
const RELAY_HEALTH_MAX_PARSE_ERROR_RATIO_PERCENT = readPositiveInt(
  process.env.AIS_RELAY_HEALTH_MAX_PARSE_ERROR_RATIO_PERCENT,
  20,
  1,
);
const RELAY_HEALTH_NO_MESSAGES_AFTER_CONNECT_MS = readPositiveInt(
  process.env.AIS_RELAY_HEALTH_NO_MESSAGES_AFTER_CONNECT_MS,
  60_000,
  5_000,
);
const RELAY_HEALTH_STALE_MESSAGES_MS = readPositiveInt(
  process.env.AIS_RELAY_HEALTH_STALE_MESSAGES_MS,
  90_000,
  10_000,
);
const MAX_VESSELS = readPositiveInt(process.env.AIS_MAX_VESSELS, 20_000, 1_000);
const MAX_VESSEL_HISTORY = readPositiveInt(
  process.env.AIS_MAX_VESSEL_HISTORY,
  20_000,
  1_000,
);
const MAX_CANDIDATE_REPORTS = readPositiveInt(
  process.env.AIS_MAX_CANDIDATE_REPORTS,
  1_500,
  100,
);
const PORT = readPositiveInt(
  process.env.PORT ?? process.env.AIS_RELAY_PORT,
  3_004,
);
const HOST =
  normalizeString(process.env.AIS_RELAY_HOST ?? process.env.HOST) ?? "0.0.0.0";
const AISSTREAM_API_KEY = normalizeString(process.env.AISSTREAM_API_KEY);
const AIS_SHARED_SECRET =
  normalizeString(
    process.env.AIS_RELAY_SHARED_SECRET ?? process.env.RELAY_SHARED_SECRET,
  ) ?? "";

if (!AISSTREAM_API_KEY) {
  throw new Error("AISSTREAM_API_KEY is required");
}

type VesselState = {
  mmsi: string;
  name?: string;
  lat: number;
  lon: number;
  timestamp: number;
  shipType?: number;
  heading?: number;
  speed?: number;
  course?: number;
};

type DensityCell = {
  key: string;
  lat: number;
  lon: number;
  vesselIds: Set<string>;
  previousCount: number;
  lastUpdate: number;
};

type CandidateReport = {
  mmsi: string;
  name?: string;
  lat: number;
  lon: number;
  shipType?: number;
  heading?: number;
  speed?: number;
  course?: number;
  timestamp: number;
};

type AisSnapshot = {
  sequence: number;
  timestamp: string;
  status: {
    connected: boolean;
    vessels: number;
    messages: number;
    clients: number;
    droppedMessages: number;
  };
  diagnostics: RelayHealthDiagnostics;
  disruptions: Array<Record<string, unknown>>;
  density: Array<Record<string, unknown>>;
  candidateReports: CandidateReport[];
  vessels: CandidateReport[];
};

const CHOKEPOINTS = [
  { name: "Strait of Hormuz", lat: 26.5, lon: 56.5, radius: 2 },
  { name: "Suez Canal", lat: 30, lon: 32.5, radius: 1 },
  { name: "Malacca Strait", lat: 2.5, lon: 101.5, radius: 2 },
  { name: "Bab el-Mandeb Strait", lat: 12.5, lon: 43.5, radius: 1.5 },
  { name: "Panama Canal", lat: 9, lon: -79.5, radius: 1 },
  { name: "Taiwan Strait", lat: 24.5, lon: 119.5, radius: 2 },
  { name: "South China Sea", lat: 15, lon: 115, radius: 5 },
  { name: "Black Sea", lat: 43.5, lon: 34, radius: 3 },
  { name: "Cape of Good Hope", lat: -34.36, lon: 18.49, radius: 2 },
  { name: "Gibraltar Strait", lat: 35.96, lon: -5.35, radius: 1 },
  { name: "Bosporus Strait", lat: 40.7, lon: 28, radius: 1.5 },
  { name: "Korea Strait", lat: 34, lon: 129, radius: 1.5 },
  { name: "Dover Strait", lat: 51.05, lon: 1.45, radius: 0.5 },
  { name: "Kerch Strait", lat: 45.33, lon: 36.6, radius: 0.5 },
  { name: "Lombok Strait", lat: -8.47, lon: 115.72, radius: 0.5 },
] as const;

const vessels = new Map<string, VesselState>();
const vesselHistory = new Map<string, number[]>();
const vesselGridKeys = new Map<string, string>();
const densityGrid = new Map<string, DensityCell>();
const candidateReports = new Map<string, CandidateReport>();

let upstreamSocket: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let upstreamQueue: RawData[] = [];
let upstreamQueueReadIndex = 0;
let drainScheduled = false;
let messageCount = 0;
let droppedMessages = 0;
let positionReportsSeen = 0;
let positionReportsProcessed = 0;
let ignoredPositionReports = 0;
let parseErrors = 0;
let snapshotSequence = 0;
let lastSnapshot: AisSnapshot | null = null;
let lastSnapshotAt = 0;
let lastSnapshotJsonWithoutCandidates: string | null = null;
let lastSnapshotJsonWithCandidates: string | null = null;
let lastParseErrorAt = 0;
let lastParseErrorMessage: string | undefined;
let lastUpstreamConnectedAt = 0;
let lastUpstreamMessageAt = 0;
let lastUpstreamErrorAt = 0;
let lastUpstreamErrorMessage: string | undefined;
let relayHealthState: RelayHealthState = "ok";
let relayStatusReasonCode: AisRelayReasonCode | undefined;
let relayStatusReason: string | undefined;
let lastRelayIssueAt = 0;
let lastRelayHealthyAt = Date.now();

function readPositiveInt(value: string | undefined, fallback: number, min = 1) {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.floor(parsed));
}

function rawDataToString(raw: RawData) {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw as readonly Uint8Array[]).toString("utf8");
  }
  return Buffer.from(raw).toString("utf8");
}

function toIsoTimestamp(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : undefined;
}

function getGridKey(lat: number, lon: number) {
  const gridLat = Math.floor(lat / GRID_SIZE_DEG) * GRID_SIZE_DEG;
  const gridLon = Math.floor(lon / GRID_SIZE_DEG) * GRID_SIZE_DEG;
  return `${gridLat},${gridLon}`;
}

function getOrCreateDensityCell(
  key: string,
  lat: number,
  lon: number,
  now: number,
) {
  let cell = densityGrid.get(key);
  if (!cell) {
    cell = {
      key,
      lat: Math.floor(lat / GRID_SIZE_DEG) * GRID_SIZE_DEG + GRID_SIZE_DEG / 2,
      lon: Math.floor(lon / GRID_SIZE_DEG) * GRID_SIZE_DEG + GRID_SIZE_DEG / 2,
      vesselIds: new Set<string>(),
      previousCount: 0,
      lastUpdate: now,
    };
    densityGrid.set(key, cell);
  }
  return cell;
}

function removeVesselFromDensityCell(mmsi: string) {
  const currentGridKey = vesselGridKeys.get(mmsi);
  if (!currentGridKey) {
    return;
  }
  const currentCell = densityGrid.get(currentGridKey);
  currentCell?.vesselIds.delete(mmsi);
  vesselGridKeys.delete(mmsi);
}

function setRelayHealthState(
  nextState: RelayHealthState,
  code?: AisRelayReasonCode,
  reason?: string,
) {
  const previousState = relayHealthState;
  const previousCode = relayStatusReasonCode;

  relayHealthState = nextState;
  if (nextState === "degraded") {
    relayStatusReasonCode = code;
    relayStatusReason = reason;

    if (previousState !== nextState || previousCode !== relayStatusReasonCode) {
      lastRelayIssueAt = Date.now();
      console.error(
        `[ais-relay] degraded (${relayStatusReasonCode ?? "unknown"}): ${
          relayStatusReason ?? "No reason provided"
        }`,
      );
    }
    return;
  }

  relayStatusReasonCode = undefined;
  relayStatusReason = undefined;
  if (previousState === "degraded") {
    lastRelayHealthyAt = Date.now();
    console.log("[ais-relay] relay health recovered");
  }
}

function evaluateRelayHealthState() {
  const now = Date.now();
  const readyState = upstreamSocket?.readyState;
  if (readyState !== WebSocket.OPEN) {
    if (
      readyState === WebSocket.CONNECTING &&
      messageCount === 0 &&
      lastUpstreamErrorAt === 0
    ) {
      setRelayHealthState("ok");
      return;
    }

    const upstreamReason = normalizeString(lastUpstreamErrorMessage);
    setRelayHealthState(
      "degraded",
      "ais_upstream_disconnected",
      upstreamReason
        ? `AIS relay is reachable, but the upstream AIS stream is disconnected. Last upstream error: ${upstreamReason}`
        : "AIS relay is reachable, but the upstream AIS stream is disconnected.",
    );
    return;
  }

  if (
    lastUpstreamConnectedAt > 0 &&
    (lastUpstreamMessageAt === 0 ||
      lastUpstreamMessageAt < lastUpstreamConnectedAt) &&
    now - lastUpstreamConnectedAt >= RELAY_HEALTH_NO_MESSAGES_AFTER_CONNECT_MS
  ) {
    setRelayHealthState(
      "degraded",
      "ais_upstream_no_messages_after_connect",
      `AIS relay is connected to the upstream stream, but no AIS messages have arrived within ${Math.round(
        RELAY_HEALTH_NO_MESSAGES_AFTER_CONNECT_MS / 1000,
      )}s of connection establishment.`,
    );
    return;
  }

  if (
    lastUpstreamMessageAt > 0 &&
    now - lastUpstreamMessageAt >= RELAY_HEALTH_STALE_MESSAGES_MS
  ) {
    setRelayHealthState(
      "degraded",
      "ais_upstream_stalled",
      `AIS relay has not received an upstream message for ${Math.round(
        RELAY_HEALTH_STALE_MESSAGES_MS / 1000,
      )}s while the upstream connection remains open.`,
    );
    return;
  }

  if (
    positionReportsSeen >= RELAY_HEALTH_MIN_POSITION_REPORTS &&
    positionReportsProcessed === 0 &&
    vessels.size === 0
  ) {
    setRelayHealthState(
      "degraded",
      "ais_position_reports_not_retained",
      "AIS relay is receiving position reports, but none are being retained as vessel snapshots. Check MMSI and coordinate normalization.",
    );
    return;
  }

  if (
    positionReportsSeen >= RELAY_HEALTH_MIN_POSITION_REPORTS &&
    ignoredPositionReports > 0 &&
    exceedsRatio(
      ignoredPositionReports,
      positionReportsSeen,
      RELAY_HEALTH_MAX_IGNORED_RATIO_PERCENT,
    )
  ) {
    setRelayHealthState(
      "degraded",
      "ais_position_reports_mostly_ignored",
      `AIS relay is receiving position reports, but most are being ignored during normalization (${ignoredPositionReports}/${positionReportsSeen}).`,
    );
    return;
  }

  if (
    messageCount >= RELAY_HEALTH_MIN_POSITION_REPORTS &&
    parseErrors > 0 &&
    exceedsRatio(
      parseErrors,
      messageCount,
      RELAY_HEALTH_MAX_PARSE_ERROR_RATIO_PERCENT,
    )
  ) {
    setRelayHealthState(
      "degraded",
      "ais_payload_parse_errors",
      `AIS relay is encountering frequent upstream payload parse errors (${parseErrors}/${messageCount}).`,
    );
    return;
  }

  setRelayHealthState("ok");
}

function buildRelayDiagnostics(): RelayHealthDiagnostics {
  evaluateRelayHealthState();
  const lastHealthyAtIso = toIsoTimestamp(lastRelayHealthyAt);
  const lastIssueAtIso = toIsoTimestamp(lastRelayIssueAt);
  const lastConnectedAtIso = toIsoTimestamp(lastUpstreamConnectedAt);
  const lastMessageAtIso = toIsoTimestamp(lastUpstreamMessageAt);
  const lastUpstreamErrorAtIso = toIsoTimestamp(lastUpstreamErrorAt);
  const lastParseErrorAtIso = toIsoTimestamp(lastParseErrorAt);

  return {
    healthState: relayHealthState,
    ...(relayStatusReasonCode
      ? { statusReasonCode: relayStatusReasonCode }
      : {}),
    ...(relayStatusReason ? { statusReason: relayStatusReason } : {}),
    positionReportsSeen,
    positionReportsProcessed,
    ignoredPositionReports,
    parseErrors,
    ...(lastHealthyAtIso ? { lastHealthyAt: lastHealthyAtIso } : {}),
    ...(lastIssueAtIso ? { lastIssueAt: lastIssueAtIso } : {}),
    ...(lastConnectedAtIso ? { lastConnectedAt: lastConnectedAtIso } : {}),
    ...(lastMessageAtIso ? { lastMessageAt: lastMessageAtIso } : {}),
    ...(lastUpstreamErrorAtIso
      ? { lastUpstreamErrorAt: lastUpstreamErrorAtIso }
      : {}),
    ...(lastUpstreamErrorMessage
      ? { lastUpstreamError: lastUpstreamErrorMessage }
      : {}),
    ...(lastParseErrorAtIso ? { lastParseErrorAt: lastParseErrorAtIso } : {}),
    ...(lastParseErrorMessage ? { lastParseError: lastParseErrorMessage } : {}),
  };
}

function exceedsRatio(numerator: number, denominator: number, percent: number) {
  if (denominator <= 0) {
    return false;
  }
  return (numerator / denominator) * 100 >= percent;
}

function evictMapByTimestamp<T>(
  map: Map<string, T>,
  maxSize: number,
  getTimestamp: (value: T) => number,
) {
  if (map.size <= maxSize) {
    return;
  }
  const oldestEntries = [...map.entries()]
    .sort((left, right) => getTimestamp(left[1]) - getTimestamp(right[1]))
    .slice(0, map.size - maxSize);
  for (const [key] of oldestEntries) {
    map.delete(key);
  }
}

function enqueueUpstreamMessage(raw: RawData) {
  upstreamQueue.push(raw);
}

function getUpstreamQueueSize() {
  return upstreamQueue.length - upstreamQueueReadIndex;
}

function dequeueUpstreamMessage() {
  if (upstreamQueueReadIndex >= upstreamQueue.length) {
    return undefined;
  }
  const value = upstreamQueue[upstreamQueueReadIndex++];
  if (
    upstreamQueueReadIndex >= 1_024 &&
    upstreamQueueReadIndex * 2 >= upstreamQueue.length
  ) {
    upstreamQueue = upstreamQueue.slice(upstreamQueueReadIndex);
    upstreamQueueReadIndex = 0;
  }
  return value;
}

function clearUpstreamQueue() {
  upstreamQueue = [];
  upstreamQueueReadIndex = 0;
  drainScheduled = false;
}

function scheduleDrain() {
  if (drainScheduled) {
    return;
  }
  drainScheduled = true;
  setImmediate(drainUpstreamQueue);
}

function drainUpstreamQueue() {
  drainScheduled = false;
  const startedAt = Date.now();
  let processed = 0;

  while (
    processed < UPSTREAM_DRAIN_BATCH &&
    getUpstreamQueueSize() > 0 &&
    Date.now() - startedAt < UPSTREAM_DRAIN_BUDGET_MS
  ) {
    const raw = dequeueUpstreamMessage();
    if (raw === undefined) {
      break;
    }
    processRawUpstreamMessage(raw);
    processed += 1;
  }

  if (getUpstreamQueueSize() > 0) {
    scheduleDrain();
  }
}

function processRawUpstreamMessage(raw: RawData) {
  lastUpstreamMessageAt = Date.now();
  messageCount += 1;
  try {
    const parsed = JSON.parse(rawDataToString(raw)) as {
      MessageType?: unknown;
      MetaData?: unknown;
      Message?: unknown;
    };
    if (parsed.MessageType === "PositionReport") {
      positionReportsSeen += 1;
      processPositionReportForSnapshot(parsed);
    }
  } catch (error) {
    parseErrors += 1;
    lastParseErrorAt = Date.now();
    lastParseErrorMessage =
      error instanceof Error
        ? error.message
        : "Failed to parse upstream payload.";
  }
}

function processPositionReportForSnapshot(payload: {
  MetaData?: unknown;
  Message?: unknown;
}) {
  const meta =
    payload.MetaData &&
    typeof payload.MetaData === "object" &&
    !Array.isArray(payload.MetaData)
      ? (payload.MetaData as Record<string, unknown>)
      : undefined;
  const message =
    payload.Message &&
    typeof payload.Message === "object" &&
    !Array.isArray(payload.Message)
      ? (payload.Message as Record<string, unknown>)
      : undefined;
  const position =
    message?.PositionReport &&
    typeof message.PositionReport === "object" &&
    !Array.isArray(message.PositionReport)
      ? (message.PositionReport as Record<string, unknown>)
      : undefined;

  if (!meta || !position) {
    ignoredPositionReports += 1;
    return;
  }

  const mmsi = normalizeMmsi(meta.MMSI ?? meta.MMSI_String);
  const lat = getNumber(position.Latitude) ?? getNumber(meta.latitude);
  const lon = getNumber(position.Longitude) ?? getNumber(meta.longitude);
  if (!mmsi || lat === undefined || lon === undefined) {
    ignoredPositionReports += 1;
    return;
  }

  const now = Date.now();
  const gridKey = getGridKey(lat, lon);
  const previousGridKey = vesselGridKeys.get(mmsi);
  if (previousGridKey && previousGridKey !== gridKey) {
    removeVesselFromDensityCell(mmsi);
  }

  vessels.set(mmsi, {
    mmsi,
    name: normalizeString(meta.ShipName),
    lat,
    lon,
    timestamp: now,
    shipType: getNumber(meta.ShipType),
    heading: getNumber(position.TrueHeading),
    speed: getNumber(position.Sog),
    course: getNumber(position.Cog),
  });

  const history = vesselHistory.get(mmsi) ?? [];
  history.push(now);
  if (history.length > 10) {
    history.shift();
  }
  vesselHistory.set(mmsi, history);

  const cell = getOrCreateDensityCell(gridKey, lat, lon, now);
  cell.vesselIds.add(mmsi);
  cell.lastUpdate = now;
  vesselGridKeys.set(mmsi, gridKey);

  if (isLikelyMilitaryCandidate(meta)) {
    candidateReports.set(mmsi, {
      mmsi,
      name: normalizeString(meta.ShipName),
      lat,
      lon,
      shipType: getNumber(meta.ShipType),
      heading: getNumber(position.TrueHeading),
      speed: getNumber(position.Sog),
      course: getNumber(position.Cog),
      timestamp: now,
    });
  }

  positionReportsProcessed += 1;
}

function cleanupAggregates() {
  const now = Date.now();
  const cutoff = now - DENSITY_WINDOW_MS;

  for (const [mmsi, vessel] of vessels) {
    if (vessel.timestamp >= cutoff) {
      continue;
    }
    vessels.delete(mmsi);
    removeVesselFromDensityCell(mmsi);
  }

  if (vessels.size > MAX_VESSELS) {
    const oldest = [...vessels.entries()]
      .sort((left, right) => left[1].timestamp - right[1].timestamp)
      .slice(0, vessels.size - MAX_VESSELS);
    for (const [mmsi] of oldest) {
      vessels.delete(mmsi);
      removeVesselFromDensityCell(mmsi);
    }
  }

  for (const [mmsi, history] of vesselHistory) {
    const filtered = history.filter((timestamp) => timestamp >= cutoff);
    if (filtered.length === 0) {
      vesselHistory.delete(mmsi);
      continue;
    }
    vesselHistory.set(mmsi, filtered);
  }
  evictMapByTimestamp(
    vesselHistory,
    MAX_VESSEL_HISTORY,
    (history) => history[history.length - 1] ?? 0,
  );

  for (const [key, cell] of densityGrid) {
    for (const mmsi of [...cell.vesselIds]) {
      const vessel = vessels.get(mmsi);
      if (!vessel) {
        cell.vesselIds.delete(mmsi);
        continue;
      }
      const vesselGridKey = vesselGridKeys.get(mmsi);
      if (vesselGridKey !== key) {
        cell.vesselIds.delete(mmsi);
      }
    }
    if (
      cell.vesselIds.size === 0 &&
      now - cell.lastUpdate > DENSITY_WINDOW_MS * 2
    ) {
      densityGrid.delete(key);
    }
  }
  evictMapByTimestamp(
    densityGrid,
    MAX_DENSITY_CELLS,
    (cell) => cell.lastUpdate,
  );

  for (const [mmsi, candidate] of candidateReports) {
    if (candidate.timestamp >= now - CANDIDATE_RETENTION_MS) {
      continue;
    }
    candidateReports.delete(mmsi);
  }
  evictMapByTimestamp(
    candidateReports,
    MAX_CANDIDATE_REPORTS,
    (candidate) => candidate.timestamp,
  );
}

function detectDisruptions() {
  const disruptions: Array<Record<string, unknown>> = [];
  const now = Date.now();
  const vesselList = [...vessels.values()];

  for (const chokepoint of CHOKEPOINTS) {
    const vesselCount = vesselList.filter((vessel) => {
      const dLat = vessel.lat - chokepoint.lat;
      const dLon = vessel.lon - chokepoint.lon;
      return dLat * dLat + dLon * dLon <= chokepoint.radius * chokepoint.radius;
    }).length;

    if (vesselCount < 5) {
      continue;
    }

    const normalTraffic = chokepoint.radius * 10;
    const severity =
      vesselCount > normalTraffic * 1.5
        ? "high"
        : vesselCount > normalTraffic
          ? "elevated"
          : "low";

    disruptions.push({
      id: `chokepoint-${chokepoint.name.toLowerCase().replace(/\s+/g, "-")}`,
      name: chokepoint.name,
      type: "chokepoint_congestion",
      lat: chokepoint.lat,
      lon: chokepoint.lon,
      severity,
      changePct:
        normalTraffic > 0
          ? Math.round((vesselCount / normalTraffic - 1) * 100)
          : 0,
      windowHours: 1,
      vesselCount,
      region: chokepoint.name,
      description: `${vesselCount} vessels in ${chokepoint.name}`,
    });
  }

  let darkShipCount = 0;
  for (const history of vesselHistory.values()) {
    if (history.length < 2) {
      continue;
    }
    const lastSeen = history[history.length - 1];
    const previousSeen = history[history.length - 2];
    if (
      lastSeen !== undefined &&
      previousSeen !== undefined &&
      lastSeen - previousSeen > GAP_THRESHOLD_MS &&
      now - lastSeen < DARK_SHIP_FRESHNESS_MS
    ) {
      darkShipCount += 1;
    }
  }

  if (darkShipCount > 0) {
    disruptions.push({
      id: "global-gap-spike",
      name: "AIS Gap Spike Detected",
      type: "gap_spike",
      lat: 0,
      lon: 0,
      severity:
        darkShipCount > 20 ? "high" : darkShipCount > 10 ? "elevated" : "low",
      changePct: darkShipCount * 10,
      windowHours: 1,
      darkShips: darkShipCount,
      description: `${darkShipCount} vessels returned after extended AIS silence`,
    });
  }

  return disruptions;
}

function calculateDensityZones() {
  const eligibleCells = [...densityGrid.values()].filter(
    (cell) => cell.vesselIds.size >= 2,
  );
  if (eligibleCells.length === 0) {
    return [];
  }

  const vesselCounts = eligibleCells.map((cell) => cell.vesselIds.size);
  const maxVessels = Math.max(...vesselCounts);
  const minVessels = Math.min(...vesselCounts);
  const logMax = Math.log(maxVessels + 1);
  const logMin = Math.log(minVessels + 1);

  return eligibleCells
    .map((cell) => {
      const currentCount = cell.vesselIds.size;
      const logCurrent = Math.log(currentCount + 1);
      const intensity =
        logMax > logMin
          ? 0.2 + (0.8 * (logCurrent - logMin)) / (logMax - logMin)
          : 0.5;
      const deltaPct =
        cell.previousCount > 0
          ? Math.round(
              ((currentCount - cell.previousCount) / cell.previousCount) * 100,
            )
          : 0;

      return {
        id: `density-${cell.key}`,
        name: `Zone ${cell.key}`,
        lat: cell.lat,
        lon: cell.lon,
        intensity,
        deltaPct,
        shipsPerDay: currentCount * 48,
        note: currentCount >= 10 ? "High traffic area" : undefined,
      };
    })
    .sort((left, right) => right.intensity - left.intensity)
    .slice(0, MAX_DENSITY_ZONES);
}

function getCandidateReportsSnapshot() {
  return [...candidateReports.values()]
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, MAX_CANDIDATE_REPORTS);
}

function getVesselsSnapshot() {
  return [...vessels.values()]
    .sort((left, right) => right.timestamp - left.timestamp)
    .map((vessel) => ({
      mmsi: vessel.mmsi,
      ...(vessel.name ? { name: vessel.name } : {}),
      lat: vessel.lat,
      lon: vessel.lon,
      ...(typeof vessel.shipType === "number"
        ? { shipType: vessel.shipType }
        : {}),
      ...(typeof vessel.heading === "number"
        ? { heading: vessel.heading }
        : {}),
      ...(typeof vessel.speed === "number" ? { speed: vessel.speed } : {}),
      ...(typeof vessel.course === "number" ? { course: vessel.course } : {}),
      timestamp: vessel.timestamp,
    }))
    .slice(0, MAX_VESSELS);
}

function refreshDensityBaselines() {
  for (const cell of densityGrid.values()) {
    cell.previousCount = cell.vesselIds.size;
  }
}

function buildSnapshot() {
  const now = Date.now();
  if (
    lastSnapshot &&
    now - lastSnapshotAt < Math.floor(SNAPSHOT_CACHE_TTL_MS / 2)
  ) {
    return lastSnapshot;
  }

  cleanupAggregates();
  snapshotSequence += 1;
  const candidateSnapshot = getCandidateReportsSnapshot();
  const vesselsSnapshot = getVesselsSnapshot();
  lastSnapshot = {
    sequence: snapshotSequence,
    timestamp: new Date(now).toISOString(),
    status: {
      connected: upstreamSocket?.readyState === WebSocket.OPEN,
      vessels: vessels.size,
      messages: messageCount,
      clients: 0,
      droppedMessages,
    },
    diagnostics: buildRelayDiagnostics(),
    disruptions: detectDisruptions(),
    density: calculateDensityZones(),
    candidateReports: candidateSnapshot,
    vessels: vesselsSnapshot,
  };
  lastSnapshotAt = now;
  lastSnapshotJsonWithoutCandidates = JSON.stringify({
    ...lastSnapshot,
    candidateReports: [],
  });
  lastSnapshotJsonWithCandidates = JSON.stringify(lastSnapshot);
  refreshDensityBaselines();
  return lastSnapshot;
}

function getBearerToken(req: IncomingMessage) {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") {
    return "";
  }
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return "";
  }
  return authorization.slice(7).trim();
}

function tokenEquals(provided: string, expected: string) {
  const left = new Uint8Array(Buffer.from(provided));
  const right = new Uint8Array(Buffer.from(expected));
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function isAuthorizedRequest(req: IncomingMessage) {
  if (!AIS_SHARED_SECRET) {
    return true;
  }
  const token = getBearerToken(req);
  return token !== "" && tokenEquals(token, AIS_SHARED_SECRET);
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(body);
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectUpstream();
  }, RECONNECT_DELAY_MS);
  reconnectTimer.unref?.();
}

function connectUpstream() {
  if (
    upstreamSocket?.readyState === WebSocket.OPEN ||
    upstreamSocket?.readyState === WebSocket.CONNECTING
  ) {
    return;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  console.log(`[ais-relay] connecting to ${AISSTREAM_URL}`);
  const socket = new WebSocket(AISSTREAM_URL);
  upstreamSocket = socket;
  clearUpstreamQueue();

  socket.on("open", () => {
    if (upstreamSocket !== socket) {
      socket.close();
      return;
    }
    lastUpstreamConnectedAt = Date.now();
    console.log("[ais-relay] upstream connected");
    socket.send(
      JSON.stringify({
        APIKey: AISSTREAM_API_KEY,
        BoundingBoxes: [
          [
            [-90, -180],
            [90, 180],
          ],
        ],
        FilterMessageTypes: ["PositionReport"],
      }),
    );
  });

  socket.on("message", (raw: RawData) => {
    if (upstreamSocket !== socket) {
      return;
    }
    if (getUpstreamQueueSize() >= UPSTREAM_QUEUE_HARD_CAP) {
      droppedMessages += 1;
      return;
    }
    enqueueUpstreamMessage(raw);
    scheduleDrain();
  });

  socket.on("close", (code: number, reasonBuffer: Buffer) => {
    if (upstreamSocket !== socket) {
      return;
    }
    upstreamSocket = null;
    clearUpstreamQueue();
    lastUpstreamErrorAt = Date.now();
    const reason = normalizeString(reasonBuffer.toString("utf8"));
    lastUpstreamErrorMessage = reason
      ? `close ${code}: ${reason}`
      : `close ${code}`;
    console.warn(
      `[ais-relay] upstream disconnected (code=${code}${
        reason ? `, reason=${reason}` : ""
      }); reconnecting in 5s`,
    );
    scheduleReconnect();
  });

  socket.on("error", (error: Error) => {
    lastUpstreamErrorAt = Date.now();
    lastUpstreamErrorMessage = error.message;
    console.error("[ais-relay] upstream error:", error.message);
  });
}

const server = createServer((req, res) => {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? `${HOST}:${PORT}`}`,
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    });
    res.end();
    return;
  }

  if (req.method !== "GET") {
    writeJson(
      res,
      405,
      { error: "Method Not Allowed" },
      { Allow: "GET, OPTIONS" },
    );
    return;
  }

  if (url.pathname === "/" || url.pathname === "/health") {
    const diagnostics = buildRelayDiagnostics();
    writeJson(
      res,
      200,
      buildRelayHealthPayload({
        connected: upstreamSocket?.readyState === WebSocket.OPEN,
        vessels: vessels.size,
        messages: messageCount,
        droppedMessages,
        densityZones: [...densityGrid.values()].filter(
          (cell) => cell.vesselIds.size >= 2,
        ).length,
        sharedSecretEnabled: AIS_SHARED_SECRET.length > 0,
        diagnostics,
      }),
    );
    return;
  }

  if (url.pathname === "/healthz/live") {
    writeJson(res, 200, buildRelayLivenessPayload());
    return;
  }

  if (url.pathname === "/ais/snapshot") {
    if (!isAuthorizedRequest(req)) {
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }

    connectUpstream();
    const snapshot = buildSnapshot();
    const includeCandidates = url.searchParams.get("candidates") === "true";
    const body = includeCandidates
      ? lastSnapshotJsonWithCandidates
      : lastSnapshotJsonWithoutCandidates;

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=2",
    });
    res.end(
      body ??
        JSON.stringify({
          ...snapshot,
          candidateReports: includeCandidates ? snapshot.candidateReports : [],
        }),
    );
    return;
  }

  writeJson(res, 404, { error: "Not Found" });
});

setInterval(() => {
  if (upstreamSocket?.readyState === WebSocket.OPEN || vessels.size > 0) {
    buildSnapshot();
  }
}, SNAPSHOT_CACHE_TTL_MS).unref?.();

function gracefulShutdown(signal: string) {
  console.log(`[ais-relay] ${signal} received; shutting down`);
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (upstreamSocket) {
    try {
      closeUpstreamSocketForShutdown(upstreamSocket);
    } catch {
      // Ignore close failures during shutdown.
    }
    upstreamSocket = null;
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref?.();
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

server.listen(PORT, HOST, () => {
  console.log(`[ais-relay] listening on http://${HOST}:${PORT}`);
  connectUpstream();
});
