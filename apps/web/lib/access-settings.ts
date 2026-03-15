export interface AccessSettingsPermission {
  id: string;
  name: string;
  description?: string | null;
}

export interface AccessSettingsRole {
  id: string;
  name: string;
  description?: string | null;
  isSystem: boolean;
  permissions: readonly AccessSettingsPermission[];
}

export interface AccessSettingsUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  primaryRoleId?: string | null;
  roleIds: readonly string[];
}

export type AccessSettingsReadOnlyReason = 'self' | 'admin' | null;

const SYSTEM_ADMIN_ROLE_NAME = 'admin';

export function getSystemAdminRoleIds(
  roles: readonly AccessSettingsRole[],
): string[] {
  return roles
    .filter(
      (role) => role.isSystem && role.name.toLowerCase() === SYSTEM_ADMIN_ROLE_NAME,
    )
    .map((role) => role.id);
}

export function getAssignableRoles(
  roles: readonly AccessSettingsRole[],
  adminRoleIds: readonly string[],
): AccessSettingsRole[] {
  return roles.filter((role) => !adminRoleIds.includes(role.id));
}

export function normalizeRoleSelection(
  primaryRoleId: string | null | undefined,
  roleIds: readonly string[],
): string[] {
  const normalizedRoleIds = Array.from(
    new Set(
      roleIds
        .map((roleId) => roleId.trim())
        .filter((roleId) => roleId.length > 0),
    ),
  );

  if (primaryRoleId && !normalizedRoleIds.includes(primaryRoleId)) {
    return [primaryRoleId, ...normalizedRoleIds];
  }

  return normalizedRoleIds;
}

export function getPermissionPreview(
  roleIds: readonly string[],
  roles: readonly AccessSettingsRole[],
): AccessSettingsPermission[] {
  const roleMap = new Map(roles.map((role) => [role.id, role]));
  const permissions = new Map<string, AccessSettingsPermission>();

  for (const roleId of normalizeRoleSelection(undefined, roleIds)) {
    const role = roleMap.get(roleId);
    if (!role) {
      continue;
    }

    for (const permission of role.permissions) {
      permissions.set(permission.name, permission);
    }
  }

  return Array.from(permissions.values()).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export function getUserDisplayName(user: Pick<AccessSettingsUser, 'firstName' | 'lastName' | 'email'>): string {
  const fullName = `${user.firstName} ${user.lastName}`.trim();
  return fullName || user.email;
}

export function getUserRoleNames(
  user: AccessSettingsUser,
  roles: readonly AccessSettingsRole[],
): string[] {
  const roleMap = new Map(roles.map((role) => [role.id, role.name]));

  return normalizeRoleSelection(user.primaryRoleId, user.roleIds)
    .map((roleId) => roleMap.get(roleId))
    .filter((roleName): roleName is string => typeof roleName === 'string');
}

export function getReadOnlyReason(
  user: AccessSettingsUser,
  adminRoleIds: readonly string[],
  actorId?: string | null,
): AccessSettingsReadOnlyReason {
  if (actorId && user.id === actorId) {
    return 'self';
  }

  const normalizedRoleIds = normalizeRoleSelection(user.primaryRoleId, user.roleIds);
  if (normalizedRoleIds.some((roleId) => adminRoleIds.includes(roleId))) {
    return 'admin';
  }

  return null;
}

export function isOrgAdminSession(
  actorRoleIds: readonly string[],
  adminRoleIds: readonly string[],
): boolean {
  return adminRoleIds.length > 0 && actorRoleIds.some((roleId) => adminRoleIds.includes(roleId));
}

export function canViewLoginHistory(
  readOnlyReason: AccessSettingsReadOnlyReason,
): boolean {
  return readOnlyReason === null;
}
