import { describe, expect, it } from 'vitest';

import { BBOX_QUERY_MIN_ZOOM, buildWarMapQueryBbox } from '../app/(app)/dashboard/charts/war-map/query-viewport';

describe('war-map query viewport', () => {
  it('does not include bbox below the query threshold zoom', () => {
    const bbox: [number, number, number, number] = [-120.123456, 10.123456, 100.987654, 60.987654];
    const result = buildWarMapQueryBbox(bbox, BBOX_QUERY_MIN_ZOOM - 0.1);

    expect(result).toBeUndefined();
  });

  it('formats bbox when zoom is at least the threshold', () => {
    const bbox: [number, number, number, number] = [-120.123456, 10.123456, 100.987654, 60.987654];
    const result = buildWarMapQueryBbox(bbox, BBOX_QUERY_MIN_ZOOM);

    expect(result).toBe('-120.12346,10.12346,100.98765,60.98765');
  });

  it('returns undefined when bbox is missing', () => {
    expect(buildWarMapQueryBbox(undefined, BBOX_QUERY_MIN_ZOOM + 1)).toBeUndefined();
  });
});
