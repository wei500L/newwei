import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";

import { ActionRateLimitService } from "../cache/action-rate-limit.service";
import { PrismaService } from "../config/prisma.service";

import { AssignRoleDto } from "./dto/assign-role.dto";
import { CreateRoleDto } from "./dto/create-role.dto";
import { UpdateRoleDto } from "./dto/update-role.dto";

@Injectable()
export class RbacService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actionRateLimit: ActionRateLimitService
  ) {}

  private async getActorPermissionSet(orgId: string, actorId: string) {
    const membership = await this.prisma.membership.findFirst({
      where: { orgId, userId: actorId },
      include: {
        roles: {
          include: {
            role: {
              include: {
                permissions: {
                  include: { permission: true }
                }
              }
            }
          }
        },
        role: {
          include: {
            permissions: {
              include: { permission: true }
            }
          }
        }
      }
    });
    if (!membership) {
      throw new ForbiddenException("Actor is not a member of the organization");
    }
    const roles = membership.roles?.map((link) => link.role).filter(Boolean) ?? [];
    if (roles.length === 0 && membership.role) {
      roles.push(membership.role);
    }
    return new Set(
      roles.flatMap((role) => role.permissions.map((rp) => rp.permission.name))
    );
  }

  private assertActorCanManagePermissions(actorPermissions: Set<string>, requested: string[]) {
    const missing = requested.find((permission) => !actorPermissions.has(permission));
    if (missing) {
      throw new ForbiddenException("Insufficient permission scope for RBAC change");
    }
  }

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
    const actorPermissions = await this.getActorPermissionSet(orgId, actorId);
    return this.prisma.$transaction(async (tx) => {
      const permissions = await tx.permission.findMany({
        where: { name: { in: dto.permissions } }
      });
      if (permissions.length !== dto.permissions.length) {
        throw new NotFoundException("One or more permissions not found");
      }
      this.assertActorCanManagePermissions(
        actorPermissions,
        permissions.map((permission) => permission.name)
      );

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
    const actorPermissions = await this.getActorPermissionSet(orgId, actorId);
    const role = await this.prisma.role.findFirst({
      where: {
        id: dto.roleId,
        orgId
      },
      include: {
        permissions: {
          include: { permission: true }
        }
      }
    });
    if (!role) {
      throw new NotFoundException("Role not found");
    }
    this.assertActorCanManagePermissions(
      actorPermissions,
      role.permissions.map((permission) => permission.permission.name)
    );

    return this.prisma.$transaction(async (tx) => {
      const existingMembership = await tx.membership.findUnique({
        where: {
          userId_orgId: {
            userId: dto.userId,
            orgId
          }
        },
        select: { id: true, roleId: true }
      });

      const membership = await tx.membership.upsert({
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
        }
      });

      await tx.membershipRole.createMany({
        data: Array.from(new Set([existingMembership?.roleId, dto.roleId]))
          .filter((roleId): roleId is string => typeof roleId === "string")
          .map((roleId) => ({ membershipId: membership.id, roleId, orgId })),
        skipDuplicates: true
      });

      return tx.membership.findUniqueOrThrow({
        where: { id: membership.id },
        include: {
          user: true,
          role: {
            include: {
              permissions: {
                include: { permission: true }
              }
            }
          },
          roles: {
            include: {
              role: {
                include: {
                  permissions: {
                    include: { permission: true }
                  }
                }
              }
            }
          }
        }
      });
    });
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
        },
        roles: {
          include: {
            role: {
              include: {
                permissions: {
                  include: { permission: true }
                }
              }
            }
          }
        }
      }
    });
  }

  async updateRole(orgId: string, actorId: string, dto: UpdateRoleDto) {
    await this.actionRateLimit.enforceRbacWrite(orgId, actorId);
    const actorPermissions = await this.getActorPermissionSet(orgId, actorId);
    const existingRole = await this.prisma.role.findFirst({
      where: {
        id: dto.id,
        orgId
      },
      include: {
        permissions: {
          include: { permission: true }
        }
      }
    });
    if (!existingRole) {
      throw new NotFoundException("Role not found");
    }
    if (existingRole.isSystem) {
      throw new ForbiddenException("System roles cannot be edited");
    }
    this.assertActorCanManagePermissions(
      actorPermissions,
      existingRole.permissions.map((permission) => permission.permission.name)
    );

    const permissions = await this.prisma.permission.findMany({
      where: { name: { in: dto.permissions } }
    });
    if (permissions.length !== dto.permissions.length) {
      throw new NotFoundException("One or more permissions not found");
    }
    this.assertActorCanManagePermissions(
      actorPermissions,
      permissions.map((permission) => permission.name)
    );

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
