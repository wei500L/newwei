import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('newsnow recommended route wiring', () => {
  it('keeps recommended as a static tab and renders the dedicated feed surface', () => {
    const headerModel = read('app/(app)/newsnow/lib/newsnow-header-model.ts');
    const columnPage = read('app/(app)/newsnow/[column]/page.tsx');
    const header = read('app/(app)/newsnow/components/newsnow-header.tsx');

    expect(headerModel).toContain("'recommended'");
    expect(headerModel).toContain("{ key: 'recommended', name: '推荐' }");
    expect(columnPage).toContain('normalizedColumnKey === "recommended"');
    expect(columnPage).toContain('<NewsnowRecommendedFeed />');
    expect(header).toContain('const isRecommendedTab = pathname === "/newsnow/recommended";');
  });
});
