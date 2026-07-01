import { describe, expect, it } from 'vitest';

import { resolveWarMapContainerClassName } from '../app/(app)/dashboard/charts/war-map/war-map-layout';

describe('war-map layout', () => {
  it('uses the standalone default height when no custom className is provided', () => {
    expect(resolveWarMapContainerClassName()).toBe(
      'relative min-h-[24rem] h-[clamp(24rem,50dvh,29rem)]',
    );
  });

  it('keeps a minimum height fallback when consumers only request full height', () => {
    expect(resolveWarMapContainerClassName('h-full')).toBe(
      'relative min-h-[24rem] h-full',
    );
  });

  it('respects an explicit custom min-height without injecting another one', () => {
    expect(resolveWarMapContainerClassName('min-h-0 flex-1')).toBe(
      'relative min-h-0 flex-1',
    );
  });

  it('recognizes responsive min-height utilities as explicit sizing', () => {
    expect(resolveWarMapContainerClassName('sm:min-h-0 h-full')).toBe(
      'relative sm:min-h-0 h-full',
    );
  });
});
