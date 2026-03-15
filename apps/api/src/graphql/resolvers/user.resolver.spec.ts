import type {
  AuthService,
  AuthenticatedUser,
} from "../../modules/auth/auth.service";
import type { UserAdminService } from "../../modules/rbac/user-admin.service";

import { UsersResolver } from "./user.resolver";

const sampleUser: AuthenticatedUser = {
  id: "user-1",
  email: "admin@example.com",
  firstName: "Admin",
  lastName: "User",
  orgId: "org-1",
  primaryRoleId: "role-1",
  roleIds: ["role-1"],
  permissions: ["users.read"],
  isActive: true,
  emailVerified: "2026-03-15T08:00:00.000Z",
  lastLoginAt: "2026-03-15T09:00:00.000Z",
};

describe("UsersResolver", () => {
  const authService = {
    getUserProfile: jest.fn(),
  } as unknown as AuthService;

  const userAdminService = {
    listUsers: jest.fn(),
    listUserLoginRecords: jest.fn(),
    updateMembershipRoles: jest.fn(),
    setUserActive: jest.fn(),
  } as unknown as UserAdminService;

  const resolver = new UsersResolver(authService, userAdminService);

  beforeEach(() => {
    jest.clearAllMocks();
    (authService.getUserProfile as jest.Mock).mockResolvedValue(sampleUser);
  });

  it("maps me query to authenticated user with management fields", async () => {
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
    expect(result.emailVerified).toEqual(new Date("2026-03-15T08:00:00.000Z"));
    expect(result.lastLoginAt).toEqual(new Date("2026-03-15T09:00:00.000Z"));
  });

  it("reports listed users as inactive when the global account is disabled", async () => {
    (userAdminService.listUsers as jest.Mock).mockResolvedValue([
      {
        id: "user-2",
        email: "user@example.com",
        firstName: "User",
        lastName: "Two",
        isActive: false,
        memberships: [
          {
            orgId: "org-1",
            roleId: "role-2",
            isActive: true,
            role: {
              id: "role-2",
              permissions: [{ permission: { name: "users.read" } }],
            },
            roles: [],
          },
        ],
      },
    ]);

    const result = await resolver.users({ user: sampleUser } as any);

    expect(result).toHaveLength(1);
    expect(result[0].isActive).toBe(false);
  });

  it("reports updated memberships as inactive when the global account is disabled", async () => {
    (userAdminService.updateMembershipRoles as jest.Mock).mockResolvedValue({
      orgId: "org-1",
      userId: "user-2",
      roleId: "role-2",
      isActive: true,
      user: {
        id: "user-2",
        email: "user@example.com",
        firstName: "User",
        lastName: "Two",
        isActive: false,
        emailVerified: null,
        lastLoginAt: null,
      },
      role: {
        id: "role-2",
        permissions: [{ permission: { name: "users.read" } }],
      },
      roles: [],
    });

    const result = await resolver.updateMembershipRoles(
      { user: sampleUser } as any,
      {
        userId: "user-2",
        primaryRoleId: "role-2",
        roleIds: ["role-2"],
      },
    );

    expect(result.isActive).toBe(false);
  });
});
