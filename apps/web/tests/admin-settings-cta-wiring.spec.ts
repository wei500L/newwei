import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('admin settings CTA wiring', () => {
  it('routes empty events states to the grouped news settings page', () => {
    const source = read('app/(app)/events/events-content.tsx');

    expect(source).toContain('buildAdminSettingsHref({');
    expect(source).toContain('page: "news"');
    expect(source).toContain('panel: "news-events"');
    expect(source).not.toContain('/admin/system?tab=');
  });

  it('routes news indicator actions to the grouped news settings page', () => {
    const source = read('app/(app)/finance/news-indicator-associations.tsx');

    expect(source).toContain('buildAdminSettingsHref({');
    expect(source).toContain('page: "news"');
    expect(source).toContain('panel: "news-indicator"');
    expect(source).not.toContain('/settings/system?tab=');
  });

  it('routes runtime-secret recovery to the grouped ingestion settings page', () => {
    const source = read('app/(app)/newsnow/components/newsnow-card.tsx');

    expect(source).toContain('buildAdminSettingsHref({');
    expect(source).toContain('page: "ingestion"');
    expect(source).toContain('panel: "news-source-runtime-secrets"');
    expect(source).toContain('query: { sourceId: id }');
  });
});
