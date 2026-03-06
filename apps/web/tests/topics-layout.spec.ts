import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EVENT_MIN_GROUP_SIZE,
  DEFAULT_WINDOW_DAYS,
  parsePositiveInt,
  resolveTopicsFilterLayoutMode
} from '../app/(app)/topics/topics-view-state';

describe('resolveTopicsFilterLayoutMode', () => {
  it('uses sticky compact toolbar on large screens', () => {
    expect(resolveTopicsFilterLayoutMode({ lg: true })).toBe('desktopSticky');
  });

  it('uses inline toolbar below the large breakpoint', () => {
    expect(resolveTopicsFilterLayoutMode({ lg: false })).toBe('inlineStatic');
    expect(resolveTopicsFilterLayoutMode()).toBe('inlineStatic');
  });
});

describe('parsePositiveInt', () => {
  it('preserves the default topics window when the query is empty or invalid', () => {
    expect(parsePositiveInt(null, DEFAULT_WINDOW_DAYS)).toBe(DEFAULT_WINDOW_DAYS);
    expect(parsePositiveInt('0', DEFAULT_WINDOW_DAYS)).toBe(DEFAULT_WINDOW_DAYS);
    expect(parsePositiveInt('bad', DEFAULT_WINDOW_DAYS)).toBe(DEFAULT_WINDOW_DAYS);
  });

  it('preserves the default minimum group size when the query is not a positive scalar', () => {
    expect(parsePositiveInt(undefined, DEFAULT_EVENT_MIN_GROUP_SIZE)).toBe(
      DEFAULT_EVENT_MIN_GROUP_SIZE
    );
    expect(parsePositiveInt(['3'], DEFAULT_EVENT_MIN_GROUP_SIZE)).toBe(
      DEFAULT_EVENT_MIN_GROUP_SIZE
    );
  });
});
