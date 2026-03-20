const MILITARY_CALLSIGN_PATTERNS = [
  /^(RCH|RRR|CNV|QID|GAF|BAF|NVY|NAF|VM)[A-Z0-9]{1,6}$/i,
  /^ASCOT[A-Z0-9]{1,6}$/i,
] as const;

const AIRCRAFT_TRANSPORT_PREFIXES = [
  "RCH",
  "RRR",
  "CNV",
  "CMB",
  "ASCOT",
] as const;
const AIRCRAFT_REFUEL_PREFIXES = ["QID", "SHELL", "MPRS", "TKR"] as const;
const AIRCRAFT_SURVEILLANCE_PREFIXES = [
  "FORTE",
  "NATO",
  "MAGMA",
  "DRAGNET",
  "AEW",
] as const;

export interface AircraftTransportClassification {
  displayCategory: string;
  displayCategoryZh: string;
  role: string;
  roleZh: string;
  isMilitaryCandidate: boolean;
}

export interface AisShipTypeClassification {
  shipTypeLabel: string;
  shipTypeLabelZh: string;
  vesselRole: string;
  vesselRoleZh: string;
  isMilitaryCandidate: boolean;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractAircraftPrefix(callsign: string | undefined): string | null {
  const normalized = normalizeString(callsign)
    ?.toUpperCase()
    .replace(/\s+/g, "");
  if (!normalized) {
    return null;
  }
  const match = normalized.match(/^[A-Z]+/);
  return match?.[0] ?? null;
}

export function isMilitaryLikeAircraft(input: {
  callsign?: string;
  icao24?: string;
  sourceScope?: "military" | "all";
}): boolean {
  if (input.sourceScope === "military") {
    return true;
  }

  const callsign = normalizeString(input.callsign)?.toUpperCase();
  if (
    callsign &&
    MILITARY_CALLSIGN_PATTERNS.some((pattern) => pattern.test(callsign))
  ) {
    return true;
  }

  const icao24 = normalizeString(input.icao24)?.toLowerCase();
  return Boolean(icao24 && icao24.startsWith("ae"));
}

export function classifyAircraftTransport(input: {
  callsign?: string;
  icao24?: string;
  sourceScope?: "military" | "all";
}): AircraftTransportClassification {
  const isMilitaryCandidate = isMilitaryLikeAircraft(input);
  if (!isMilitaryCandidate) {
    return {
      displayCategory: "Civil flight",
      displayCategoryZh: "民航飞行",
      role: "Civil or general aviation",
      roleZh: "民航或通用航空",
      isMilitaryCandidate: false,
    };
  }

  const prefix = extractAircraftPrefix(input.callsign);
  if (prefix && AIRCRAFT_TRANSPORT_PREFIXES.includes(prefix as never)) {
    return {
      displayCategory: "Military flight",
      displayCategoryZh: "军事飞行",
      role: "Military transport",
      roleZh: "军用运输",
      isMilitaryCandidate: true,
    };
  }
  if (prefix && AIRCRAFT_REFUEL_PREFIXES.includes(prefix as never)) {
    return {
      displayCategory: "Military flight",
      displayCategoryZh: "军事飞行",
      role: "Aerial refueling",
      roleZh: "空中加油",
      isMilitaryCandidate: true,
    };
  }
  if (prefix && AIRCRAFT_SURVEILLANCE_PREFIXES.includes(prefix as never)) {
    return {
      displayCategory: "Military flight",
      displayCategoryZh: "军事飞行",
      role: "ISR / surveillance",
      roleZh: "侦察监视",
      isMilitaryCandidate: true,
    };
  }
  return {
    displayCategory: "Military flight",
    displayCategoryZh: "军事飞行",
    role: "Tactical aircraft",
    roleZh: "战术航空器",
    isMilitaryCandidate: true,
  };
}

export function classifyAisShipType(
  shipType: number | undefined,
  isMilitaryCandidate = false,
): AisShipTypeClassification {
  if (typeof shipType !== "number" || !Number.isFinite(shipType)) {
    return {
      shipTypeLabel: "Other",
      shipTypeLabelZh: "其他船舶",
      vesselRole: isMilitaryCandidate ? "Military / government" : "Other",
      vesselRoleZh: isMilitaryCandidate ? "军政船舶" : "其他船舶",
      isMilitaryCandidate,
    };
  }

  const normalized = Math.trunc(shipType);
  if (
    isMilitaryCandidate ||
    normalized === 35 ||
    normalized === 55 ||
    (normalized >= 50 && normalized <= 59)
  ) {
    return {
      shipTypeLabel: "Military / government",
      shipTypeLabelZh: "军政船舶",
      vesselRole: "Military / government",
      vesselRoleZh: "军政船舶",
      isMilitaryCandidate: true,
    };
  }
  if (normalized >= 30 && normalized <= 39) {
    return {
      shipTypeLabel: "Fishing",
      shipTypeLabelZh: "渔船",
      vesselRole: "Fishing",
      vesselRoleZh: "渔业作业",
      isMilitaryCandidate: false,
    };
  }
  if (normalized >= 40 && normalized <= 49) {
    return {
      shipTypeLabel: "High-speed craft",
      shipTypeLabelZh: "高速船",
      vesselRole: "High-speed craft",
      vesselRoleZh: "高速航行",
      isMilitaryCandidate: false,
    };
  }
  if (normalized >= 60 && normalized <= 69) {
    return {
      shipTypeLabel: "Passenger",
      shipTypeLabelZh: "客船",
      vesselRole: "Passenger transport",
      vesselRoleZh: "客运",
      isMilitaryCandidate: false,
    };
  }
  if (normalized >= 70 && normalized <= 79) {
    return {
      shipTypeLabel: "Cargo",
      shipTypeLabelZh: "货船",
      vesselRole: "Cargo transport",
      vesselRoleZh: "货运",
      isMilitaryCandidate: false,
    };
  }
  if (normalized >= 80 && normalized <= 89) {
    return {
      shipTypeLabel: "Tanker",
      shipTypeLabelZh: "油轮",
      vesselRole: "Liquid bulk transport",
      vesselRoleZh: "液货运输",
      isMilitaryCandidate: false,
    };
  }
  return {
    shipTypeLabel: "Other",
    shipTypeLabelZh: "其他船舶",
    vesselRole: "Other",
    vesselRoleZh: "其他船舶",
    isMilitaryCandidate: false,
  };
}
