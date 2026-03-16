export interface MembershipPermissionEntry {
  permission?: { name?: string | null } | null;
}

export interface MembershipRoleWithPermissions {
  permissions?: Array<MembershipPermissionEntry | null> | null;
}

export interface MembershipRoleLink<TRole = unknown> {
  roleId?: string | null;
  role?: TRole | null;
}

export interface MembershipWithRoles<TRole = unknown> {
  roleId?: string | null;
  role?: TRole | null;
  roles?: Array<MembershipRoleLink<TRole> | null> | null;
}

export const collectMembershipRoles = <TRole>(
  membership: MembershipWithRoles<TRole> | null | undefined,
): TRole[] => {
  const roles: TRole[] = [];

  for (const link of Array.isArray(membership?.roles) ? membership.roles : []) {
    if (link?.role) {
      roles.push(link.role);
    }
  }

  if (roles.length === 0 && membership?.role) {
    roles.push(membership.role);
  }

  return roles;
};

export const collectMembershipRoleIds = <TRole>(
  membership: MembershipWithRoles<TRole> | null | undefined,
): string[] => {
  const roleIds = new Set<string>();
  const roleLinks = Array.isArray(membership?.roles) ? membership.roles : [];

  if (roleLinks.length > 0) {
    for (const link of roleLinks) {
      if (typeof link?.roleId === "string") {
        roleIds.add(link.roleId);
      }
    }
  } else if (typeof membership?.roleId === "string") {
    roleIds.add(membership.roleId);
  }

  return Array.from(roleIds);
};

export const collectMembershipPermissionSet = <
  TRole extends MembershipRoleWithPermissions,
>(
  membership: MembershipWithRoles<TRole> | null | undefined,
): Set<string> => {
  const permissions = new Set<string>();

  for (const role of collectMembershipRoles(membership)) {
    const rolePermissions = Array.isArray(role.permissions) ? role.permissions : [];
    for (const rolePermission of rolePermissions) {
      const name = rolePermission?.permission?.name;
      if (typeof name === "string" && name.trim().length > 0) {
        permissions.add(name);
      }
    }
  }

  return permissions;
};

export const hasMembershipPermission = <
  TRole extends MembershipRoleWithPermissions,
>(
  membership: MembershipWithRoles<TRole> | null | undefined,
  permission: string,
): boolean => collectMembershipPermissionSet(membership).has(permission);
