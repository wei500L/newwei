import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { RbacService } from "./rbac.service";
import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";

const prismaMock = {
  permission: {
    findMany: jest.fn()
  },
  role: {
    findMany: jest.fn(),
    create: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn()
  },
  rolePermission: {
    createMany: jest.fn(),
    deleteMany: jest.fn()
  },
  membership: {
    findFirst: jest.fn(),
    upsert: jest.fn(),
    findMany: jest.fn()
  }
} as unknown as any;

const actionRateLimitMock = {
  enforceRbacWrite: jest.fn()
} as unknown as any;

describe("RbacService", () => {
  let service: RbacService;

  beforeEach(() => {
    jest.resetAllMocks();
    prismaMock.$transaction = jest
      .fn()
      .mockImplementation(async (handler: any) =>
        handler({
          permission: prismaMock.permission,
          role: prismaMock.role,
          rolePermission: prismaMock.rolePermission
        })
      );
    actionRateLimitMock.enforceRbacWrite = jest.fn().mockResolvedValue(true);
    prismaMock.membership.findFirst = jest.fn().mockResolvedValue({
      id: "membership-actor",
      orgId: "org-1",
      userId: "admin-1",
      roleId: "role-actor",
      role: {
        permissions: [
          { permission: { id: "perm-roles-write", name: "roles.write" } },
          { permission: { id: "perm-items-read", name: "items.read" } },
          { permission: { id: "perm-items-write", name: "items.write" } },
          { permission: { id: "perm-permissions-read", name: "permissions.read" } }
        ]
      }
    });
    prismaMock.role.findFirst = jest.fn().mockResolvedValue({
      id: "role-9",
      name: "admin",
      orgId: "org-1",
      isSystem: false,
      permissions: [{ permission: { id: "perm-items-read", name: "items.read" } }]
    });
    service = new RbacService(prismaMock, actionRateLimitMock);
  });

  it("throws when permissions missing on role creation", async () => {
    prismaMock.permission.findMany = jest.fn().mockResolvedValue([]);

    await expect(
      service.createRole("org-1", "user-1", { name: "role", description: "desc", permissions: ["x"] })
    ).rejects.toThrow(NotFoundException);
  });

  it("creates roles with permissions", async () => {
    prismaMock.permission.findMany = jest
      .fn()
      .mockResolvedValue([{ id: "perm-1", name: "items.read" }]);
    prismaMock.role.create = jest.fn().mockResolvedValue({ id: "role-1", isSystem: false });
    prismaMock.rolePermission.createMany = jest.fn();
    prismaMock.role.findUnique = jest.fn().mockResolvedValue({
      id: "role-1",
      name: "analyst",
      isSystem: false,
      permissions: []
    });

    const result = await service.createRole("org-1", "user-1", {
      name: "analyst",
      description: "",
      permissions: ["items.read"]
    });

    expect(result?.id).toBe("role-1");
    expect(prismaMock.rolePermission.createMany).toHaveBeenCalled();
    expect(prismaMock.role.create).toHaveBeenCalledWith({
      data: {
        name: "analyst",
        description: "",
        orgId: "org-1",
        isSystem: false
      }
    });
  });

  it("propagates RBAC rate limit violations", async () => {
    actionRateLimitMock.enforceRbacWrite = jest
      .fn()
      .mockRejectedValue(new TooManyRequestsException());

    await expect(
      service.createRole("org-1", "admin-1", {
        name: "ops",
        description: "",
        permissions: ["items.read"]
      })
    ).rejects.toThrow(TooManyRequestsException);
  });

  it("enforces rate limit on role assignments", async () => {
    prismaMock.membership.upsert = jest.fn().mockResolvedValue({ id: "membership-1" });
    await service.assignRole("org-1", "admin-1", { userId: "user-2", roleId: "role-9" });
    expect(actionRateLimitMock.enforceRbacWrite).toHaveBeenCalledWith("org-1", "admin-1");
    expect(prismaMock.role.findFirst).toHaveBeenCalledWith({
      where: { id: "role-9", orgId: "org-1" },
      include: {
        permissions: {
          include: { permission: true }
        }
      }
    });
    expect(prismaMock.membership.upsert).toHaveBeenCalled();
  });

  it("rejects assigning roles outside the organization", async () => {
    prismaMock.role.findFirst = jest.fn().mockResolvedValue(null);

    await expect(
      service.assignRole("org-1", "admin-1", { userId: "user-2", roleId: "foreign-role" })
    ).rejects.toThrow(NotFoundException);
    expect(prismaMock.membership.upsert).not.toHaveBeenCalled();
  });

  it("rejects assigning roles that exceed actor permissions", async () => {
    prismaMock.membership.findFirst = jest.fn().mockResolvedValue({
      id: "membership-actor",
      orgId: "org-1",
      userId: "admin-1",
      roleId: "role-actor",
      role: {
        permissions: [{ permission: { id: "perm-roles-write", name: "roles.write" } }]
      }
    });
    prismaMock.role.findFirst = jest.fn().mockResolvedValue({
      id: "role-1",
      name: "admin",
      orgId: "org-1",
      isSystem: false,
      permissions: [{ permission: { id: "perm-items-write", name: "items.write" } }]
    });

    await expect(
      service.assignRole("org-1", "admin-1", { userId: "user-2", roleId: "role-1" })
    ).rejects.toThrow(ForbiddenException);
    expect(prismaMock.membership.upsert).not.toHaveBeenCalled();
  });

  it("rejects creating roles with permissions outside actor scope", async () => {
    prismaMock.membership.findFirst = jest.fn().mockResolvedValue({
      id: "membership-actor",
      orgId: "org-1",
      userId: "admin-1",
      roleId: "role-actor",
      role: {
        permissions: [{ permission: { id: "perm-roles-write", name: "roles.write" } }]
      }
    });
    prismaMock.permission.findMany = jest
      .fn()
      .mockResolvedValue([{ id: "perm-1", name: "items.write", description: "" }]);

    await expect(
      service.createRole("org-1", "admin-1", {
        name: "ops",
        description: "ops role",
        permissions: ["items.write"]
      })
    ).rejects.toThrow(ForbiddenException);
  });

  it("updates role permissions and description", async () => {
    prismaMock.role.findFirst = jest.fn().mockResolvedValue({
      id: "role-1",
      name: "ops",
      isSystem: false,
      permissions: [{ permission: { id: "perm-items-write", name: "items.write" } }]
    });
    prismaMock.permission.findMany = jest
      .fn()
      .mockResolvedValue([{ id: "perm-1", name: "items.write", description: "" }]);
    prismaMock.rolePermission.deleteMany = jest.fn();
    prismaMock.rolePermission.createMany = jest.fn();
    prismaMock.role.update = jest.fn().mockResolvedValue({
      id: "role-1",
      name: "ops",
      description: "manages items",
      isSystem: false,
      permissions: [{ permission: { id: "perm-1", name: "items.write", description: "" } }]
    });

    const result = await service.updateRole("org-1", "admin-1", {
      id: "role-1",
      description: "manages items",
      permissions: ["items.write"]
    });

    expect(actionRateLimitMock.enforceRbacWrite).toHaveBeenCalledWith("org-1", "admin-1");
    expect(prismaMock.rolePermission.deleteMany).toHaveBeenCalledWith({ where: { roleId: "role-1" } });
    expect(prismaMock.rolePermission.createMany).toHaveBeenCalled();
    expect(prismaMock.role.update).toHaveBeenCalled();
    expect(result?.permissions).toHaveLength(1);
  });

  it("rejects updating roles that carry permissions the actor lacks", async () => {
    prismaMock.membership.findFirst = jest.fn().mockResolvedValue({
      id: "membership-actor",
      orgId: "org-1",
      userId: "admin-1",
      roleId: "role-actor",
      role: {
        permissions: [{ permission: { id: "perm-roles-write", name: "roles.write" } }]
      }
    });
    prismaMock.role.findFirst = jest.fn().mockResolvedValue({
      id: "role-1",
      name: "ops",
      isSystem: false,
      permissions: [{ permission: { id: "perm-items-write", name: "items.write" } }]
    });
    prismaMock.permission.findMany = jest
      .fn()
      .mockResolvedValue([{ id: "perm-1", name: "items.write", description: "" }]);

    await expect(
      service.updateRole("org-1", "admin-1", {
        id: "role-1",
        description: "manages items",
        permissions: ["items.write"]
      })
    ).rejects.toThrow(ForbiddenException);
    expect(prismaMock.rolePermission.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects updates to system roles", async () => {
    prismaMock.role.findFirst = jest.fn().mockResolvedValue({
      id: "role-1",
      name: "admin",
      isSystem: true
    });

    await expect(
      service.updateRole("org-1", "admin-1", { id: "role-1", description: "locked", permissions: ["items.read"] })
    ).rejects.toThrow(ForbiddenException);
  });

  it("filters system roles when includeSystem is false", async () => {
    prismaMock.role.findMany = jest.fn().mockResolvedValue([]);
    await service.listRoles("org-1", { includeSystem: false });
    expect(prismaMock.role.findMany).toHaveBeenCalledWith({
      where: { orgId: "org-1", isSystem: false },
      include: {
        permissions: {
          include: { permission: true }
        }
      },
      orderBy: { name: "asc" }
    });
  });
});
