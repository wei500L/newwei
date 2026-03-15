import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';

import { RbacService } from './rbac.service';

const prismaMock = {
  permission: {
    findMany: jest.fn(),
  },
  role: {
    findMany: jest.fn(),
    create: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  rolePermission: {
    createMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  membership: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    update: jest.fn(),
  },
  membershipRole: {
    createMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  auditLog: {
    create: jest.fn(),
  },
  auditLogOutbox: {
    create: jest.fn(),
  },
} as unknown as any;

const actionRateLimitMock = {
  enforceRbacWrite: jest.fn(),
} as unknown as any;

const userAdminServiceMock = {
  assertActorIsOrgAdmin: jest.fn(),
  invalidateUsersWithRole: jest.fn(),
} as unknown as any;

describe('RbacService', () => {
  let service: RbacService;

  beforeEach(() => {
    jest.resetAllMocks();
    prismaMock.$transaction = jest
      .fn()
      .mockImplementation(async (handler: any) => handler(prismaMock));
    actionRateLimitMock.enforceRbacWrite = jest.fn().mockResolvedValue(true);
    userAdminServiceMock.assertActorIsOrgAdmin = jest.fn().mockResolvedValue({
      id: 'membership-actor',
      orgId: 'org-1',
      userId: 'admin-1',
      roleId: 'role-admin',
      role: {
        id: 'role-admin',
        name: 'admin',
        isSystem: true,
        permissions: [
          { permission: { id: 'perm-roles-write', name: 'roles.write' } },
          { permission: { id: 'perm-items-read', name: 'items.read' } },
          { permission: { id: 'perm-items-write', name: 'items.write' } },
          { permission: { id: 'perm-permissions-read', name: 'permissions.read' } },
        ],
      },
      roles: [],
    });
    userAdminServiceMock.invalidateUsersWithRole = jest.fn().mockResolvedValue(undefined);
    prismaMock.auditLog.create = jest.fn().mockResolvedValue(null);
    prismaMock.membership.findFirst = jest.fn().mockResolvedValue({
      id: 'membership-actor',
      orgId: 'org-1',
      userId: 'admin-1',
      roleId: 'role-actor',
      role: {
        permissions: [
          { permission: { id: 'perm-roles-write', name: 'roles.write' } },
          { permission: { id: 'perm-items-read', name: 'items.read' } },
          { permission: { id: 'perm-items-write', name: 'items.write' } },
          { permission: { id: 'perm-permissions-read', name: 'permissions.read' } },
        ],
      },
      roles: [],
    });
    prismaMock.role.findFirst = jest.fn().mockResolvedValue({
      id: 'role-9',
      name: 'operator',
      orgId: 'org-1',
      isSystem: false,
      permissions: [{ permission: { id: 'perm-items-read', name: 'items.read' } }],
    });
    service = new RbacService(prismaMock, actionRateLimitMock, userAdminServiceMock);
  });

  it('throws when permissions are missing on role creation', async () => {
    prismaMock.permission.findMany = jest.fn().mockResolvedValue([]);

    await expect(
      service.createRole('org-1', 'user-1', {
        name: 'role',
        description: 'desc',
        permissions: ['x'],
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('creates roles with permissions', async () => {
    prismaMock.permission.findMany = jest
      .fn()
      .mockResolvedValue([{ id: 'perm-1', name: 'items.read' }]);
    prismaMock.role.create = jest.fn().mockResolvedValue({ id: 'role-1', isSystem: false });
    prismaMock.role.findUnique = jest.fn().mockResolvedValue({
      id: 'role-1',
      name: 'analyst',
      isSystem: false,
      permissions: [],
    });

    const result = await service.createRole('org-1', 'user-1', {
      name: 'analyst',
      description: '',
      permissions: ['items.read'],
    });

    expect(result?.id).toBe('role-1');
    expect(userAdminServiceMock.assertActorIsOrgAdmin).toHaveBeenCalledWith(
      'org-1',
      'user-1',
    );
    expect(prismaMock.rolePermission.createMany).toHaveBeenCalled();
  });

  it('rejects reserved admin role names at the service layer', async () => {
    await expect(
      service.createRole('org-1', 'admin-1', {
        name: ' admin ',
        description: '',
        permissions: ['items.read'],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('maps duplicate role names to a conflict error', async () => {
    prismaMock.permission.findMany = jest
      .fn()
      .mockResolvedValue([{ id: 'perm-1', name: 'items.read' }]);
    prismaMock.role.create = jest.fn().mockRejectedValue({ code: 'P2002' });

    await expect(
      service.createRole('org-1', 'admin-1', {
        name: 'analyst',
        description: '',
        permissions: ['items.read'],
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('propagates RBAC rate limit violations', async () => {
    actionRateLimitMock.enforceRbacWrite = jest
      .fn()
      .mockRejectedValue(new TooManyRequestsException());

    await expect(
      service.createRole('org-1', 'admin-1', {
        name: 'ops',
        description: '',
        permissions: ['items.read'],
      }),
    ).rejects.toThrow(TooManyRequestsException);
  });

  it('resets assigned roles to a single role during compatibility assignment', async () => {
    prismaMock.membership.findUnique = jest.fn().mockResolvedValue({
      id: 'membership-1',
      orgId: 'org-1',
      userId: 'user-2',
      roleId: 'old-role',
      role: { id: 'old-role', name: 'editor', isSystem: false },
      roles: [{ role: { id: 'old-role', name: 'editor', isSystem: false } }],
    });
    prismaMock.membership.update = jest.fn().mockResolvedValue({ id: 'membership-1' });
    prismaMock.membership.findUniqueOrThrow = jest.fn().mockResolvedValue({
      id: 'membership-1',
      orgId: 'org-1',
      userId: 'user-2',
      roleId: 'role-9',
      user: {
        id: 'user-2',
        email: 'user@example.com',
        firstName: 'User',
        lastName: 'Two',
        isActive: true,
      },
      role: {
        id: 'role-9',
        name: 'operator',
        isSystem: false,
        permissions: [{ permission: { id: 'perm-items-read', name: 'items.read' } }],
      },
      roles: [
        {
          orgId: 'org-1',
          roleId: 'role-9',
          role: {
            id: 'role-9',
            name: 'operator',
            isSystem: false,
            permissions: [{ permission: { id: 'perm-items-read', name: 'items.read' } }],
          },
        },
      ],
    });

    await service.assignRole('org-1', 'admin-1', {
      userId: 'user-2',
      roleId: 'role-9',
    });

    expect(prismaMock.membership.update).toHaveBeenCalledWith({
      where: {
        userId_orgId: {
          userId: 'user-2',
          orgId: 'org-1',
        },
      },
      data: {
        roleId: 'role-9',
      },
    });
    expect(prismaMock.membershipRole.deleteMany).toHaveBeenCalledWith({
      where: { membershipId: 'membership-1' },
    });
    expect(prismaMock.membershipRole.createMany).toHaveBeenCalledWith({
      data: [{ membershipId: 'membership-1', roleId: 'role-9', orgId: 'org-1' }],
    });
  });

  it('rejects assigning roles to system administrators', async () => {
    prismaMock.membership.findUnique = jest.fn().mockResolvedValue({
      id: 'membership-1',
      orgId: 'org-1',
      userId: 'user-2',
      roleId: 'role-admin',
      role: { id: 'role-admin', name: 'admin', isSystem: true },
      roles: [{ role: { id: 'role-admin', name: 'admin', isSystem: true } }],
    });

    await expect(
      service.assignRole('org-1', 'admin-1', {
        userId: 'user-2',
        roleId: 'role-9',
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(prismaMock.membership.update).not.toHaveBeenCalled();
  });

  it('rejects creating roles with permissions outside actor scope', async () => {
    prismaMock.membership.findFirst = jest.fn().mockResolvedValue({
      id: 'membership-actor',
      orgId: 'org-1',
      userId: 'admin-1',
      roleId: 'role-actor',
      role: {
        permissions: [{ permission: { id: 'perm-roles-write', name: 'roles.write' } }],
      },
      roles: [],
    });
    prismaMock.permission.findMany = jest
      .fn()
      .mockResolvedValue([{ id: 'perm-1', name: 'items.write', description: '' }]);

    await expect(
      service.createRole('org-1', 'admin-1', {
        name: 'ops',
        description: 'ops role',
        permissions: ['items.write'],
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('updates role permissions and description', async () => {
    prismaMock.role.findFirst = jest.fn().mockResolvedValue({
      id: 'role-1',
      name: 'ops',
      isSystem: false,
      permissions: [{ permission: { id: 'perm-items-write', name: 'items.write' } }],
    });
    prismaMock.permission.findMany = jest
      .fn()
      .mockResolvedValue([{ id: 'perm-1', name: 'items.write', description: '' }]);
    prismaMock.role.update = jest.fn().mockResolvedValue({
      id: 'role-1',
      name: 'ops',
      description: 'manages items',
      isSystem: false,
      permissions: [{ permission: { id: 'perm-1', name: 'items.write', description: '' } }],
    });

    const result = await service.updateRole('org-1', 'admin-1', {
      id: 'role-1',
      description: 'manages items',
      permissions: ['items.write'],
    });

    expect(prismaMock.rolePermission.deleteMany).toHaveBeenCalledWith({
      where: { roleId: 'role-1' },
    });
    expect(userAdminServiceMock.invalidateUsersWithRole).toHaveBeenCalledWith(
      'org-1',
      'role-1',
    );
    expect(result?.permissions).toHaveLength(1);
  });

  it('rejects updates to system roles', async () => {
    prismaMock.role.findFirst = jest.fn().mockResolvedValue({
      id: 'role-1',
      name: 'admin',
      isSystem: true,
    });

    await expect(
      service.updateRole('org-1', 'admin-1', {
        id: 'role-1',
        description: 'locked',
        permissions: ['items.read'],
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('filters system roles when includeSystem is false', async () => {
    prismaMock.role.findMany = jest.fn().mockResolvedValue([]);
    await service.listRoles('org-1', { includeSystem: false });
    expect(prismaMock.role.findMany).toHaveBeenCalledWith({
      where: { orgId: 'org-1', isSystem: false },
      include: {
        permissions: {
          include: { permission: true },
        },
      },
      orderBy: { name: 'asc' },
    });
  });
});
