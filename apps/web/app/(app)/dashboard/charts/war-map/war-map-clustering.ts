'use client';

export type WarMapBbox = [number, number, number, number];

export interface WarMapClusterablePoint {
  id: string;
  lat: number;
  lng: number;
}

export interface WarMapClusterGeometry {
  lat: number;
  lng: number;
}

export interface WarMapCluster<T extends WarMapClusterablePoint> {
  id: string;
  cellKey: string;
  memberKey: string;
  count: number;
  lat: number;
  lng: number;
  members: T[];
}

export interface WarMapClusterPartition<T extends WarMapClusterablePoint> {
  bbox: WarMapBbox;
  cellSizeDeg: number;
  singles: T[];
  clusters: Array<WarMapCluster<T>>;
}

export interface ClusterWarMapPointsOptions<T extends WarMapClusterablePoint> {
  bbox?: WarMapBbox;
  zoom?: number;
  sortMembers?: (members: readonly T[]) => T[];
  getClusterGeometry?: (members: readonly T[]) => WarMapClusterGeometry;
}

export interface WarMapEventClusterMemberLike extends WarMapClusterablePoint {
  severity?: string;
  latestAt?: string;
  derivedScore?: number;
  value?: number;
  name?: string;
}

export interface WarMapNewsClusterMemberLike extends WarMapClusterablePoint {
  publishedAt?: string;
  ingestedAt?: string;
  title?: string;
  location?: string;
}

export const DEFAULT_WAR_MAP_CLUSTER_ZOOM = 2;
export const MAX_WAR_MAP_CLUSTER_ZOOM = 16;
export const DEFAULT_WAR_MAP_BBOX: WarMapBbox = [-180, -85, 180, 85];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampFinite(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return clamp(value, min, max);
}

function parseEpoch(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : 0;
}

function compareString(left: string | undefined, right: string | undefined): number {
  const normalizedLeft = (left ?? '').trim().toLowerCase();
  const normalizedRight = (right ?? '').trim().toLowerCase();
  if (normalizedLeft < normalizedRight) {
    return -1;
  }
  if (normalizedLeft > normalizedRight) {
    return 1;
  }
  return 0;
}

function severityRank(value: string | undefined): number {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
    default:
      return 0;
  }
}

export function resolveWarMapClusterBbox(bbox?: WarMapBbox): WarMapBbox {
  if (!bbox) {
    return DEFAULT_WAR_MAP_BBOX;
  }
  const [minLng, minLat, maxLng, maxLat] = bbox;
  return [
    clampFinite(minLng, -180, 180),
    clampFinite(minLat, -90, 90),
    clampFinite(maxLng, -180, 180),
    clampFinite(maxLat, -90, 90),
  ];
}

export function resolveWarMapClusterZoom(zoom?: number): number {
  const normalized =
    typeof zoom === 'number' && Number.isFinite(zoom)
      ? Math.round(zoom)
      : DEFAULT_WAR_MAP_CLUSTER_ZOOM;
  return clamp(normalized, 0, MAX_WAR_MAP_CLUSTER_ZOOM);
}

export function resolveWarMapClusterCellSizeDegrees(zoom?: number): number {
  const normalizedZoom = resolveWarMapClusterZoom(zoom);
  const scale = Math.pow(2, normalizedZoom / 2);
  const rawCellSize = 24 / scale;
  return clampFinite(rawCellSize, 0.35, 32);
}

export function buildWarMapClusterCellKey(
  lat: number,
  lng: number,
  bbox: WarMapBbox,
  cellSizeDeg: number,
): string {
  const [minLng, minLat] = bbox;
  const x = Math.floor((lng - minLng) / cellSizeDeg);
  const y = Math.floor((lat - minLat) / cellSizeDeg);
  return `${x}:${y}`;
}

export function buildWarMapClusterMemberKey<T extends WarMapClusterablePoint>(
  members: readonly T[],
): string {
  return JSON.stringify(
    members.map((member) => member.id).sort((left, right) => left.localeCompare(right)),
  );
}

export function isWithinWarMapBbox(
  lat: number,
  lng: number,
  bbox: WarMapBbox,
): boolean {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  return lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat;
}

