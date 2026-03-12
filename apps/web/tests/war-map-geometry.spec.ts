import { describe, expect, it } from 'vitest';

import {
  buildSanitizedPathGeometry,
  buildSanitizedPathFeatures,
  buildSanitizedPolygonResult,
  splitDeckPathSegments,
} from '../app/(app)/dashboard/charts/war-map/war-map-geometry';

describe('war-map geometry sanitization', () => {
  it('keeps valid path features intact', () => {
    expect(
      buildSanitizedPathFeatures({
        id: 'path-1',
        path: [
          [10, 20],
          [11, 21],
          [12, 22],
        ],
      }),
    ).toEqual([
      {
        id: 'path-1',
        path: [
          [10, 20],
          [11, 21],
          [12, 22],
        ],
      },
    ]);
  });

  it('splits paths at invalid coordinates instead of bridging across them', () => {
    expect(
      splitDeckPathSegments([
        [10, 20],
        [11, 21],
        null,
        [12, 22],
        [13, 23],
      ]),
    ).toEqual([
      [
        [10, 20],
        [11, 21],
      ],
      [
        [12, 22],
        [13, 23],
      ],
    ]);

    expect(
      buildSanitizedPathFeatures({
        id: 'path-2',
        path: [
          [10, 20],
          [11, 21],
          null,
          [12, 22],
          [13, 23],
        ],
      } as never),
    ).toEqual([
      {
        id: 'path-2-segment-0',
        path: [
          [10, 20],
          [11, 21],
        ],
      },
      {
        id: 'path-2-segment-1',
        path: [
          [12, 22],
          [13, 23],
        ],
      },
    ]);
  });

  it('preserves isolated valid path coordinates as point fallbacks', () => {
    expect(
      buildSanitizedPathGeometry({
        id: 'path-3',
        path: [
          [10, 20],
          null,
          [11, 21],
        ],
      } as never),
    ).toEqual({
      pathFeatures: [],
      pointFeatures: [
        {
          id: 'path-3-point-0',
          lat: 20,
          lng: 10,
        },
        {
          id: 'path-3-point-1',
          lat: 21,
          lng: 11,
        },
      ],
    });
  });

  it('keeps valid polygons renderable and closes open rings without changing vertices', () => {
    expect(
      buildSanitizedPolygonResult({
        id: 'polygon-1',
        polygon: [
          [
            [10, 20],
            [11, 20],
            [11, 21],
            [10, 21],
          ],
        ],
      }),
    ).toEqual({
      polygonFeature: {
        id: 'polygon-1',
        polygon: [
          [
            [10, 20],
            [11, 20],
            [11, 21],
            [10, 21],
            [10, 20],
          ],
        ],
      },
      outlineFeatures: [],
      pointFeatures: [],
    });
  });

  it('falls back to outline fragments for malformed polygons without inventing a filled area', () => {
    expect(
      buildSanitizedPolygonResult({
        id: 'polygon-2',
        polygon: [
          [
            [10, 20],
            [11, 20],
            null,
            [11, 21],
            [10, 21],
          ],
        ],
      } as never),
    ).toEqual({
      polygonFeature: null,
      outlineFeatures: [
        {
          id: 'polygon-2-outline-0-0',
          path: [
            [10, 20],
            [11, 20],
          ],
        },
        {
          id: 'polygon-2-outline-0-1',
          path: [
            [11, 21],
            [10, 21],
          ],
        },
      ],
      pointFeatures: [],
    });
  });

  it('preserves isolated valid polygon vertices as point fallbacks', () => {
    expect(
      buildSanitizedPolygonResult({
        id: 'polygon-3',
        polygon: [
          [
            [10, 20],
            null,
            [11, 21],
          ],
        ],
      } as never),
    ).toEqual({
      polygonFeature: null,
      outlineFeatures: [],
      pointFeatures: [
        {
          id: 'polygon-3-outline-point-0-0',
          lat: 20,
          lng: 10,
        },
        {
          id: 'polygon-3-outline-point-0-1',
          lat: 21,
          lng: 11,
        },
      ],
    });
  });
});
