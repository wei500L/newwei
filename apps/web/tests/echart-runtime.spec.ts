import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('echart runtime regressions', () => {
  it('waits for a renderable container and observes container resizes', () => {
    const source = read('components/echart.client.tsx');

    expect(source).toContain('useRenderableContainer');
    expect(source).toContain('renderableContainerReady');
    expect(source).toContain('hasRenderableContainerSize(dom)');
    expect(source).toContain('new ResizeObserver');
  });
});
