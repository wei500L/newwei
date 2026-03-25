import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('newsnow refresh feedback wiring', () => {
  it('shows inline priming warnings and keeps manual refresh loading separate', () => {
    const source = read('app/(app)/newsnow/[column]/page.tsx');

    expect(source).toContain('usePendingAction');
    expect(source).toContain('const { clearPrimeFeedback, primeFeedback, primeSources } =');
    expect(source).toContain('const { pending: refreshingSources, run: runPrimeSources } = usePendingAction');
    expect(source).toContain('const primeFeedbackSummary = useMemo(() => {');
    expect(source).toContain('当前栏目刷新失败');
    expect(source).toContain('重试失败源');
    expect(source).not.toContain('loading={isPrimingSources}');
  });
});
