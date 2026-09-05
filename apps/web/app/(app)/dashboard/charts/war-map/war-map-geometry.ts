import type { WarMapLayerFeature } from '@modular/utils';

export type DeckCoordinate = [number, number];

export interface SanitizedDeckPathFeature extends WarMapLayerFeature {
  path: DeckCoordinate[];
}

export interface SanitizedDeckPolygonFeature extends WarMapLayerFeature {
  polygon: DeckCoordinate[][];
}

export interface SanitizedDeckPointFeature extends WarMapLayerFeature {
  lat: number;
  lng: number;
}

export interface SanitizedDeckPathResult {
  pathFeatures: SanitizedDeckPathFeature[];
  pointFeatures: SanitizedDeckPointFeature[];
}

export interface SanitizedDeckPolygonResult {
  outlineFeatures: SanitizedDeckPathFeature[];
  pointFeatures: SanitizedDeckPointFeature[];
  polygonFeature: SanitizedDeckPolygonFeature | null;
}

function isValidLatLng(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

export function isValidDeckCoordinate(value: unknown): value is DeckCoordinate {
  if (!Array.isArray(value) || value.length < 2) {
    return false;
  }

  const [lng, lat] = value;
  return typeof lng === 'number' && typeof lat === 'number' && isValidLatLng(lat, lng);
}

function cloneCoordinate([lng, lat]: DeckCoordinate): DeckCoordinate {
  return [lng, lat];
}

function areSameCoordinate(a: DeckCoordinate, b: DeckCoordinate): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function countUniqueVertices(ring: readonly DeckCoordinate[]): number {
  const lastIndex = ring.length > 1 && areSameCoordinate(ring[0]!, ring[ring.length - 1]!)
    ? ring.length - 1
    : ring.length;

  const unique = new Set<string>();
  for (let index = 0; index < lastIndex; index += 1) {
    const coordinate = ring[index];
    if (!coordinate) {
      continue;
    }
    unique.add(`${coordinate[0]},${coordinate[1]}`);
  }

  return unique.size;
}

function normalizeClosedRing(ring: readonly DeckCoordinate[]): DeckCoordinate[] | null {
  if (ring.length < 3) {
    return null;
  }

  const closedRing = areSameCoordinate(ring[0]!, ring[ring.length - 1]!)
    ? ring.map(cloneCoordinate)
    : [...ring.map(cloneCoordinate), cloneCoordinate(ring[0]!)];

  if (closedRing.length < 4 || countUniqueVertices(closedRing) < 3) {
    return null;
  }

  return closedRing;
}

function isFullyValidCoordinateSequence(
  value: unknown,
  minimumPoints: number,
): value is DeckCoordinate[] {
  return Array.isArray(value) && value.length >= minimumPoints && value.every(isValidDeckCoordinate);
}

function splitDeckPathGeometry(path: unknown): {
  points: DeckCoordinate[];
  segments: DeckCoordinate[][];
} {
  if (!Array.isArray(path)) {
    return { segments: [], points: [] };
  }

  const segments: DeckCoordinate[][] = [];
  const points: DeckCoordinate[] = [];
  let current: DeckCoordinate[] = [];

  const flush = () => {
    if (current.length >= 2) {
      segments.push(current);
    } else if (current.length === 1) {
      points.push(current[0]!);
    }
    current = [];
  };

  for (const coordinate of path) {
    if (!isValidDeckCoordinate(coordinate)) {
      flush();
      continue;
    }

    current.push(cloneCoordinate(coordinate));
  }

  flush();
  return { segments, points };
}

function stripFeatureGeometry(
  feature: WarMapLayerFeature,
): Omit<WarMapLayerFeature, 'path' | 'polygon'> {
  const baseFeature = { ...feature };
  delete baseFeature.path;
  delete baseFeature.polygon;
  return baseFeature;
}

function buildPointFeaturesFromCoordinates(
  feature: WarMapLayerFeature,
  coordinates: DeckCoordinate[],
  idPrefix: string,
): SanitizedDeckPointFeature[] {
  const baseFeature = stripFeatureGeometry(feature);
  return coordinates.map(([lng, lat], index) => ({
    ...baseFeature,
    id: `${feature.id}-${idPrefix}-${index}`,
    lat,
    lng,
  }));
}

function buildPathFeaturesFromSegments(
  feature: WarMapLayerFeature,
  segments: DeckCoordinate[][],
  idPrefix: string,
  preserveOriginalId = false,
): SanitizedDeckPathFeature[] {
  const baseFeature = stripFeatureGeometry(feature);
  return segments.map((path, index) => ({
    ...baseFeature,
    id: preserveOriginalId && index === 0 ? feature.id : `${feature.id}-${idPrefix}-${index}`,
    path,
  }));
}

export function buildSanitizedPathGeometry(
  feature: WarMapLayerFeature,
): SanitizedDeckPathResult {
  const { points, segments } = splitDeckPathGeometry(feature.path);
  return {
    pathFeatures: buildPathFeaturesFromSegments(
      feature,
      segments,
      'segment',
      isFullyValidCoordinateSequence(feature.path, 2) && segments.length === 1,
    ),
    pointFeatures: buildPointFeaturesFromCoordinates(feature, points, 'point'),
  };
}

function buildOutlineFeaturesFromSegments(
  feature: WarMapLayerFeature,
  ringIndex: number,
  segments: DeckCoordinate[][],
): SanitizedDeckPathFeature[] {
  return buildPathFeaturesFromSegments(feature, segments, `outline-${ringIndex}`);
}

function buildOutlinePointFeatures(
  feature: WarMapLayerFeature,
  ringIndex: number,
  coordinates: DeckCoordinate[],
): SanitizedDeckPointFeature[] {
  const baseFeature = stripFeatureGeometry(feature);
  return coordinates.map(([lng, lat], pointIndex) => ({
    ...baseFeature,
    id: `${feature.id}-outline-point-${ringIndex}-${pointIndex}`,
    lat,
    lng,
  }));
}

export function buildSanitizedPolygonResult(
  feature: WarMapLayerFeature,
): SanitizedDeckPolygonResult {
  if (!Array.isArray(feature.polygon)) {
    return { polygonFeature: null, outlineFeatures: [], pointFeatures: [] };
  }

  const baseFeature = stripFeatureGeometry(feature);
  const outlineFeatures: SanitizedDeckPathFeature[] = [];
  const pointFeatures: SanitizedDeckPointFeature[] = [];
  const validPolygonRings: DeckCoordinate[][] = [];
  let hasRenderableOuterRing = false;

  feature.polygon.forEach((ring, ringIndex) => {
    if (!Array.isArray(ring)) {
      return;
    }

    if (isFullyValidCoordinateSequence(ring, 3)) {
      const normalizedRing = normalizeClosedRing(ring);
      if (normalizedRing) {
        if (ringIndex === 0) {
          hasRenderableOuterRing = true;
          validPolygonRings.push(normalizedRing);
          return;
        }

        if (hasRenderableOuterRing) {
          validPolygonRings.push(normalizedRing);
          return;
        }

        outlineFeatures.push(
          ...buildOutlineFeaturesFromSegments(feature, ringIndex, [normalizedRing]),
        );
        return;
      }
    }

    const fallbackGeometry = splitDeckPathGeometry(ring);
    outlineFeatures.push(
      ...buildOutlineFeaturesFromSegments(
        feature,
        ringIndex,
        fallbackGeometry.segments,
      ),
    );
    pointFeatures.push(
      ...buildOutlinePointFeatures(
        feature,
        ringIndex,
        fallbackGeometry.points,
      ),
    );
  });

  return {
    polygonFeature:
      hasRenderableOuterRing && validPolygonRings.length > 0
        ? { ...baseFeature, id: feature.id, polygon: validPolygonRings }
        : null,
    outlineFeatures,
    pointFeatures,
  };
}