export function computeAverageClusterGeometry<T extends WarMapClusterablePoint>(
  members: readonly T[],
): WarMapClusterGeometry {
  if (members.length === 0) {
    return { lat: 0, lng: 0 };
  }

  let latTotal = 0;
  let lngTotal = 0;
  for (const member of members) {
    latTotal += member.lat;
    lngTotal += member.lng;
  }
  return {
    lat: clampFinite(latTotal / members.length, -90, 90),
    lng: clampFinite(lngTotal / members.length, -180, 180),
  };
}

export function computeWeightedClusterGeometry<T extends WarMapClusterablePoint>(
  members: readonly T[],
  getWeight: (member: T) => number,
): WarMapClusterGeometry {
  if (members.length === 0) {
    return { lat: 0, lng: 0 };
  }

  let weightTotal = 0;
  let latWeighted = 0;
  let lngWeighted = 0;
  for (const member of members) {
    const rawWeight = getWeight(member);
    const weight = Number.isFinite(rawWeight) && rawWeight > 0 ? rawWeight : 1;
    weightTotal += weight;
    latWeighted += member.lat * weight;
    lngWeighted += member.lng * weight;
  }

  if (weightTotal <= 0) {
    return computeAverageClusterGeometry(members);
  }

  return {
    lat: clampFinite(latWeighted / weightTotal, -90, 90),
    lng: clampFinite(lngWeighted / weightTotal, -180, 180),
  };
}

export function sortWarMapEventClusterMembers<T extends WarMapEventClusterMemberLike>(
  members: readonly T[],
): T[] {
  return [...members].sort((left, right) => {
    const severityDelta = severityRank(right.severity) - severityRank(left.severity);
    if (severityDelta !== 0) {
      return severityDelta;
    }

    const rightEpoch = parseEpoch(right.latestAt);
    const leftEpoch = parseEpoch(left.latestAt);
    if (rightEpoch !== leftEpoch) {
      return rightEpoch - leftEpoch;
    }

    const rightScore = right.derivedScore ?? right.value ?? 0;
    const leftScore = left.derivedScore ?? left.value ?? 0;
    if (rightScore !== leftScore) {
      return rightScore - leftScore;
    }

    return compareString(left.name, right.name);
  });
}

export function sortWarMapNewsClusterMembers<T extends WarMapNewsClusterMemberLike>(
  members: readonly T[],
): T[] {
  return [...members].sort((left, right) => {
    const rightEpoch = parseEpoch(right.publishedAt ?? right.ingestedAt);
    const leftEpoch = parseEpoch(left.publishedAt ?? left.ingestedAt);
    if (rightEpoch !== leftEpoch) {
      return rightEpoch - leftEpoch;
    }

    const titleDelta = compareString(left.title, right.title);
    if (titleDelta !== 0) {
      return titleDelta;
    }

    return compareString(left.location, right.location);
  });
}

export function clusterWarMapPoints<T extends WarMapClusterablePoint>(
  points: readonly T[],
  options: ClusterWarMapPointsOptions<T> = {},
): WarMapClusterPartition<T> {
  const bbox = resolveWarMapClusterBbox(options.bbox);
  const cellSizeDeg = resolveWarMapClusterCellSizeDegrees(options.zoom);
  const groups = new Map<string, T[]>();

  for (const point of points) {
    if (!isWithinWarMapBbox(point.lat, point.lng, bbox)) {
      continue;
    }
    const key = buildWarMapClusterCellKey(point.lat, point.lng, bbox, cellSizeDeg);
    const group = groups.get(key);
    if (group) {
      group.push(point);
    } else {
      groups.set(key, [point]);
    }
  }

  const singles: T[] = [];
  const clusters: Array<WarMapCluster<T>> = [];

  for (const [cellKey, members] of groups.entries()) {
    const sortedMembers = options.sortMembers ? options.sortMembers(members) : [...members];
    if (sortedMembers.length <= 1) {
      const single = sortedMembers[0];
      if (single) {
        singles.push(single);
      }
      continue;
    }

    const geometry = options.getClusterGeometry
      ? options.getClusterGeometry(sortedMembers)
      : computeAverageClusterGeometry(sortedMembers);

    clusters.push({
      id: `cluster-${cellKey}`,
      cellKey,
      memberKey: buildWarMapClusterMemberKey(sortedMembers),
      count: sortedMembers.length,
      lat: geometry.lat,
      lng: geometry.lng,
      members: sortedMembers,
    });
  }

  return {
    bbox,
    cellSizeDeg,
    singles,
    clusters,
  };
}
