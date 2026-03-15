import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { UserAdminService } from './user-admin.service';

const prismaMock = {
  membership: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    findUniqueOrThrow: jest.fn(),
  },
  membershipRole: {
    deleteMany: jest.fn(),
    createMany: jest.fn(),
  },
  role: {
    findMany: jest.fn(),
  },
  user: {
    findMany: jest.fn(),
    update: jest.fn(),
  },
  auditLog: {
    findMany: jest.fn(),
    create: jest.fn(),
  },
} as unknown as any;

const actionRateLimitMock = {
  enforceRbacWrite: jest.fn(),
} as unknown as any;

const cacheMock = {
  del: jest.fn(),
} as unknown as any;

const actorMembership = {
  id: 'membership-admin',
  orgId: 'org-1',
  userId: 'admin-1',
  roleId: 'role-admin',
  isActive: true,
  user: {
    id: 'admin-1',
    email: 'admin@example.com',
    firstName: 'Admin',
    lastName: 'User',
    isActive: true,
  },
  role: {
    id: 'role-admin',
    name: 'admin',
    isSystem: true,
    permissions: [
      { permission: { name: 'users.write' } },
      { permission: { name: 'roles.write' } },
      { permission: { name: 'items.read' } },
      { permission: { name: 'items.write' } },
    ],
  },
  roles: [],
};

