import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('crawl guard wiring', () => {
  it('replaces task drawer proxy inputs with explicit unsupported warnings', () => {
    const source = read('app/(app)/crawl/components/CreateCrawlTaskDrawer.tsx');

    expect(source).toContain('crawl.proxy.disabledTitle');
    expect(source).toContain('crawl.proxy.disabledDescription');
    expect(source).not.toContain('name="proxyUrl"');
    expect(source).not.toContain('name={["proxyConfig", "server"]}');
  });

  it('removes news source proxy controls and blocks legacy proxy json', () => {
    const source = read('app/(app)/admin/ops/news-sources/news-sources-content.tsx');

    expect(source).toContain('newsSources.crawl.proxyDisabledTitle');
    expect(source).toContain('findUnsupportedProxyIssues(');
    expect(source).not.toContain('name="crawlProxyMode"');
    expect(source).not.toContain('name="crawlProxyUrl"');
  });

  it('shows accepted vs selected diagnostics in frontier runs', () => {
    const source = read('app/(app)/admin/ops/crawl-frontier/crawl-frontier-console.tsx');

    expect(source).toContain('crawlFrontier.run.nativeAcceptedSelected');
    expect(source).toContain('selectedRunRootDiagnosis?.nativeAcceptedResults');
    expect(source).toContain('selectedRunRootDiagnosis?.nativeSelectedResults');
  });
});
