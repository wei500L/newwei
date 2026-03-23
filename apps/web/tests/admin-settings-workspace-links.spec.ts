import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('admin settings workspace links', () => {
  it('renders sidebar domain navigation as direct links', () => {
    const source = read('app/(app)/admin/settings/settings-workspace-layout.tsx');

    expect(source).toContain("import Link from 'next/link';");
    expect(source).toContain('href="/admin/settings"');
    expect(source).toContain('href={resolveAdminSettingsPagePath(page.id)}');
    expect(source).not.toContain('onClick={() => router.push(\'/admin/settings\')}');
  });

  it('renders overview quick links and domain cards as single-link buttons', () => {
    const source = read('app/(app)/admin/settings/settings-overview-content.tsx');

    expect(source).toContain('const href = buildAdminSettingsHref({');
    expect(source).toContain('page: item.page');
    expect(source).toContain('panel: item.panel');
    expect(source).toContain('<Button type="link" className="!px-0" href={href}>');
    expect(source).toContain("const href = buildAdminSettingsHref({ page: page.id });");
    expect(source).toContain('<Button type="primary" href={href}>');
    expect(source).not.toContain('<Link href={buildAdminSettingsHref({ page: page.id })}>');
  });
});
