export type AdminGroupKey = 'operations' | 'monitoring' | 'governance' | 'platform';

export type AdminLinkPermission =
  | 'settings.manage'
  | 'knowledgegraph.review'
  | 'org.write'
  | 'users.write'
  | 'crawl.read'
  | 'crawl.write'
  | 'dashboards.write'
  | 'alerts.manage';

export interface AdminLinkBase {
  key: string;
  group: AdminGroupKey;
  permission?: AdminLinkPermission;
}

export const ADMIN_GROUP_ORDER: AdminGroupKey[] = [
  'operations',
  'monitoring',
  'governance',
  'platform'
];

export function canViewAdmin(permissions: string[]): boolean {
  return (
    permissions.includes('settings.manage') ||
    permissions.includes('knowledgegraph.review') ||
    permissions.includes('org.write') ||
    permissions.includes('users.write') ||
    permissions.includes('crawl.read') ||
    permissions.includes('crawl.write') ||
    permissions.includes('dashboards.write') ||
    permissions.includes('alerts.manage')
  );
}

export function isAdminLinkVisible(
  permission: AdminLinkPermission | undefined,
  permissions: string[]
): boolean {
  if (!permission) {
    return true;
  }

  if (permissions.includes(permission)) {
    return true;
  }

  if (permission === 'knowledgegraph.review' && permissions.includes('settings.manage')) {
    return true;
  }

  return permission === 'crawl.read' && permissions.includes('crawl.write');
}

export function filterVisibleAdminLinks<T extends { permission?: AdminLinkPermission }>(
  links: T[],
  permissions: string[]
): T[] {
  return links.filter((link) => isAdminLinkVisible(link.permission, permissions));
}

export function groupAdminLinksBySection<T extends { group: AdminGroupKey }>(
  links: T[]
): Record<AdminGroupKey, T[]> {
  const groupedLinks = {
    operations: [] as T[],
    monitoring: [] as T[],
    governance: [] as T[],
    platform: [] as T[]
  };

  for (const link of links) {
    groupedLinks[link.group].push(link);
  }

  return groupedLinks;
}
