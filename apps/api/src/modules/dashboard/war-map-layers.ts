export type WarMapThreatLevel = "critical" | "high" | "elevated" | "low";

export interface WarMapHotspot {
  id: string;
  name: string;
  lat: number;
  lng: number;
  level: WarMapThreatLevel;
  description: string;
}

export interface WarMapConflictZone {
  id: string;
  name: string;
  coords: Array<[number, number]>;
  color: string;
}

export interface WarMapStrategicPoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  description: string;
}

export interface WarMapLayersResponse {
  updatedAt: string;
  threatColors: Record<WarMapThreatLevel, string>;
  hotspots: WarMapHotspot[];
  conflictZones: WarMapConflictZone[];
  chokepoints: WarMapStrategicPoint[];
  cableLandings: WarMapStrategicPoint[];
  nuclearSites: WarMapStrategicPoint[];
  militaryBases: WarMapStrategicPoint[];
}

export const WAR_MAP_THREAT_COLORS: Record<WarMapThreatLevel, string> = {
  critical: "#ff0000",
  high: "#ff4444",
  elevated: "#ffcc00",
  low: "#00ff88"
} as const;

const UPDATED_AT = new Date().toISOString();

export const WAR_MAP_HOTSPOTS: WarMapHotspot[] = [
  {
    id: "dc",
    name: "DC",
    lat: 38.9,
    lng: -77.0,
    level: "low",
    description: "Washington DC — US political center, White House, Pentagon, Capitol"
  },
  {
    id: "moscow",
    name: "Moscow",
    lat: 55.75,
    lng: 37.6,
    level: "elevated",
    description: "Moscow — Kremlin, Russian military command, sanctions hub"
  },
  {
    id: "beijing",
    name: "Beijing",
    lat: 39.9,
    lng: 116.4,
    level: "elevated",
    description: "Beijing — CCP headquarters, US-China tensions, tech rivalry"
  },
  {
    id: "kyiv",
    name: "Kyiv",
    lat: 50.45,
    lng: 30.5,
    level: "high",
    description: "Kyiv — Active conflict zone, Russian invasion ongoing"
  },
  {
    id: "taipei",
    name: "Taipei",
    lat: 25.03,
    lng: 121.5,
    level: "elevated",
    description: "Taipei — Taiwan Strait tensions, TSMC, China threat"
  },
  {
    id: "tehran",
    name: "Tehran",
    lat: 35.7,
    lng: 51.4,
    level: "critical",
    description:
      "Tehran — Regime instability, regional escalation risk, nuclear program uncertainty"
  },
  {
    id: "tel-aviv",
    name: "Tel Aviv",
    lat: 32.07,
    lng: 34.78,
    level: "high",
    description: "Tel Aviv — Israel-Gaza conflict, active military operations"
  },
  {
    id: "london",
    name: "London",
    lat: 51.5,
    lng: -0.12,
    level: "low",
    description: "London — Financial center, Five Eyes, NATO ally"
  },
  {
    id: "brussels",
    name: "Brussels",
    lat: 50.85,
    lng: 4.35,
    level: "low",
    description: "Brussels — EU/NATO headquarters, European policy"
  },
  {
    id: "pyongyang",
    name: "Pyongyang",
    lat: 39.03,
    lng: 125.75,
    level: "elevated",
    description: "Pyongyang — North Korea nuclear threat, missile tests"
  },
  {
    id: "riyadh",
    name: "Riyadh",
    lat: 24.7,
    lng: 46.7,
    level: "elevated",
    description: "Riyadh — Saudi oil, OPEC+, Yemen conflict, regional power"
  },
  {
    id: "delhi",
    name: "Delhi",
    lat: 28.6,
    lng: 77.2,
    level: "low",
    description: "Delhi — India rising power, China border tensions"
  },
  {
    id: "singapore",
    name: "Singapore",
    lat: 1.35,
    lng: 103.82,
    level: "low",
    description: "Singapore — Shipping chokepoint, Asian finance hub"
  },
  {
    id: "tokyo",
    name: "Tokyo",
    lat: 35.68,
    lng: 139.76,
    level: "low",
    description: "Tokyo — US ally, regional security, economic power"
  },
  {
    id: "caracas",
    name: "Caracas",
    lat: 10.5,
    lng: -66.9,
    level: "high",
    description: "Caracas — Venezuela crisis, sanctions, humanitarian emergency"
  },
  {
    id: "nuuk",
    name: "Nuuk",
    lat: 64.18,
    lng: -51.72,
    level: "elevated",
    description: "Nuuk — Greenland, Arctic strategy, Denmark tensions"
  }
];

