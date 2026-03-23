import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('crawl task detail backfill regressions', () => {
  it('guards zero-result backfills and uses explicit local backfill state', () => {
    const source = read('app/(app)/crawl/[taskId]/task-detail.tsx');

    expect(source).toContain('const [backfillRunning, setBackfillRunning] = useState(false);');
    expect(source).toContain('(task.results?.length ?? 0) === 0 && !task.lastResultAt');
    expect(source).toContain('withTimeout(');
    expect(source).toContain('disabled={backfillUnavailable}');
    expect(source).not.toContain('loading={backfilling}');
  });
});
