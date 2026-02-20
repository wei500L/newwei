import { describe, expect, it } from 'vitest';

import {
  ADMIN_GROUP_ORDER,
  canViewAdmin,
  filterVisibleAdminLinks,
  groupAdminLinksBySection,
  type AdminGroupKey,
  type AdminLinkPermission
} from '../app/(app)/admin/admin-content.utils';

interface AdminLinkFixture {
  key: string;
  group: AdminGroupKey;
  permission?: AdminLinkPermission;
}

const ADMIN_LINK_FIXTURES: AdminLinkFixture[] = [
  { key: 'ops', group: 'operations', permission: 'crawl.read' },
  { key: 'dashboards', group: 'operations', permission: 'dashboards.write' },
  { key: 'alerts', group: 'operations', permission: 'alerts.manage' },
  { key: 'errors', group: 'monitoring', permission: 'settings.manage' },
  { key: 'quality', group: 'monitoring', permission: 'settings.manage' },
  { key: 'knowledgeGraphReview', group: 'monitoring', permission: 'knowledgegraph.review' },
  { key: 'orgs', group: 'governance', permission: 'org.write' },
  { key: 'audit', group: 'governance', permission: 'settings.manage' },
  { key: 'settings', group: 'governance', permission: 'settings.manage' },
  { key: 'storage', group: 'platform', permission: 'settings.manage' },
  { key: 'system', group: 'platform', permission: 'settings.manage' }
];

describe('admin homepage permission filtering', () => {
  it('allows crawl.write to access crawl.read link entries', () => {
    const visible = filterVisibleAdminLinks(ADMIN_LINK_FIXTURES, ['crawl.write']);

    expect(visible.map((link) => link.key)).toContain('ops');
  });

  it('allows settings.manage to access knowledge graph review', () => {
    const visible = filterVisibleAdminLinks(ADMIN_LINK_FIXTURES, ['settings.manage']);

    expect(visible.map((link) => link.key)).toContain('knowledgeGraphReview');
  });

  it('returns no visible links for users without permissions', () => {
    const visible = filterVisibleAdminLinks(ADMIN_LINK_FIXTURES, []);

    expect(visible).toHaveLength(0);
  });

  it('keeps admin page gate compatible with existing permissions set', () => {
    expect(canViewAdmin(['users.write'])).toBe(true);
    expect(canViewAdmin(['unknown.permission'])).toBe(false);
  });
});

describe('admin homepage grouping', () => {
  it('distributes full-access links across four groups', () => {
    const visible = filterVisibleAdminLinks(ADMIN_LINK_FIXTURES, [
      'settings.manage',
      'knowledgegraph.review',
      'org.write',
      'users.write',
      'crawl.read',
      'crawl.write',
      'dashboards.write',
      'alerts.manage'
    ]);

    const grouped = groupAdminLinksBySection(visible);

    expect(visible).toHaveLength(11);
    expect(grouped.operations).toHaveLength(3);
    expect(grouped.monitoring).toHaveLength(3);
    expect(grouped.governance).toHaveLength(3);
    expect(grouped.platform).toHaveLength(2);
  });

  it('preserves canonical group order for rendering', () => {
    const visible = filterVisibleAdminLinks(ADMIN_LINK_FIXTURES, ['settings.manage']);
    const grouped = groupAdminLinksBySection(visible);
    const visibleGroupOrder = ADMIN_GROUP_ORDER.filter((group) => grouped[group].length > 0);

    expect(visibleGroupOrder).toEqual(['monitoring', 'governance', 'platform']);
  });

  it('returns all-empty groups when there are no visible links', () => {
    const grouped = groupAdminLinksBySection([] as AdminLinkFixture[]);

    expect(grouped.operations).toHaveLength(0);
    expect(grouped.monitoring).toHaveLength(0);
    expect(grouped.governance).toHaveLength(0);
    expect(grouped.platform).toHaveLength(0);
  });
});