export const WAR_MAP_CONFLICT_ZONES: WarMapConflictZone[] = [
  {
    id: "ukraine",
    name: "Ukraine",
    coords: [
      [30, 52],
      [40, 52],
      [40, 45],
      [30, 45],
      [30, 52]
    ],
    color: "#ff4444"
  },
  {
    id: "gaza",
    name: "Gaza",
    coords: [
      [34, 32],
      [35, 32],
      [35, 31],
      [34, 31],
      [34, 32]
    ],
    color: "#ff4444"
  },
  {
    id: "taiwan-strait",
    name: "Taiwan Strait",
    coords: [
      [117, 28],
      [122, 28],
      [122, 22],
      [117, 22],
      [117, 28]
    ],
    color: "#ffaa00"
  },
  {
    id: "yemen",
    name: "Yemen",
    coords: [
      [42, 19],
      [54, 19],
      [54, 12],
      [42, 12],
      [42, 19]
    ],
    color: "#ff6644"
  },
  {
    id: "sudan",
    name: "Sudan",
    coords: [
      [22, 23],
      [38, 23],
      [38, 8],
      [22, 8],
      [22, 23]
    ],
    color: "#ff6644"
  },
  {
    id: "myanmar",
    name: "Myanmar",
    coords: [
      [92, 28],
      [101, 28],
      [101, 10],
      [92, 10],
      [92, 28]
    ],
    color: "#ff8844"
  }
];

export const WAR_MAP_CHOKEPOINTS: WarMapStrategicPoint[] = [
  {
    id: "suez",
    name: "Suez",
    lat: 30.0,
    lng: 32.5,
    description: "Suez Canal — 12% of global trade, Europe-Asia route"
  },
  {
    id: "panama",
    name: "Panama",
    lat: 9.1,
    lng: -79.7,
    description: "Panama Canal — Americas transit, Pacific-Atlantic link"
  },
  {
    id: "hormuz",
    name: "Hormuz",
    lat: 26.5,
    lng: 56.5,
    description: "Strait of Hormuz — 21% of global oil, Persian Gulf exit"
  },
  {
    id: "malacca",
    name: "Malacca",
    lat: 2.5,
    lng: 101.0,
    description: "Strait of Malacca — 25% of global trade, China supply line"
  },
  {
    id: "bab-el-mandeb",
    name: "Bab el-M",
    lat: 12.5,
    lng: 43.3,
    description: "Bab el-Mandeb — Red Sea gateway, Houthi threat zone"
  },
  {
    id: "gibraltar",
    name: "Gibraltar",
    lat: 36.0,
    lng: -5.5,
    description: "Strait of Gibraltar — Mediterranean access"
  },
  {
    id: "bosporus",
    name: "Bosporus",
    lat: 41.1,
    lng: 29.0,
    description: "Bosporus Strait — Black Sea access, Russia exports"
  }
];

export const WAR_MAP_CABLE_LANDINGS: WarMapStrategicPoint[] = [
  {
    id: "nyc",
    name: "NYC",
    lat: 40.7,
    lng: -74.0,
    description: "New York — Transatlantic hub, 10+ cables"
  },
  {
    id: "cornwall",
    name: "Cornwall",
    lat: 50.1,
    lng: -5.5,
    description: "Cornwall UK — Europe-Americas gateway"
  },
  {
    id: "marseille",
    name: "Marseille",
    lat: 43.3,
    lng: 5.4,
    description: "Marseille — Mediterranean hub, SEA-ME-WE"
  },
  {
    id: "mumbai",
    name: "Mumbai",
    lat: 19.1,
    lng: 72.9,
    description: "Mumbai — India gateway, 10+ cables"
  },
  {
    id: "singapore-cable",
    name: "Singapore",
    lat: 1.3,
    lng: 103.8,
    description: "Singapore — Asia-Pacific nexus"
  },
  {
    id: "hong-kong",
    name: "Hong Kong",
    lat: 22.3,
    lng: 114.2,
    description: "Hong Kong — China connectivity hub"
  },
  {
    id: "tokyo-cable",
    name: "Tokyo",
    lat: 35.5,
    lng: 139.8,
    description: "Tokyo — Trans-Pacific terminus"
  },
  {
    id: "sydney",
    name: "Sydney",
    lat: -33.9,
    lng: 151.2,
    description: "Sydney — Australia/Pacific hub"
  },
  {
    id: "la",
    name: "LA",
    lat: 33.7,
    lng: -118.2,
    description: "Los Angeles — Pacific gateway"
  },
  {
    id: "miami",
    name: "Miami",
    lat: 25.8,
    lng: -80.2,
    description: "Miami — Americas/Caribbean hub"
  }
];