describe('UserAdminService', () => {
  let service: UserAdminService;

  beforeEach(() => {
    jest.resetAllMocks();
    prismaMock.$transaction = jest
      .fn()
      .mockImplementation(async (handler: (tx: typeof prismaMock) => unknown) =>
        handler(prismaMock),
      );
    actionRateLimitMock.enforceRbacWrite = jest.fn().mockResolvedValue(true);
    prismaMock.auditLog.create = jest.fn().mockResolvedValue(null);
    prismaMock.membership.findMany = jest.fn().mockResolvedValue([{ orgId: 'org-1' }]);
    cacheMock.del = jest.fn().mockResolvedValue(undefined);

    service = new UserAdminService(prismaMock, actionRateLimitMock, cacheMock);
  });

  it('rejects listing users for non-admin actors', async () => {
    prismaMock.membership.findUnique = jest.fn().mockResolvedValue({
      ...actorMembership,
      role: {
        ...actorMembership.role,
        name: 'manager',
        isSystem: false,
      },
    });

    await expect(service.listUsers('org-1', 'admin-1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('syncs membership roles exactly for manageable users', async () => {
    prismaMock.membership.findUnique = jest
      .fn()
      .mockResolvedValueOnce(actorMembership)
      .mockResolvedValueOnce({
        id: 'membership-user',
        orgId: 'org-1',
        userId: 'user-2',
        roleId: 'role-editor',
        isActive: true,
        user: {
          id: 'user-2',
          email: 'user@example.com',
          firstName: 'User',
          lastName: 'Two',
          isActive: true,
        },
        role: {
          id: 'role-editor',
          name: 'editor',
          isSystem: false,
          permissions: [{ permission: { name: 'items.read' } }],
        },
        roles: [],
      });
    prismaMock.role.findMany = jest.fn().mockResolvedValue([
      {
        id: 'role-editor',
        name: 'editor',
        isSystem: false,
        permissions: [{ permission: { name: 'items.read' } }],
      },
      {
        id: 'role-ops',
        name: 'ops',
        isSystem: false,
        permissions: [{ permission: { name: 'items.write' } }],
      },
    ]);
    prismaMock.membership.update = jest.fn().mockResolvedValue({ id: 'membership-user' });
    prismaMock.membership.findUniqueOrThrow = jest.fn().mockResolvedValue({
      id: 'membership-user',
      orgId: 'org-1',
      userId: 'user-2',
      roleId: 'role-editor',
      user: {
        id: 'user-2',
        email: 'user@example.com',
        firstName: 'User',
        lastName: 'Two',
        isActive: true,
      },
      role: {
        id: 'role-editor',
        name: 'editor',
        isSystem: false,
        permissions: [{ permission: { name: 'items.read' } }],
      },
      roles: [
        {
          roleId: 'role-editor',
          role: {
            id: 'role-editor',
            name: 'editor',
            isSystem: false,
            permissions: [{ permission: { name: 'items.read' } }],
          },
        },
        {
          roleId: 'role-ops',
          role: {
            id: 'role-ops',
            name: 'ops',
            isSystem: false,
            permissions: [{ permission: { name: 'items.write' } }],
          },
        },
      ],
    });

    const result = await service.updateMembershipRoles('org-1', 'admin-1', {
      userId: 'user-2',
      primaryRoleId: 'role-editor',
      roleIds: ['role-editor', 'role-ops'],
    });

    expect(prismaMock.membershipRole.deleteMany).toHaveBeenCalledWith({
      where: { membershipId: 'membership-user' },
    });
    expect(prismaMock.membershipRole.createMany).toHaveBeenCalledWith({
      data: [
        {
          membershipId: 'membership-user',
          orgId: 'org-1',
          roleId: 'role-editor',
        },
        {
          membershipId: 'membership-user',
          orgId: 'org-1',
          roleId: 'role-ops',
        },
      ],
    });
    expect(cacheMock.del).toHaveBeenCalledWith('profile:user-2:org-1');
    expect(result.roleId).toBe('role-editor');
  });

  it('rejects updating other admin users', async () => {
    prismaMock.membership.findUnique = jest
      .fn()
      .mockResolvedValueOnce(actorMembership)
      .mockResolvedValueOnce({
        id: 'membership-admin-2',
        orgId: 'org-1',
        userId: 'admin-2',
        roleId: 'role-admin',
        isActive: true,
        user: {
          id: 'admin-2',
          email: 'admin2@example.com',
          firstName: 'Admin',
          lastName: 'Two',
          isActive: true,
        },
        role: {
          id: 'role-admin',
          name: 'admin',
          isSystem: true,
          permissions: [{ permission: { name: 'users.write' } }],
        },
        roles: [],
      });

    await expect(
      service.updateMembershipRoles('org-1', 'admin-1', {
        userId: 'admin-2',
        primaryRoleId: 'role-admin',
        roleIds: ['role-admin'],
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects activating or disabling admin targets', async () => {
    prismaMock.membership.findUnique = jest
      .fn()
      .mockResolvedValueOnce(actorMembership)
      .mockResolvedValueOnce({
        id: 'membership-admin-2',
        orgId: 'org-1',
        userId: 'admin-2',
        roleId: 'role-admin',
        user: {
          id: 'admin-2',
          email: 'admin2@example.com',
          firstName: 'Admin',
          lastName: 'Two',
          isActive: true,
        },
        role: {
          id: 'role-admin',
          name: 'admin',
          isSystem: true,
          permissions: [{ permission: { name: 'users.write' } }],
        },
        roles: [],
      });

    await expect(service.setUserActive('org-1', 'admin-1', 'admin-2', false)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('updates membership status without changing the global user record', async () => {
    prismaMock.membership.findUnique = jest
      .fn()
      .mockResolvedValueOnce(actorMembership)
      .mockResolvedValueOnce({
        id: 'membership-user',
        orgId: 'org-1',
        userId: 'user-2',
        roleId: 'role-editor',
        isActive: true,
        user: {
          id: 'user-2',
          email: 'user@example.com',
          firstName: 'User',
          lastName: 'Two',
          isActive: true,
        },
        role: {
          id: 'role-editor',
          name: 'editor',
          isSystem: false,
          permissions: [{ permission: { name: 'items.read' } }],
        },
        roles: [],
      });
    prismaMock.membership.update = jest.fn().mockResolvedValue({
      id: 'membership-user',
      orgId: 'org-1',
      userId: 'user-2',
      roleId: 'role-editor',
      isActive: false,
      user: {
        id: 'user-2',
        email: 'user@example.com',
        firstName: 'User',
        lastName: 'Two',
        isActive: true,
      },
      role: {
        id: 'role-editor',
        name: 'editor',
        isSystem: false,
        permissions: [{ permission: { name: 'items.read' } }],
      },
      roles: [],
    });

    const result = await service.setUserActive('org-1', 'admin-1', 'user-2', false);

    expect(prismaMock.membership.update).toHaveBeenCalledWith({
      where: {
        userId_orgId: {
          userId: 'user-2',
          orgId: 'org-1',
        },
      },
      data: { isActive: false },
      include: expect.any(Object),
    });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(result.isActive).toBe(false);
  });

  it('maps login records from auth audit logs', async () => {
    prismaMock.membership.findUnique = jest
      .fn()
      .mockResolvedValueOnce(actorMembership)
      .mockResolvedValueOnce({
        id: 'membership-user',
        orgId: 'org-1',
        userId: 'user-2',
        roleId: 'role-editor',
        isActive: true,
        user: {
          id: 'user-2',
          email: 'user@example.com',
          firstName: 'User',
          lastName: 'Two',
          isActive: true,
        },
        role: {
          id: 'role-editor',
          name: 'editor',
          isSystem: false,
          permissions: [{ permission: { name: 'items.read' } }],
        },
        roles: [],
      });
    prismaMock.auditLog.findMany = jest.fn().mockResolvedValue([
      {
        id: 'log-1',
        action: 'login',
        ipAddress: '127.0.0.1',
        metadata: { userAgent: 'Mozilla/5.0' },
        createdAt: new Date('2026-03-15T03:00:00.000Z'),
      },
    ]);

    const rows = await service.listUserLoginRecords('org-1', 'admin-1', 'user-2');
    expect(rows).toEqual([
      {
        id: 'log-1',
        createdAt: new Date('2026-03-15T03:00:00.000Z'),
        ipAddress: '127.0.0.1',
        method: 'password',
        userAgent: 'Mozilla/5.0',
      },
    ]);
  });

  it('throws when the target user is not in the org', async () => {
    prismaMock.membership.findUnique = jest
      .fn()
      .mockResolvedValueOnce(actorMembership)
      .mockResolvedValueOnce(null);

    await expect(service.listUserLoginRecords('org-1', 'admin-1', 'user-404')).rejects.toThrow(
      NotFoundException,
    );
  });
});
