import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import type { RbacService } from "../../modules/rbac/rbac.service";

import { RbacResolver } from "./rbac.resolver";

const sampleUser: AuthenticatedUser = {
  id: "admin-1",
  email: "admin@example.com",
  firstName: "Admin",
  lastName: "User",
  orgId: "org-1",
  primaryRoleId: "role-admin",
  roleIds: ["role-admin"],
  permissions: ["users.read", "roles.read"],
  isActive: true,
};

describe("RbacResolver", () => {
  const rbacService = {
    listMembers: jest.fn(),
  } as unknown as RbacService;

  const resolver = new RbacResolver(rbacService);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("maps membership users as inactive when the global account is disabled", async () => {
    (rbacService.listMembers as jest.Mock).mockResolvedValue([
      {
        id: "membership-1",
        orgId: "org-1",
        userId: "user-2",
        roleId: "role-2",
        isActive: true,
        role: {
          id: "role-2",
          name: "editor",
          isSystem: false,
          permissions: [{ permission: { id: "perm-1", name: "users.read" } }],
        },
        roles: [],
        user: {
          id: "user-2",
          email: "user@example.com",
          firstName: "User",
          lastName: "Two",
          isActive: false,
          emailVerified: null,
          lastLoginAt: null,
        },
      },
    ]);

    const result = await resolver.memberships({ user: sampleUser } as any);

    expect(result).toHaveLength(1);
    expect(result[0].user.isActive).toBe(false);
  });
});