export const WAR_MAP_NUCLEAR_SITES: WarMapStrategicPoint[] = [
  { id: "natanz", name: "Natanz", lat: 33.7, lng: 51.7, description: "Natanz — Iran uranium enrichment" },
  {
    id: "yongbyon",
    name: "Yongbyon",
    lat: 39.8,
    lng: 125.8,
    description: "Yongbyon — North Korea nuclear complex"
  },
  { id: "dimona", name: "Dimona", lat: 31.0, lng: 35.1, description: "Dimona — Israel nuclear facility" },
  {
    id: "bushehr",
    name: "Bushehr",
    lat: 28.8,
    lng: 50.9,
    description: "Bushehr — Iran nuclear power plant"
  },
  {
    id: "zaporizhzhia",
    name: "Zaporizhzhia",
    lat: 47.5,
    lng: 34.6,
    description: "Zaporizhzhia — Europe largest NPP, conflict zone"
  },
  {
    id: "chernobyl",
    name: "Chernobyl",
    lat: 51.4,
    lng: 30.1,
    description: "Chernobyl — Exclusion zone, occupied 2022"
  },
  {
    id: "fukushima",
    name: "Fukushima",
    lat: 37.4,
    lng: 141.0,
    description: "Fukushima — Decommissioning site"
  }
];

export const WAR_MAP_MILITARY_BASES: WarMapStrategicPoint[] = [
  {
    id: "ramstein",
    name: "Ramstein",
    lat: 49.4,
    lng: 7.6,
    description: "Ramstein — US Air Force, NATO hub Germany"
  },
  {
    id: "diego-garcia",
    name: "Diego Garcia",
    lat: -7.3,
    lng: 72.4,
    description: "Diego Garcia — US/UK Indian Ocean base"
  },
  {
    id: "okinawa",
    name: "Okinawa",
    lat: 26.5,
    lng: 127.9,
    description: "Okinawa — US Forces Japan, Pacific presence"
  },
  { id: "guam", name: "Guam", lat: 13.5, lng: 144.8, description: "Guam — US Pacific Command, bomber base" },
  {
    id: "djibouti",
    name: "Djibouti",
    lat: 11.5,
    lng: 43.1,
    description: "Djibouti — US/China/France bases, Horn of Africa"
  },
  {
    id: "al-udeid",
    name: "Qatar",
    lat: 25.1,
    lng: 51.3,
    description: "Al Udeid — US CENTCOM forward HQ"
  },
  {
    id: "kaliningrad",
    name: "Kaliningrad",
    lat: 54.7,
    lng: 20.5,
    description: "Kaliningrad — Russian Baltic exclave, missiles"
  },
  {
    id: "sevastopol",
    name: "Sevastopol",
    lat: 44.6,
    lng: 33.5,
    description: "Sevastopol — Russian Black Sea Fleet"
  },
  {
    id: "hainan",
    name: "Hainan",
    lat: 18.2,
    lng: 109.5,
    description: "Hainan — Chinese submarine base, South China Sea"
  }
];

export function buildWarMapLayersResponse(): WarMapLayersResponse {
  return {
    updatedAt: UPDATED_AT,
    threatColors: WAR_MAP_THREAT_COLORS,
    hotspots: WAR_MAP_HOTSPOTS,
    conflictZones: WAR_MAP_CONFLICT_ZONES,
    chokepoints: WAR_MAP_CHOKEPOINTS,
    cableLandings: WAR_MAP_CABLE_LANDINGS,
    nuclearSites: WAR_MAP_NUCLEAR_SITES,
    militaryBases: WAR_MAP_MILITARY_BASES
  };
}

