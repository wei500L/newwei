import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { WebSocket, type RawData } from "ws";

const AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream";
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

const NAVAL_PREFIX_RE =
  /^(USS|USNS|HMS|HMAS|HMCS|INS|JS|ROKS|TCG|FS|BNS|RFS|PLAN|PLA|CGC|PNS|KRI|ITS|SNS|MMSI)/i;

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
let snapshotSequence = 0;
let lastSnapshot: AisSnapshot | null = null;
let lastSnapshotAt = 0;
let lastSnapshotJsonWithoutCandidates: string | null = null;
let lastSnapshotJsonWithCandidates: string | null = null;

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

function normalizeString(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" &&
        value.trim() !== "" &&
        Number.isFinite(Number(value))
      ? Number(value)
      : undefined;
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

function isLikelyMilitaryCandidate(meta: Record<string, unknown>) {
  const mmsi = String(meta.MMSI ?? "");
  const shipType = getNumber(meta.ShipType);
  const name = normalizeString(meta.ShipName)?.toUpperCase();

  if (
    typeof shipType === "number" &&
    (shipType === 35 || shipType === 55 || (shipType >= 50 && shipType <= 59))
  ) {
    return true;
  }

  if (name && NAVAL_PREFIX_RE.test(name)) {
    return true;
  }

  if (mmsi.length >= 9) {
    const suffix = mmsi.slice(3);
    if (suffix.startsWith("00") || suffix.startsWith("99")) {
      return true;
    }
  }

  return false;
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
  messageCount += 1;
  try {
    const parsed = JSON.parse(rawDataToString(raw)) as {
      MessageType?: unknown;
      MetaData?: unknown;
      Message?: unknown;
    };
    if (parsed.MessageType === "PositionReport") {
      processPositionReportForSnapshot(parsed);
    }
  } catch {
    // Ignore malformed payloads from upstream.
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
    return;
  }

  const mmsi = normalizeString(meta.MMSI);
  const lat = getNumber(position.Latitude) ?? getNumber(meta.latitude);
  const lon = getNumber(position.Longitude) ?? getNumber(meta.longitude);
  if (!mmsi || lat === undefined || lon === undefined) {
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
      ...(typeof vessel.shipType === "number" ? { shipType: vessel.shipType } : {}),
      ...(typeof vessel.heading === "number" ? { heading: vessel.heading } : {}),
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

  console.log("[ais-relay] connecting to aisstream.io");
  const socket = new WebSocket(AISSTREAM_URL);
  upstreamSocket = socket;
  clearUpstreamQueue();

  socket.on("open", () => {
    if (upstreamSocket !== socket) {
      socket.close();
      return;
    }
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

  socket.on("close", () => {
    if (upstreamSocket !== socket) {
      return;
    }
    upstreamSocket = null;
    clearUpstreamQueue();
    console.warn("[ais-relay] upstream disconnected; reconnecting in 5s");
    scheduleReconnect();
  });

  socket.on("error", (error: Error) => {
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
    writeJson(res, 200, {
      status: "ok",
      connected: upstreamSocket?.readyState === WebSocket.OPEN,
      vessels: vessels.size,
      messages: messageCount,
      droppedMessages,
      densityZones: [...densityGrid.values()].filter(
        (cell) => cell.vesselIds.size >= 2,
      ).length,
      sharedSecretEnabled: AIS_SHARED_SECRET.length > 0,
    });
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
    upstreamSocket.removeAllListeners();
    try {
      upstreamSocket.close();
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
