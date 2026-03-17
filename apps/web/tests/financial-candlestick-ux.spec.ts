import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');
const source = fs.readFileSync(
  path.resolve(
    webRoot,
    'app/(app)/dashboard/charts/financial-candlestick.tsx',
  ),
  'utf8',
);

describe('financial candlestick UX-first behavior', () => {
  it('renders only candlestick series instead of trend-view fallback', () => {
    expect(source).toContain('type: "candlestick"');
    expect(source).not.toContain('type: "line"');
    expect(source).not.toContain('MIN_CANDLESTICK_POINTS');
    expect(source).not.toContain('trendViewLabel');
  });

  it('does not keep stale placeholder data on request failure', () => {
    expect(source).not.toContain('placeholderData');
    expect(source).not.toContain('showStaleErrorBanner');
    expect(source).toContain('if (isError) {');
  });

  it('explains partial and in-progress data to users without falling back', () => {
    expect(source).toContain('skippedIncompleteCount');
    expect(source).toContain('latestObservedAt');
    expect(source).toContain('awaitingCompleteTitle');
    expect(source).toContain('inProgressOmitted');
  });
});
