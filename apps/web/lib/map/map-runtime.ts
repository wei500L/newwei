import { MapboxOverlay } from "@deck.gl/mapbox";
import maplibregl, {
  type Map as MapLibreMap,
  type StyleSpecification,
} from "maplibre-gl";

import { DEFAULT_WORLD_BBOX, MAP_STYLE_FALLBACK, MAP_STYLE_URL } from "./map-style";

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
  style?: string | StyleSpecification;
  fallbackStyle?: StyleSpecification;
  onMoveEnd?: (map: MapLibreMap) => void;
  onMapReady?: (map: MapLibreMap) => void;
  onFallbackApplied?: (map: MapLibreMap) => void;
}

export interface DeckMapRuntime {
  map: MapLibreMap;
  overlay: MapboxOverlay;
  destroy: () => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
    style = MAP_STYLE_URL,
    fallbackStyle = MAP_STYLE_FALLBACK,
    onMoveEnd,
    onMapReady,
    onFallbackApplied,
  } = options;

  const map = new maplibregl.Map({
    container,
    style,
    center: [initialViewState.lon, initialViewState.lat],
    zoom: initialViewState.zoom,
    bearing: initialViewState.bearing ?? 0,
    pitch: initialViewState.pitch ?? 0,
    renderWorldCopies: false,
    attributionControl: false,
  });

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
          map.resize();
        })
      : null;
  resizeObserver?.observe(container);

  let mapLoaded = false;
  let fallbackApplied = false;

  const applyFallbackStyle = () => {
    if (fallbackApplied) {
      return;
    }
    fallbackApplied = true;
    try {
      map.setStyle(fallbackStyle);
      onFallbackApplied?.(map);
    } catch {
      // Keep the map in current state; caller owns visual error handling.
    }
  };

  const handleMoveEnd = () => {
    onMoveEnd?.(map);
  };

  const handleMapError = () => {
    if (mapLoaded) {
      return;
    }
    applyFallbackStyle();
  };

  const handleLoad = () => {
    mapLoaded = true;
    const projectionAwareMap = map as unknown as {
      setProjection?: (projection: { type: "mercator" | "globe" }) => void;
    };
    projectionAwareMap.setProjection?.({ type: "mercator" });
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
      map.remove();
    },
  };
}
