import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../config/prisma.service";
import { CreateRoleDto } from "./dto/create-role.dto";
import { AssignRoleDto } from "./dto/assign-role.dto";

@Injectable()
export class RbacService {
  constructor(private readonly prisma: PrismaService) {}

  async listPermissions() {
    return this.prisma.permission.findMany({
      orderBy: { name: "asc" }
    });
  }

  async listRoles(orgId: string) {
    return this.prisma.role.findMany({
      where: { orgId },
      include: {
        permissions: {
          include: { permission: true }
        }
      },
      orderBy: { name: "asc" }
    });
  }

  async createRole(orgId: string, dto: CreateRoleDto) {
    return this.prisma.$transaction(async (tx) => {
      const permissions = await tx.permission.findMany({
        where: { name: { in: dto.permissions } }
      });
      if (permissions.length !== dto.permissions.length) {
        throw new NotFoundException("One or more permissions not found");
      }

      const role = await tx.role.create({
        data: {
          name: dto.name,
          description: dto.description,
          orgId
        }
      });

      await tx.rolePermission.createMany({
        data: permissions.map((permission) => ({
          roleId: role.id,
          permissionId: permission.id
        }))
      });

      return tx.role.findUnique({
        where: { id: role.id },
        include: {
          permissions: { include: { permission: true } }
        }
      });
    });
  }

  async assignRole(orgId: string, dto: AssignRoleDto) {
    const membership = await this.prisma.membership.upsert({
      where: {
        userId_orgId: {
          userId: dto.userId,
          orgId
        }
      },
      update: {
        roleId: dto.roleId
      },
      create: {
        userId: dto.userId,
        roleId: dto.roleId,
        orgId
      },
      include: {
        user: true,
        role: true
      }
    });
    return membership;
  }

  async listMembers(orgId: string) {
    return this.prisma.membership.findMany({
      where: { orgId },
      include: {
        user: true,
        role: true
      }
    });
  }

  async auditLogs(orgId: string, limit = 20) {
    return this.prisma.auditLog.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      take: limit
    });
  }
}
