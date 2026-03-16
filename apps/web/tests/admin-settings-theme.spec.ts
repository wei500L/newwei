import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('admin settings dark theme styling', () => {
  it('uses shared nav surface classes instead of light-only tailwind colors', () => {
    const source = read('app/(app)/admin/settings/settings-workspace-layout.tsx');

    expect(source).toContain('settings-nav-button');
    expect(source).toContain('settings-nav-button__description');
    expect(source).not.toContain('bg-white/70');
    expect(source).not.toContain('text-slate-700');
    expect(source).not.toContain('text-slate-500');
    expect(source).not.toContain('hover:bg-slate-50');
  });

  it('uses shared section shell classes for settings panels and access sections', () => {
    const sectionContentSource = read(
      'app/(app)/admin/settings/settings-section-content.tsx',
    );
    const accessSettingsSource = read('components/settings/access-settings-content.tsx');

    expect(sectionContentSource).toContain('settings-section-shell');
    expect(sectionContentSource).toContain('settings-section-shell--active');
    expect(sectionContentSource).not.toContain('bg-white/75');

    expect(accessSettingsSource).toContain('settings-section-shell');
    expect(accessSettingsSource).toContain('settings-section-shell--active');
    expect(accessSettingsSource).not.toContain('bg-white/75');
  });

  it('defines dark-mode overrides for shared settings surfaces', () => {
    const source = read('app/globals.css');

    expect(source).toContain('.settings-nav-button');
    expect(source).toContain('.dark .settings-nav-button');
    expect(source).toContain('.settings-section-shell');
    expect(source).toContain('.dark .settings-section-shell');
    expect(source).toContain('.dark .settings-section-shell--active');
  });
});
