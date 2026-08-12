/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, ForbiddenException } from "@nestjs/common";

import { OrgInviteService } from "./org-invite.service";

function createPrismaMock() {
  return {
    membership: {
      findUnique: jest.fn(),
    },
    role: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    orgInvite: {
      findMany: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  };
}

function createService(prisma: ReturnType<typeof createPrismaMock>) {
  return new OrgInviteService(prisma as any, { send: jest.fn() } as any);
}

const ACTOR_PERMISSIONS = [
  { permission: { name: "users.write" } },
  { permission: { name: "org.read" } },
];

describe("OrgInviteService.assertRolesAssignable", () => {
  it("rejects granting the system admin role (privilege escalation guard)", async () => {
    const prisma = createPrismaMock();
    prisma.membership.findUnique.mockResolvedValue({
      role: { permissions: ACTOR_PERMISSIONS },
      roles: [],
    });
    prisma.role.findMany.mockResolvedValue([
      {
        id: "role-admin",
        isSystem: true,
        name: "admin",
        permissions: [
          { permission: { name: "users.write" } },
          { permission: { name: "settings.manage" } },
        ],
      },
    ]);
    const service = createService(prisma);

    await expect(
      service.assertRolesAssignable("actor-1", "org-1", ["role-admin"]),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.role.findMany).toHaveBeenCalledWith({
      where: { orgId: "org-1", id: { in: ["role-admin"] } },
      include: {
        permissions: { include: { permission: true } },
      },
    });
  });

  it("rejects granting a role whose permissions exceed the actor's own scope", async () => {
    const prisma = createPrismaMock();
    prisma.membership.findUnique.mockResolvedValue({
      role: { permissions: ACTOR_PERMISSIONS },
      roles: [],
    });
    // A custom role with settings.manage which the actor does not hold.
    prisma.role.findMany.mockResolvedValue([
      {
        id: "role-power",
        isSystem: false,
        name: "power user",
        permissions: [{ permission: { name: "settings.manage" } }],
      },
    ]);
    const service = createService(prisma);

    await expect(
      service.assertRolesAssignable("actor-1", "org-1", ["role-power"]),
    ).rejects.toThrow(ForbiddenException);
  });

  it("allows granting roles fully contained in the actor's permission scope", async () => {
    const prisma = createPrismaMock();
    prisma.membership.findUnique.mockResolvedValue({
      role: { permissions: ACTOR_PERMISSIONS },
      roles: [],
    });
    prisma.role.findMany.mockResolvedValue([
      {
        id: "role-manager",
        isSystem: false,
        name: "manager",
        permissions: [{ permission: { name: "users.write" } }],
      },
    ]);
    const service = createService(prisma);

    await expect(
      service.assertRolesAssignable("actor-1", "org-1", ["role-manager"]),
    ).resolves.toBeUndefined();
  });

  it("rejects unknown roles", async () => {
    const prisma = createPrismaMock();
    prisma.membership.findUnique.mockResolvedValue({
      role: { permissions: ACTOR_PERMISSIONS },
      roles: [],
    });
    prisma.role.findMany.mockResolvedValue([]);
    const service = createService(prisma);

    await expect(
      service.assertRolesAssignable("actor-1", "org-1", ["role-missing"]),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects non-members as actors", async () => {
    const prisma = createPrismaMock();
    prisma.membership.findUnique.mockResolvedValue(null);
    const service = createService(prisma);

    await expect(
      service.assertRolesAssignable("outsider", "org-1", ["role-manager"]),
    ).rejects.toThrow(ForbiddenException);
  });
});
