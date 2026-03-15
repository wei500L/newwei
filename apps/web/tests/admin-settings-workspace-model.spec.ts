import { describe, expect, it } from 'vitest';

import {
  getAdminSettingsFeaturedLinks,
  getAdminSettingsPageCards,
  resolveAdminSettingsSectionState,
} from '../app/(app)/admin/settings/settings-workspace-model';

describe('admin settings workspace model', () => {
  it('returns the canonical quick links for full settings managers', () => {
    expect(
      getAdminSettingsFeaturedLinks(['settings.manage']).map((item) => item.panel),
    ).toEqual([
      'crawl-client',
      'news-source-runtime-secrets',
      'news-indicator',
      'knowledge-graph-review',
    ]);
  });

  it('limits quick links and domain cards for review-only users', () => {
    expect(
      getAdminSettingsFeaturedLinks(['knowledgegraph.review']).map(
        (item) => item.panel,
      ),
    ).toEqual(['knowledge-graph-review']);

    const pageCards = getAdminSettingsPageCards(['knowledgegraph.review']);

    expect(pageCards).toHaveLength(1);
    expect(pageCards[0]?.page.id).toBe('knowledge');
    expect(pageCards[0]?.panels.map((panel) => panel.id)).toEqual([
      'knowledge-graph-review',
    ]);
  });

  it('selects only panels that are visible on the current page', () => {
    const state = resolveAdminSettingsSectionState({
      pageId: 'security',
      permissions: ['settings.manage'],
      panelId: 'rate-limits',
    });

    expect(state.page.id).toBe('security');
    expect(state.selectedPanelId).toBe('rate-limits');
    expect(state.visiblePanels.map((panel) => panel.id)).toEqual([
      'security',
      'auth-cache',
      'rate-limits',
      'rate-limit-policies',
      'audit-log',
    ]);
  });

  it('drops hidden or invalid panel selections instead of forcing the wrong panel', () => {
    expect(
      resolveAdminSettingsSectionState({
        pageId: 'knowledge',
        permissions: ['knowledgegraph.review'],
        panelId: 'knowledge-graph',
      }).selectedPanelId,
    ).toBeNull();

    expect(
      resolveAdminSettingsSectionState({
        pageId: 'knowledge',
        permissions: ['knowledgegraph.review'],
        panelId: 'does-not-exist',
      }).selectedPanelId,
    ).toBeNull();
  });
});
