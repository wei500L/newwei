import {
  CORE_PERMISSION_DEFINITIONS,
  DEFAULT_ROLES,
  getCorePermissionDefinition,
  getDefaultRoleDefinition,
  shouldBackfillDefaultDescription,
} from "@modular/config";

interface PermissionRecord {
  id: string;
  name: string;
  description: string | null;
}

interface RoleRecord {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
}

interface RbacDescriptionBackfillClient {
  permission: {
    findMany: (args: {
      where: { name: { in: string[] } };
      select: { id: true; name: true; description: true };
    }) => Promise<PermissionRecord[]>;
    update: (args: {
      where: { id: string };
      data: { description: string };
    }) => Promise<unknown>;
  };
  role: {
    findMany: (args: {
      where: { isSystem: true; name: { in: string[] } };
      select: { id: true; name: true; description: true; isSystem: true };
    }) => Promise<RoleRecord[]>;
    update: (args: {
      where: { id: string };
      data: { description: string };
    }) => Promise<unknown>;
  };
}

export interface RbacDescriptionBackfillResult {
  updatedPermissions: number;
  updatedRoles: number;
}

export async function backfillRbacDefaultDescriptions(
  client: RbacDescriptionBackfillClient,
): Promise<RbacDescriptionBackfillResult> {
  const permissionNames = CORE_PERMISSION_DEFINITIONS.map(
    (definition) => definition.name,
  );
  const roleNames = DEFAULT_ROLES.map((definition) => definition.name);

  const permissions = await client.permission.findMany({
    where: { name: { in: permissionNames } },
    select: { id: true, name: true, description: true },
  });

  let updatedPermissions = 0;
  for (const permission of permissions) {
    const definition = getCorePermissionDefinition(permission.name);
    if (!definition) {
      continue;
    }

    if (!shouldBackfillDefaultDescription(permission.description, definition)) {
      continue;
    }

    await client.permission.update({
      where: { id: permission.id },
      data: { description: definition.description },
    });
    updatedPermissions += 1;
  }

  const roles = await client.role.findMany({
    where: { isSystem: true, name: { in: roleNames } },
    select: { id: true, name: true, description: true, isSystem: true },
  });

  let updatedRoles = 0;
  for (const role of roles) {
    const definition = getDefaultRoleDefinition(role.name);
    if (!definition) {
      continue;
    }

    if (!shouldBackfillDefaultDescription(role.description, definition)) {
      continue;
    }

    await client.role.update({
      where: { id: role.id },
      data: { description: definition.description },
    });
    updatedRoles += 1;
  }

  return {
    updatedPermissions,
    updatedRoles,
  };
}
