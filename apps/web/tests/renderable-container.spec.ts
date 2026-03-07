import { describe, expect, it } from 'vitest';

import { hasRenderableContainerSize } from '../lib/map/renderable-container';

describe('hasRenderableContainerSize', () => {
  it('returns false for missing containers', () => {
    expect(hasRenderableContainerSize(null)).toBe(false);
    expect(hasRenderableContainerSize(undefined)).toBe(false);
  });

  it('returns false when width or height is zero', () => {
    expect(hasRenderableContainerSize({ clientWidth: 0, clientHeight: 320 })).toBe(false);
    expect(hasRenderableContainerSize({ clientWidth: 640, clientHeight: 0 })).toBe(false);
  });

  it('returns true only when both dimensions are positive', () => {
    expect(hasRenderableContainerSize({ clientWidth: 640, clientHeight: 320 })).toBe(true);
  });
});
