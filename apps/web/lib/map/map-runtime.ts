import { MapboxOverlay, type MapboxOverlayProps } from "@deck.gl/mapbox";
import maplibregl, {
  type Map as MapLibreMap,
  type StyleSpecification,
} from "maplibre-gl";

import { DEFAULT_WORLD_BBOX, MAP_STYLE_FALLBACK, MAP_STYLE_URL } from "./map-style";
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

type DeckLayerCandidate = {
  id?: unknown;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function sanitizeDeckLayers<T>(layers: readonly T[] | null | undefined): T[] {
  return (layers ?? []).filter((layer): layer is T => {
    if (!layer || typeof layer !== 'object') {
      return false;
    }
    const id = (layer as DeckLayerCandidate).id;
    return typeof id === 'string' && id.trim().length > 0;
  });
}

export function setDeckOverlayProps(
  overlay: Pick<MapboxOverlay, 'setProps'>,
  props: Partial<MapboxOverlayProps>,
): void {
  const nextProps =
    props.layers === undefined
      ? props
      : {
          ...props,
          layers: sanitizeDeckLayers(props.layers as unknown[]),
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
