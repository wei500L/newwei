import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('news sources live updates wiring', () => {
  it('keeps the ops socket stable across table refreshes', () => {
    const source = read('app/(app)/admin/ops/news-sources/news-sources-content.tsx');

    expect(source).toContain('const visibleSourceIdSetRef = useRef<Set<string>>(new Set())');
    expect(source).toContain('visibleSourceIdSetRef.current = visibleSourceIdSet;');
    expect(source).toContain('const refreshAllRef = useRef<');
    expect(source).toContain('refreshAllRef.current = refreshAll;');
    expect(source).toContain('void refreshAllRef.current?.({');
    expect(source).toContain('!sourceId || !visibleSourceIdSetRef.current.has(sourceId)');
    expect(source).not.toContain('session?.accessToken,\n    visibleSourceIdSet,');
    expect(source).not.toContain('liveUpdatesEnabled,\n    refreshAll,');
  });

  it('binds ops socket listeners before connecting', () => {
    const source = read('app/(app)/admin/ops/news-sources/news-sources-content.tsx');

    expect(source).toContain('autoConnect: false');
    expect(source).toContain('const connectTimer = window.setTimeout(() => {');
    expect(source).toContain('socket.connect();');
    expect(source).toContain('window.clearTimeout(connectTimer);');
  });
});
