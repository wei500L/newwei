import { describe, expect, it, vi } from 'vitest';

vi.mock('@deck.gl/mapbox', () => ({
  MapboxOverlay: class MapboxOverlay {},
}));

vi.mock('maplibre-gl', () => ({
  default: {
    Map: class Map {},
  },
}));

import { sanitizeDeckLayers, setDeckOverlayProps } from '../lib/map/map-runtime';

describe('map runtime deck helpers', () => {
  it('filters out invalid or non-deck layers before updating the overlay', () => {
    const validLayerA = { id: 'layer-a', clone: () => ({ id: 'layer-a' }) };
    const validLayerB = { id: 'layer-b', clone: () => ({ id: 'layer-b' }) };

    expect(
      sanitizeDeckLayers([
        validLayerA,
        null,
        undefined,
        { id: 'plain-object' },
        { id: '' },
        { id: '   ' },
        validLayerB,
      ]),
    ).toEqual([validLayerA, validLayerB]);
  });

  it('re-clones layer instances before handing them to a new overlay', () => {
    const clonedLayer = { id: 'layer-a', cloned: true };
    const layer = {
      id: 'layer-a',
      clone: () => clonedLayer,
    };
    let receivedLayers: unknown[] | undefined;

    setDeckOverlayProps(
      {
        setProps: (props: { layers?: unknown[] }) => {
          receivedLayers = props.layers as unknown[] | undefined;
        },
      } as never,
      { layers: [layer] as never[] },
    );

    expect(receivedLayers).toEqual([clonedLayer]);
    expect(receivedLayers?.[0]).not.toBe(layer);
  });

  it('warns when invalid layers are discarded before overlay update', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    setDeckOverlayProps(
      {
        setProps: () => undefined,
      } as never,
      {
        layers: [
          { id: 'valid-layer', clone: () => ({ id: 'valid-layer' }) },
          { id: 'missing-clone' },
          null,
        ] as never[],
      },
    );

    expect(warnSpy).toHaveBeenCalledWith(
      '[DeckMapRuntime] Dropped invalid deck layers before overlay update.',
      expect.objectContaining({
        droppedCount: 2,
        missingCloneCount: 1,
        invalidShapeCount: 1,
        sampleIds: ['missing-clone'],
      }),
    );

    warnSpy.mockRestore();
  });

  it('reuses cloned layers and skips overlay updates when layers and tooltip are unchanged', () => {
    const clonedLayer = { id: 'layer-a', cloned: true };
    const layer = {
      id: 'layer-a',
      clone: vi.fn(() => clonedLayer),
    };
    const setProps = vi.fn();
    const tooltip = vi.fn();
    const overlay = {
      setProps,
    } as never;

    setDeckOverlayProps(
      overlay,
      { layers: [layer] as never[], getTooltip: tooltip as never },
    );
    setDeckOverlayProps(
      overlay,
      { layers: [layer] as never[], getTooltip: tooltip as never },
    );

    expect(layer.clone).toHaveBeenCalledTimes(1);
    expect(setProps).toHaveBeenCalledTimes(1);
  });
});
