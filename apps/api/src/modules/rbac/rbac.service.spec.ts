import { NotFoundException } from "@nestjs/common";
import { RbacService } from "./rbac.service";

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
  }
} as unknown as any;

describe("RbacService", () => {
  let service: RbacService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new RbacService(prismaMock);
  });

  it("throws when permissions missing on role creation", async () => {
    prismaMock.permission.findMany = jest.fn().mockResolvedValue([]);

    await expect(
      service.createRole("org-1", { name: "role", description: "desc", permissions: ["x"] })
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

    const result = await service.createRole("org-1", {
      name: "analyst",
      description: "",
      permissions: ["items.read"]
    });

    expect(result?.id).toBe("role-1");
    expect(prismaMock.rolePermission.createMany).toHaveBeenCalled();
  });
});
