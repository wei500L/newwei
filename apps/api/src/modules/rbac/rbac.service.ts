import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../config/prisma.service";
import { CreateRoleDto } from "./dto/create-role.dto";
import { AssignRoleDto } from "./dto/assign-role.dto";
import { ActionRateLimitService } from "../cache/action-rate-limit.service";
import { UpdateRoleDto } from "./dto/update-role.dto";

@Injectable()
export class RbacService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actionRateLimit: ActionRateLimitService
  ) {}

  async listPermissions() {
    return this.prisma.permission.findMany({
      orderBy: { name: "asc" }
    });
  }

  async listRoles(orgId: string, options?: { includeSystem?: boolean }) {
    const includeSystem = options?.includeSystem ?? true;
    return this.prisma.role.findMany({
      where: {
        orgId,
        ...(includeSystem ? {} : { isSystem: false })
      },
      include: {
        permissions: {
          include: { permission: true }
        }
      },
      orderBy: { name: "asc" }
    });
  }

  async createRole(orgId: string, actorId: string, dto: CreateRoleDto) {
    await this.actionRateLimit.enforceRbacWrite(orgId, actorId);
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
          orgId,
          isSystem: false
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

  async assignRole(orgId: string, actorId: string, dto: AssignRoleDto) {
    await this.actionRateLimit.enforceRbacWrite(orgId, actorId);
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
        role: {
          include: {
            permissions: {
              include: { permission: true }
            }
          }
        }
      }
    });
    return membership;
  }

  async listMembers(orgId: string) {
    return this.prisma.membership.findMany({
      where: { orgId },
      include: {
        user: true,
        role: {
          include: {
            permissions: {
              include: { permission: true }
            }
          }
        }
      }
    });
  }

  async updateRole(orgId: string, actorId: string, dto: UpdateRoleDto) {
    await this.actionRateLimit.enforceRbacWrite(orgId, actorId);
    const existingRole = await this.prisma.role.findFirst({
      where: {
        id: dto.id,
        orgId
      }
    });
    if (!existingRole) {
      throw new NotFoundException("Role not found");
    }
    if (existingRole.isSystem) {
      throw new ForbiddenException("System roles cannot be edited");
    }

    const permissions = await this.prisma.permission.findMany({
      where: { name: { in: dto.permissions } }
    });
    if (permissions.length !== dto.permissions.length) {
      throw new NotFoundException("One or more permissions not found");
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: existingRole.id } });
      if (permissions.length > 0) {
        await tx.rolePermission.createMany({
          data: permissions.map((permission) => ({
            roleId: existingRole.id,
            permissionId: permission.id
          }))
        });
      }

      return tx.role.update({
        where: { id: existingRole.id },
        data: {
          description: dto.description ?? null
        },
        include: {
          permissions: { include: { permission: true } }
        }
      });
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
