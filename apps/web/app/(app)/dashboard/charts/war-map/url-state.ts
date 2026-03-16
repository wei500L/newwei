import {
  type WarMapFlightMode,
  type WarMapLayerVisibility,
  type WarMapPreset,
  type WarMapTimeRangePreset,
  type WarMapViewState,
  WAR_MAP_DEFAULT_LAYER_VISIBILITY,
  WAR_MAP_LAYER_IDS,
  WAR_MAP_PRESETS,
  WAR_MAP_TIME_RANGE_PRESETS,
  normalizeWarMapViewState,
} from '@modular/utils';

export interface WarMapUrlState {
  viewState?: Partial<WarMapViewState>;
  activePreset?: WarMapPreset;
  timeRangePreset?: WarMapTimeRangePreset;
  layerVisibility?: WarMapLayerVisibility;
  flightMode?: WarMapFlightMode;
}

function parseFiniteNumber(value: string | null): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parsePreset(value: string | null): WarMapPreset | undefined {
  if (!value) {
    return undefined;
  }
  return WAR_MAP_PRESETS.includes(value as WarMapPreset)
    ? (value as WarMapPreset)
    : undefined;
}

function parseTimeRangePreset(
  value: string | null,
): WarMapTimeRangePreset | undefined {
  if (!value) {
    return undefined;
  }
  return WAR_MAP_TIME_RANGE_PRESETS.includes(value as WarMapTimeRangePreset)
    ? (value as WarMapTimeRangePreset)
    : undefined;
}

function parseLayerVisibility(value: string | null): WarMapLayerVisibility | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const enabled = new Set(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => WAR_MAP_LAYER_IDS.includes(entry as (typeof WAR_MAP_LAYER_IDS)[number])),
  );

  const next = {} as WarMapLayerVisibility;
  for (const layerId of WAR_MAP_LAYER_IDS) {
    next[layerId] = enabled.has(layerId);
  }
  return next;
}

function parseFlightMode(value: string | null): WarMapFlightMode | undefined {
  if (!value) {
    return undefined;
  }
  return value === 'all' ? 'all' : value === 'military' ? 'military' : undefined;
}

export function readWarMapUrlState(search: URLSearchParams): WarMapUrlState {
  const lat = parseFiniteNumber(search.get('lat'));
  const lon = parseFiniteNumber(search.get('lon'));
  const zoom = parseFiniteNumber(search.get('zoom'));
  const bearing = parseFiniteNumber(search.get('bearing'));
  const pitch = parseFiniteNumber(search.get('pitch'));

  const hasAnyViewValue =
    typeof lat === 'number' ||
    typeof lon === 'number' ||
    typeof zoom === 'number' ||
    typeof bearing === 'number' ||
    typeof pitch === 'number';

  const viewState = hasAnyViewValue
    ? normalizeWarMapViewState({ lat, lon, zoom, bearing, pitch })
    : undefined;

  const activePreset = parsePreset(search.get('preset'));
  const timeRangePreset = parseTimeRangePreset(search.get('tr'));
  const layerVisibility = parseLayerVisibility(search.get('layers'));
  const flightMode = parseFlightMode(search.get('fm'));

  return {
    viewState,
    activePreset,
    timeRangePreset,
    layerVisibility,
    flightMode,
  };
}

export function writeWarMapUrlState(
  search: URLSearchParams,
  state: {
    viewState: WarMapViewState;
    activePreset: WarMapPreset;
    timeRangePreset: WarMapTimeRangePreset;
    layerVisibility: WarMapLayerVisibility;
    flightMode: WarMapFlightMode;
  },
): URLSearchParams {
  const next = new URLSearchParams(search.toString());
  next.set('lat', state.viewState.lat.toFixed(4));
  next.set('lon', state.viewState.lon.toFixed(4));
  next.set('zoom', state.viewState.zoom.toFixed(2));
  next.set('bearing', state.viewState.bearing.toFixed(2));
  next.set('pitch', state.viewState.pitch.toFixed(2));
  next.set('preset', state.activePreset);
  next.set('tr', state.timeRangePreset);
  if (state.flightMode === 'all') {
    next.set('fm', 'all');
  } else {
    next.delete('fm');
  }

  const enabledLayers = WAR_MAP_LAYER_IDS.filter(
    (layerId) => state.layerVisibility[layerId],
  );
  const defaultEnabledLayers = WAR_MAP_LAYER_IDS.filter(
    (layerId) => WAR_MAP_DEFAULT_LAYER_VISIBILITY[layerId],
  );

  const serializedLayers = enabledLayers.join(',');
  const serializedDefaults = defaultEnabledLayers.join(',');
  if (serializedLayers !== serializedDefaults) {
    next.set('layers', serializedLayers);
  } else {
    next.delete('layers');
  }

  return next;
}
