'use client';

import {
  getAdminSettingsPageDefinition,
  getVisibleAdminSettingsPages,
  getVisibleAdminSettingsPanels,
  resolveVisibleAdminSettingsPanelId,
  type AdminSettingsPageDefinition,
  type AdminSettingsPageId,
  type AdminSettingsPanelDefinition,
  type AdminSettingsPanelId,
} from './settings-navigation';

export interface AdminSettingsFeaturedLinkDefinition {
  page: AdminSettingsPageId;
  panel: AdminSettingsPanelId;
}

export interface AdminSettingsVisibleFeaturedLink
  extends AdminSettingsFeaturedLinkDefinition {
  panelDefinition: AdminSettingsPanelDefinition;
}

export interface AdminSettingsPageCardDefinition {
  page: AdminSettingsPageDefinition;
  panels: AdminSettingsPanelDefinition[];
}

export interface ResolveAdminSettingsSectionStateOptions {
  pageId: AdminSettingsPageId;
  permissions: readonly string[];
  panelId: string | null;
}

export interface AdminSettingsSectionState {
  page: AdminSettingsPageDefinition;
  visiblePanels: AdminSettingsPanelDefinition[];
  selectedPanelId: AdminSettingsPanelId | null;
}

export const ADMIN_SETTINGS_FEATURED_LINKS: readonly AdminSettingsFeaturedLinkDefinition[] =
  [
    {
      page: 'ingestion',
      panel: 'crawl-client',
    },
    {
      page: 'ingestion',
      panel: 'news-source-runtime-secrets',
    },
    {
      page: 'news',
      panel: 'news-indicator',
    },
    {
      page: 'knowledge',
      panel: 'knowledge-graph-review',
    },
  ] as const;

export function getAdminSettingsPageCards(
  permissions: readonly string[],
): AdminSettingsPageCardDefinition[] {
  return getVisibleAdminSettingsPages(permissions).map((page) => ({
    page,
    panels: getVisibleAdminSettingsPanels(page.id, permissions),
  }));
}

export function getAdminSettingsFeaturedLinks(
  permissions: readonly string[],
): AdminSettingsVisibleFeaturedLink[] {
  return ADMIN_SETTINGS_FEATURED_LINKS.flatMap((item) => {
    const panelDefinition = getVisibleAdminSettingsPanels(
      item.page,
      permissions,
    ).find((panel) => panel.id === item.panel);

    if (!panelDefinition) {
      return [];
    }

    return [
      {
        ...item,
        panelDefinition,
      },
    ];
  });
}

export function resolveAdminSettingsSectionState({
  pageId,
  permissions,
  panelId,
}: ResolveAdminSettingsSectionStateOptions): AdminSettingsSectionState {
  const page = getAdminSettingsPageDefinition(pageId);
  const visiblePanels = getVisibleAdminSettingsPanels(pageId, permissions);

  return {
    page,
    visiblePanels,
    selectedPanelId: resolveVisibleAdminSettingsPanelId(panelId, visiblePanels),
  };
}
