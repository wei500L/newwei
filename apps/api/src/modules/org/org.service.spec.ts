import { ForbiddenException } from "@nestjs/common";
import { CORE_PERMISSIONS, DEFAULT_ROLES } from "@modular/config";
import { OrgService } from "./org.service";

const prismaMock = {
  membership: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn()
  },
  org: {
    create: jest.fn(),
    update: jest.fn()
  },
  permission: {
    upsert: jest.fn(),
    findMany: jest.fn()
  },
  role: {
    create: jest.fn(),
    findFirstOrThrow: jest.fn()
  },
  rolePermission: {
    createMany: jest.fn()
  },
  auditLog: {
    create: jest.fn()
  },
  $transaction: jest.fn()
} as unknown as any;

describe("OrgService", () => {
  let service: OrgService;

  beforeEach(() => {
    jest.resetAllMocks();
    prismaMock.$transaction = jest.fn().mockImplementation(async (handler: any) => handler(prismaMock));
    service = new OrgService(prismaMock);
  });

  it("lists organizations for a user", async () => {
    prismaMock.membership.findMany = jest.fn().mockResolvedValue([
      {
        orgId: "org-1",
        org: {
          id: "org-1",
          name: "Acme",
          slug: "acme",
          description: null,
          isActive: true,
          createdAt: new Date("2024-01-01T00:00:00.000Z"),
          updatedAt: new Date("2024-01-02T00:00:00.000Z")
        }
      },
      {
        orgId: "org-1",
        org: {
          id: "org-1",
          name: "Acme",
          slug: "acme",
          description: null,
          isActive: true,
          createdAt: new Date("2024-01-01T00:00:00.000Z"),
          updatedAt: new Date("2024-01-02T00:00:00.000Z")
        }
      }
    ]);

    const orgs = await service.listOrganizationsForUser("user-1");
    expect(orgs).toHaveLength(1);
    expect(orgs[0]?.id).toBe("org-1");
  });

  it("creates a new organization with default roles and membership", async () => {
    prismaMock.org.create = jest.fn().mockResolvedValue({
      id: "org-new",
      name: "New Org",
      slug: "new-org",
      description: null,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    prismaMock.permission.findMany = jest.fn().mockResolvedValue(
      CORE_PERMISSIONS.map((name) => ({ id: `perm-${name}`, name }))
    );

    prismaMock.role.create = jest.fn().mockImplementation(async ({ data }: any) => ({
      id: `role-${data.name}`,
      ...data
    }));

    prismaMock.rolePermission.createMany = jest.fn().mockResolvedValue({ count: 1 });
    prismaMock.role.findFirstOrThrow = jest.fn().mockResolvedValue({ id: "role-admin" });
    prismaMock.membership.create = jest.fn().mockResolvedValue({ id: "membership-1" });

    const created = await service.createOrg("user-1", {
      name: "New Org",
      slug: "new-org",
      description: "hello"
    });

    expect(created.id).toBe("org-new");
    expect(prismaMock.role.create).toHaveBeenCalledTimes(DEFAULT_ROLES.length);
    expect(prismaMock.membership.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        orgId: "org-new",
        roleId: "role-admin"
      }
    });
    expect(prismaMock.auditLog.create).toHaveBeenCalled();
  });

  it("rejects updates when actor is not a member", async () => {
    prismaMock.membership.findUnique = jest.fn().mockResolvedValue(null);
    await expect(service.updateOrg("user-1", { id: "org-1", name: "x" })).rejects.toThrow(
      ForbiddenException
    );
  });
});

