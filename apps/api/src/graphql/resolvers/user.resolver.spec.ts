import type { AuthService, AuthenticatedUser } from '../../modules/auth/auth.service';
import type { UserAdminService } from '../../modules/rbac/user-admin.service';

import { UsersResolver } from './user.resolver';

const sampleUser: AuthenticatedUser = {
  id: 'user-1',
  email: 'admin@example.com',
  firstName: 'Admin',
  lastName: 'User',
  orgId: 'org-1',
  primaryRoleId: 'role-1',
  roleIds: ['role-1'],
  permissions: ['users.read'],
  isActive: true,
  emailVerified: '2026-03-15T08:00:00.000Z',
  lastLoginAt: '2026-03-15T09:00:00.000Z',
};

describe('UsersResolver', () => {
  const authService = {
    getUserProfile: jest.fn().mockResolvedValue(sampleUser),
  } as unknown as AuthService;

  const userAdminService = {
    listUsers: jest.fn(),
    listUserLoginRecords: jest.fn(),
    updateMembershipRoles: jest.fn(),
    setUserActive: jest.fn(),
  } as unknown as UserAdminService;

  const resolver = new UsersResolver(authService, userAdminService);

  it('maps me query to authenticated user with management fields', async () => {
    const result = await resolver.me({ user: sampleUser } as any);

    expect(authService.getUserProfile).toHaveBeenCalledWith(
      sampleUser.id,
      sampleUser.orgId,
    );
    expect(result).toMatchObject({
      id: sampleUser.id,
      email: sampleUser.email,
      primaryRoleId: sampleUser.primaryRoleId,
      isActive: true,
    });
    expect(result.emailVerified).toEqual(new Date('2026-03-15T08:00:00.000Z'));
    expect(result.lastLoginAt).toEqual(new Date('2026-03-15T09:00:00.000Z'));
  });
});
