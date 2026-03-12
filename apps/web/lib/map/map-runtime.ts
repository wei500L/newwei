import { MapboxOverlay, type MapboxOverlayProps } from "@deck.gl/mapbox";
import maplibregl, {
  type Map as MapLibreMap,
  type StyleSpecification,
} from "maplibre-gl";

import { DEFAULT_WORLD_BBOX, MAP_STYLE_URL } from "./map-style";
import type { MapLoadErrorDetail } from "./map-load-error";
import { hasRenderableContainerSize } from "./renderable-container";

export interface DeckMapInitialViewState {
  lat: number;
  lon: number;
  zoom: number;
  bearing?: number;
  pitch?: number;
}

export interface CreateDeckMapRuntimeOptions {
  container: HTMLElement;
  initialViewState: DeckMapInitialViewState;
  force2D?: boolean;
  style?: string | StyleSpecification;
  onMoveEnd?: (map: MapLibreMap) => void;
  onMapReady?: (map: MapLibreMap) => void;
  onMapError?: (map: MapLibreMap, detail: MapLoadErrorDetail) => void;
}

export interface DeckMapRuntime {
  map: MapLibreMap;
  overlay: MapboxOverlay;
  destroy: () => void;
}

type DeckLayerCandidate = {
  id?: unknown;
  clone?: (() => unknown) | undefined;
};

interface DroppedDeckLayerSummary {
  droppedCount: number;
  missingCloneCount: number;
  missingIdCount: number;
  invalidShapeCount: number;
  sampleIds: string[];
}

const deckLayerWarningSignatures = new Map<string, string>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isDeckLayerCandidate(value: unknown): value is DeckLayerCandidate {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const layer = value as DeckLayerCandidate;
  return (
    typeof layer.id === 'string' &&
    layer.id.trim().length > 0 &&
    typeof layer.clone === 'function'
  );
}

export function sanitizeDeckLayers<T>(layers: readonly T[] | null | undefined): T[] {
  return normalizeDeckLayers(layers).layers;
}

function cloneDeckLayer<T>(layer: T): T {
  return (layer as DeckLayerCandidate).clone!.call(layer) as T;
}

function normalizeDeckLayers<T>(
  layers: readonly T[] | null | undefined,
): {
  layers: T[];
  droppedSummary: DroppedDeckLayerSummary | null;
} {
  const validLayers: T[] = [];
  const droppedSummary: DroppedDeckLayerSummary = {
    droppedCount: 0,
    missingCloneCount: 0,
    missingIdCount: 0,
    invalidShapeCount: 0,
    sampleIds: [],
  };

  for (const layer of layers ?? []) {
    if (isDeckLayerCandidate(layer)) {
      validLayers.push(layer);
      continue;
    }

    droppedSummary.droppedCount += 1;
    if (!layer || typeof layer !== 'object') {
      droppedSummary.invalidShapeCount += 1;
      continue;
    }

    const candidate = layer as DeckLayerCandidate;
    if (typeof candidate.id !== 'string' || candidate.id.trim().length === 0) {
      droppedSummary.missingIdCount += 1;
    } else {
      if (droppedSummary.sampleIds.length < 5) {
        droppedSummary.sampleIds.push(candidate.id);
      }
      if (typeof candidate.clone !== 'function') {
        droppedSummary.missingCloneCount += 1;
      } else {
        droppedSummary.invalidShapeCount += 1;
      }
    }
  }

  return {
    layers: validLayers,
    droppedSummary: droppedSummary.droppedCount > 0 ? droppedSummary : null,
  };
}

function warnDroppedDeckLayers(summary: DroppedDeckLayerSummary): void {
  const signature = JSON.stringify(summary);
  const warningKey = 'deck-layer-drop';
  if (deckLayerWarningSignatures.get(warningKey) === signature) {
    return;
  }
  deckLayerWarningSignatures.set(warningKey, signature);
  console.warn('[DeckMapRuntime] Dropped invalid deck layers before overlay update.', summary);
}

