import {
  WAR_MAP_DEFAULT_LAYER_VISIBILITY,
  type WarMapLayerVisibility,
} from '@modular/utils';
import { describe, expect, it } from 'vitest';

import {
  readWarMapUrlState,
  writeWarMapUrlState,
} from '@/app/(app)/dashboard/charts/war-map/url-state';

function cloneDefaultLayerVisibility(): WarMapLayerVisibility {
  return { ...WAR_MAP_DEFAULT_LAYER_VISIBILITY };
}

describe('war-map url-state', () => {
  it('parses view/preset/time-range/layers from url', () => {
    const params = new URLSearchParams(
      'lat=34.1&lon=108.9&zoom=4.2&bearing=12&pitch=41&preset=asia&tr=24h&layers=conflicts,weather,monitors',
    );

    const parsed = readWarMapUrlState(params);

    expect(parsed.viewState).toMatchObject({
      lat: 34.1,
      lon: 108.9,
      zoom: 4.2,
      bearing: 12,
      pitch: 41,
    });
    expect(parsed.activePreset).toBe('asia');
    expect(parsed.timeRangePreset).toBe('24h');
    expect(parsed.layerVisibility?.conflicts).toBe(true);
    expect(parsed.layerVisibility?.weather).toBe(true);
    expect(parsed.layerVisibility?.monitors).toBe(true);
    expect(parsed.layerVisibility?.bases).toBe(false);
  });

  it('serializes state and strips default layers token', () => {
    const params = new URLSearchParams('foo=bar');

    const next = writeWarMapUrlState(params, {
      viewState: {
        lat: 20,
        lon: 0,
        zoom: 1.8,
        bearing: 0,
        pitch: 30,
      },
      activePreset: 'global',
      timeRangePreset: '7d',
      layerVisibility: cloneDefaultLayerVisibility(),
    });

    expect(next.get('preset')).toBe('global');
    expect(next.get('tr')).toBe('7d');
    expect(next.get('layers')).toBeNull();
    expect(next.get('foo')).toBe('bar');
  });

  it('persists all-disabled layers via an empty layers token', () => {
    const noneVisible = cloneDefaultLayerVisibility();
    for (const layerId of Object.keys(noneVisible) as Array<keyof WarMapLayerVisibility>) {
      noneVisible[layerId] = false;
    }

    const written = writeWarMapUrlState(new URLSearchParams(), {
      viewState: {
        lat: 20,
        lon: 0,
        zoom: 1.8,
        bearing: 0,
        pitch: 30,
      },
      activePreset: 'global',
      timeRangePreset: '7d',
      layerVisibility: noneVisible,
    });

    expect(written.get('layers')).toBe('');

    const parsed = readWarMapUrlState(written);
    expect(parsed.layerVisibility).toBeDefined();
    expect(Object.values(parsed.layerVisibility ?? {}).every((visible) => visible === false)).toBe(
      true,
    );
  });

  it('round-trips non-default layer visibility', () => {
    const visibility = cloneDefaultLayerVisibility();
    visibility.conflicts = true;
    visibility.weather = true;
    visibility.monitors = false;
    visibility.hotspots = false;

    const written = writeWarMapUrlState(new URLSearchParams(), {
      viewState: {
        lat: -10.12345,
        lon: 120.56789,
        zoom: 5.4321,
        bearing: 24,
        pitch: 33,
      },
      activePreset: 'oceania',
      timeRangePreset: '48h',
      layerVisibility: visibility,
    });

    const parsed = readWarMapUrlState(written);

    expect(parsed.activePreset).toBe('oceania');
    expect(parsed.timeRangePreset).toBe('48h');
    expect(parsed.layerVisibility?.conflicts).toBe(true);
    expect(parsed.layerVisibility?.weather).toBe(true);
    expect(parsed.layerVisibility?.hotspots).toBe(false);
    expect(parsed.layerVisibility?.monitors).toBe(false);
  });
});
