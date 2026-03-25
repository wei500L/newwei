import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('newsnow source batch priming wiring', () => {
  it('chunks batch requests and classifies unsupported sources from explicit errors', () => {
    const source = read('app/(app)/newsnow/hooks/use-news-sources.ts');

    expect(source).toContain('const NEWS_SOURCE_BATCH_REQUEST_LIMIT = 100;');
    expect(source).toContain('interface NewsSourceBatchFetchResponse');
    expect(source).toContain('interface NewsSourcePrimeFeedback');
    expect(source).toContain('index += NEWS_SOURCE_BATCH_REQUEST_LIMIT');
    expect(source).toContain('"/news-aggregator/sources/batch?latest=1"');
    expect(source).toContain('for (const error of data.errors ?? []) {');
    expect(source).toContain('shouldMarkNewsSourceBatchUnsupported(error)');
    expect(source).toContain("forceRefresh: options?.force");
    expect(source).toContain("message: 'Source does not support batch refresh'");
    expect(source).not.toContain('for (const sourceId of missingSourceIds) {');
  });
});
