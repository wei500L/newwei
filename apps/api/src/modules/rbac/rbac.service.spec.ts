import { NotFoundException } from "@nestjs/common";
import { RbacService } from "./rbac.service";
import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";

const prismaMock = {
  permission: {
    findMany: jest.fn()
  },
  role: {
    findMany: jest.fn(),
    create: jest.fn(),
    findUnique: jest.fn()
  },
  rolePermission: {
    createMany: jest.fn()
  },
  membership: {
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
    prismaMock.role.create = jest.fn().mockResolvedValue({ id: "role-1" });
    prismaMock.rolePermission.createMany = jest.fn();
    prismaMock.role.findUnique = jest.fn().mockResolvedValue({
      id: "role-1",
      name: "analyst",
      permissions: []
    });

    const result = await service.createRole("org-1", "user-1", {
      name: "analyst",
      description: "",
      permissions: ["items.read"]
    });

    expect(result?.id).toBe("role-1");
    expect(prismaMock.rolePermission.createMany).toHaveBeenCalled();
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
    expect(prismaMock.membership.upsert).toHaveBeenCalled();
  });
});
