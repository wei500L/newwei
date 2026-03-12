import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('economic short navigation', () => {
  it('uses a compact Select switcher instead of Tabs for index names', () => {
    const source = read('app/(app)/dashboard/economic-short/page.tsx');

    expect(source).toContain('Select,');
    expect(source).toContain('<Select');
    expect(source).toContain('popupMatchSelectWidth={false}');
    expect(source).not.toContain('Tabs,');
    expect(source).not.toContain('<Tabs');
  });
});
