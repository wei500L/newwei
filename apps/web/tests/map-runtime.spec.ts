import { describe, expect, it } from 'vitest';

import { sanitizeDeckLayers } from '../lib/map/map-runtime';

describe('map runtime deck helpers', () => {
  it('filters out invalid layers before updating the overlay', () => {
    const validLayerA = { id: 'layer-a' };
    const validLayerB = { id: 'layer-b' };

    expect(
      sanitizeDeckLayers([
        validLayerA,
        null,
        undefined,
        { id: '' },
        { id: '   ' },
        validLayerB,
      ]),
    ).toEqual([validLayerA, validLayerB]);
  });
});