export function setDeckOverlayProps(
  overlay: Pick<MapboxOverlay, 'setProps'>,
  props: Partial<MapboxOverlayProps>,
): void {
  const normalizedLayers =
    props.layers === undefined ? null : normalizeDeckLayers(props.layers as unknown[]);
  if (normalizedLayers?.droppedSummary) {
    warnDroppedDeckLayers(normalizedLayers.droppedSummary);
  }
  const nextProps =
    props.layers === undefined
      ? props
      : {
          ...props,
          // deck.gl layers are one-shot instances. Re-clone them before every overlay update
          // so a recreated overlay never reuses a finalized layer from a previous Deck instance.
          layers: normalizedLayers!.layers.map((layer) => cloneDeckLayer(layer)),
        };

  overlay.setProps(nextProps as MapboxOverlayProps);
}

export function extractMapBbox(
  map: MapLibreMap,
  fallback: [number, number, number, number] = DEFAULT_WORLD_BBOX,
): [number, number, number, number] {
  const bounds = map.getBounds();
  if (!bounds) {
    return fallback;
  }
  const west = clamp(bounds.getWest(), -180, 180);
  const south = clamp(bounds.getSouth(), -90, 90);
  const east = clamp(bounds.getEast(), -180, 180);
  const north = clamp(bounds.getNorth(), -90, 90);

  if (
    !Number.isFinite(west) ||
    !Number.isFinite(south) ||
    !Number.isFinite(east) ||
    !Number.isFinite(north)
  ) {
    return fallback;
  }

  // A single [west, south, east, north] box cannot represent anti-meridian wraps.
  // Fall back to the world bbox so server-side filters stay valid.
  if (west > east) {
    return fallback;
  }

  return [west, south, east, north];
}

export function createDeckMapRuntime(
  options: CreateDeckMapRuntimeOptions,
): DeckMapRuntime {
  const {
    container,
    initialViewState,
    force2D = false,
    style = MAP_STYLE_URL,
    onMoveEnd,
    onMapReady,
    onMapError,
  } = options;

  const map = new maplibregl.Map({
    container,
    style,
    center: [initialViewState.lon, initialViewState.lat],
    zoom: initialViewState.zoom,
    bearing: force2D ? 0 : initialViewState.bearing ?? 0,
    pitch: force2D ? 0 : initialViewState.pitch ?? 0,
    ...(force2D
      ? {
          minPitch: 0,
          maxPitch: 0,
          dragRotate: false,
          touchPitch: false,
          pitchWithRotate: false,
        }
      : {}),
    renderWorldCopies: false,
    attributionControl: false,
  });
  if (force2D) {
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.touchPitch.disable();
  }

  const useDevicePixels =
    typeof window !== "undefined" && window.devicePixelRatio > 2 ? 2 : true;
  const overlay = new MapboxOverlay({
    interleaved: true,
    layers: [],
    useDevicePixels,
    pickingRadius: 10,
  });
  map.addControl(overlay);

  const resizeObserver =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          if (!hasRenderableContainerSize(container)) {
            return;
          }
          map.resize();
        })
      : null;
  resizeObserver?.observe(container);

  let mapLoaded = false;
  let mapErrorReported = false;

  const readMapError = (event: unknown) => {
    if (!event || typeof event !== "object") {
      return event;
    }
    return (event as { error?: unknown }).error ?? event;
  };

  const handleMoveEnd = () => {
    onMoveEnd?.(map);
  };

  const handleMapError = (event: unknown) => {
    if (mapLoaded || mapErrorReported) {
      return;
    }
    mapErrorReported = true;
    onMapError?.(map, {
      trigger: "map_error",
      error: readMapError(event),
      rawEvent: event,
    });
  };

  const handleLoad = () => {
    mapLoaded = true;
    const projectionAwareMap = map as unknown as {
      setProjection?: (projection: { type: "mercator" | "globe" }) => void;
    };
    projectionAwareMap.setProjection?.({ type: "mercator" });
    if (force2D) {
      map.setBearing(0);
      map.setPitch(0);
    }
    onMapReady?.(map);
  };

  map.on("load", handleLoad);
  map.on("moveend", handleMoveEnd);
  map.on("error", handleMapError);

  return {
    map,
    overlay,
    destroy: () => {
      resizeObserver?.disconnect();
      map.off("load", handleLoad);
      map.off("moveend", handleMoveEnd);
      map.off("error", handleMapError);
      try {
        setDeckOverlayProps(overlay, { layers: [] });
      } catch {
        // Ignore teardown races; finalize/remove below is authoritative.
      }
      try {
        overlay.finalize();
      } catch {
        // Ignore duplicate finalization during fast refresh or parent map teardown.
      }
      map.remove();
    },
  };
}
