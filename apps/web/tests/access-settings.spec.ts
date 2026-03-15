import { describe, expect, it } from 'vitest';

import {
  canViewLoginHistory,
  getAssignableRoles,
  isOrgAdminSession,
  getPermissionPreview,
  getReadOnlyReason,
  getSystemAdminRoleIds,
  getUserRoleNames,
  normalizeRoleSelection,
} from '../lib/access-settings';

const roles = [
  {
    id: 'role-admin',
    name: 'Admin',
    description: 'System administrators',
    isSystem: true,
    permissions: [{ id: 'perm-users-read', name: 'users.read' }],
  },
  {
    id: 'role-analyst',
    name: 'Analyst',
    description: 'Analysts',
    isSystem: true,
    permissions: [
      { id: 'perm-users-read', name: 'users.read' },
      { id: 'perm-items-read', name: 'items.read' },
    ],
  },
  {
    id: 'role-ops',
    name: 'Ops',
    description: 'Operators',
    isSystem: false,
    permissions: [{ id: 'perm-rss-read', name: 'rss.read' }],
  },
] as const;

describe('access settings helpers', () => {
  it('detects system admin roles and excludes them from assignable options', () => {
    const adminRoleIds = getSystemAdminRoleIds([...roles]);

    expect(adminRoleIds).toEqual(['role-admin']);
    expect(getAssignableRoles([...roles], adminRoleIds).map((role) => role.id)).toEqual([
      'role-analyst',
      'role-ops',
    ]);
  });

  it('normalizes multi-role selections and keeps the primary role present', () => {
    expect(
      normalizeRoleSelection('role-ops', ['role-analyst', 'role-ops', 'role-ops']),
    ).toEqual(['role-analyst', 'role-ops']);
    expect(normalizeRoleSelection('role-ops', ['role-analyst'])).toEqual([
      'role-ops',
      'role-analyst',
    ]);
  });

  it('builds a unique permission preview and resolves user role names', () => {
    expect(
      getPermissionPreview(['role-ops', 'role-analyst'], [...roles]).map(
        (permission) => permission.name,
      ),
    ).toEqual(['items.read', 'rss.read', 'users.read']);

    expect(
      getUserRoleNames(
        {
          id: 'user-1',
          email: 'analyst@example.com',
          firstName: 'Ada',
          lastName: 'Lovelace',
          primaryRoleId: 'role-analyst',
          roleIds: ['role-ops', 'role-analyst'],
        },
        [...roles],
      ),
    ).toEqual(['Ops', 'Analyst']);
  });

  it('marks self and admin accounts as read-only targets', () => {
    const adminRoleIds = getSystemAdminRoleIds([...roles]);

    expect(
      getReadOnlyReason(
        {
          id: 'user-1',
          email: 'self@example.com',
          firstName: 'Self',
          lastName: 'User',
          primaryRoleId: 'role-admin',
          roleIds: ['role-admin'],
        },
        adminRoleIds,
        'user-1',
      ),
    ).toBe('self');

    expect(
      getReadOnlyReason(
        {
          id: 'user-2',
          email: 'admin@example.com',
          firstName: 'Org',
          lastName: 'Admin',
          primaryRoleId: 'role-admin',
          roleIds: ['role-admin'],
        },
        adminRoleIds,
        'user-1',
      ),
    ).toBe('admin');

    expect(
      getReadOnlyReason(
        {
          id: 'user-3',
          email: 'member@example.com',
          firstName: 'Team',
          lastName: 'Member',
          primaryRoleId: 'role-analyst',
          roleIds: ['role-analyst'],
        },
        adminRoleIds,
        'user-1',
      ),
    ).toBeNull();
  });

  it('fails closed when no protected admin role is present in the role list', () => {
    expect(isOrgAdminSession(['role-admin'], [])).toBe(false);
    expect(isOrgAdminSession(['role-admin'], ['role-admin'])).toBe(true);
  });

  it('blocks login-history actions for read-only targets', () => {
    expect(canViewLoginHistory(null)).toBe(true);
    expect(canViewLoginHistory('self')).toBe(false);
    expect(canViewLoginHistory('admin')).toBe(false);
  });
});
