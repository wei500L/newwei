import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { writeAuditLogBestEffort } from '../audit/audit-log.writer';
import { ActionRateLimitService } from '../cache/action-rate-limit.service';
import { PrismaService } from '../config/prisma.service';

import { AssignRoleDto } from './dto/assign-role.dto';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { UserAdminService } from './user-admin.service';

function isPrismaUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  return (error as { code?: unknown }).code === 'P2002';
}

const SYSTEM_ADMIN_ROLE_NAME = 'admin';

@Injectable()
export class RbacService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actionRateLimit: ActionRateLimitService,
    private readonly userAdminService: UserAdminService,
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
                  include: { permission: true },
                },
              },
            },
          },
        },
        role: {
          include: {
            permissions: {
              include: { permission: true },
            },
          },
        },
      },
    });
    if (!membership) {
      throw new ForbiddenException('Actor is not a member of the organization');
    }

    const roles = membership.roles?.map((link) => link.role).filter(Boolean) ?? [];
    if (roles.length === 0 && membership.role) {
      roles.push(membership.role);
    }

    return new Set(
      roles.flatMap((role) =>
        role.permissions.map((permission) => permission.permission.name),
      ),
    );
  }

  private assertActorCanManagePermissions(
    actorPermissions: Set<string>,
    requested: string[],
  ) {
    const missing = requested.find((permission) => !actorPermissions.has(permission));
    if (missing) {
      throw new ForbiddenException('Insufficient permission scope for RBAC change');
    }
  }

  async listPermissions() {
    return this.prisma.permission.findMany({
      orderBy: { name: 'asc' },
    });
  }

  async listRoles(orgId: string, options?: { includeSystem?: boolean }) {
    const includeSystem = options?.includeSystem ?? true;
    return this.prisma.role.findMany({
      where: {
        orgId,
        ...(includeSystem ? {} : { isSystem: false }),
      },
      include: {
        permissions: {
          include: { permission: true },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async createRole(orgId: string, actorId: string, dto: CreateRoleDto) {
    await this.actionRateLimit.enforceRbacWrite(orgId, actorId);
    await this.userAdminService.assertActorIsOrgAdmin(orgId, actorId);
    const actorPermissions = await this.getActorPermissionSet(orgId, actorId);
    const normalizedName = dto.name.trim();
    const normalizedDescription = dto.description?.trim() || undefined;

    if (!normalizedName) {
      throw new BadRequestException('Role name is required');
    }
    if (normalizedName.toLowerCase() === SYSTEM_ADMIN_ROLE_NAME) {
      throw new BadRequestException('System administrator role name is reserved');
    }

    let role;
    try {
      role = await this.prisma.$transaction(async (tx) => {
        const permissions = await tx.permission.findMany({
          where: { name: { in: dto.permissions } },
        });
        if (permissions.length !== dto.permissions.length) {
          throw new NotFoundException('One or more permissions not found');
        }
        this.assertActorCanManagePermissions(
          actorPermissions,
          permissions.map((permission) => permission.name),
        );

        const createdRole = await tx.role.create({
          data: {
            name: normalizedName,
            description: normalizedDescription,
            orgId,
            isSystem: false,
          },
        });

        await tx.rolePermission.createMany({
          data: permissions.map((permission) => ({
            roleId: createdRole.id,
            permissionId: permission.id,
          })),
        });

        return tx.role.findUnique({
          where: { id: createdRole.id },
          include: {
            permissions: { include: { permission: true } },
          },
        });
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        throw new ConflictException('Role name already exists');
      }
      throw error;
    }

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: 'roles',
          action: 'create',
          metadata: {
            roleId: role?.id,
            name: normalizedName,
            permissions: dto.permissions,
          },
        },
      },
      {
        orgId,
        actorId,
        resource: 'roles',
        action: 'create',
      },
    );

    return role;
  }

  async assignRole(orgId: string, actorId: string, dto: AssignRoleDto) {
    await this.actionRateLimit.enforceRbacWrite(orgId, actorId);
    await this.userAdminService.assertActorIsOrgAdmin(orgId, actorId);
    const actorPermissions = await this.getActorPermissionSet(orgId, actorId);

    const targetMembership = await this.prisma.membership.findUnique({
      where: {
        userId_orgId: {
          userId: dto.userId,
          orgId,
        },
      },
      include: {
        role: true,
        roles: {
          include: {
            role: true,
          },
        },
      },
    });
    if (!targetMembership) {
      throw new NotFoundException('User is not a member of the organization');
    }

    const targetRoles =
      targetMembership.roles?.map((link) => link.role).filter(Boolean) ?? [];
    if (targetRoles.length === 0 && targetMembership.role) {
      targetRoles.push(targetMembership.role);
    }
    if (
      dto.userId === actorId ||
      targetRoles.some(
        (role) => role.isSystem && role.name.toLowerCase() === 'admin',
      )
    ) {
      throw new ForbiddenException('System administrators cannot be managed');
    }

    const role = await this.prisma.role.findFirst({
      where: {
        id: dto.roleId,
        orgId,
      },
      include: {
        permissions: {
          include: { permission: true },
        },
      },
    });
    if (!role) {
      throw new NotFoundException('Role not found');
    }
    if (role.isSystem && role.name.toLowerCase() === 'admin') {
      throw new ForbiddenException(
        'System administrator role cannot be assigned from user management',
      );
    }
    this.assertActorCanManagePermissions(
      actorPermissions,
      role.permissions.map((permission) => permission.permission.name),
    );

    const membership = await this.prisma.$transaction(async (tx) => {
      const updatedMembership = await tx.membership.update({
        where: {
          userId_orgId: {
            userId: dto.userId,
            orgId,
          },
        },
        data: {
          roleId: dto.roleId,
        },
      });

      await tx.membershipRole.deleteMany({
        where: { membershipId: updatedMembership.id },
      });
      await tx.membershipRole.createMany({
        data: [
          {
            membershipId: updatedMembership.id,
            roleId: dto.roleId,
            orgId,
          },
        ],
      });

      return tx.membership.findUniqueOrThrow({
        where: { id: updatedMembership.id },
        include: {
          user: true,
          role: {
            include: {
              permissions: {
                include: { permission: true },
              },
            },
          },
          roles: {
            include: {
              role: {
                include: {
                  permissions: {
                    include: { permission: true },
                  },
                },
              },
            },
          },
        },
      });
    });

    await this.userAdminService.invalidateUsersWithRole(orgId, dto.roleId);
    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: 'users',
          action: 'assign_role',
          metadata: {
            targetUserId: dto.userId,
            roleId: dto.roleId,
          },
        },
      },
      {
        orgId,
        actorId,
        resource: 'users',
        action: 'assign_role',
      },
    );

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
              include: { permission: true },
            },
          },
        },
        roles: {
          include: {
            role: {
              include: {
                permissions: {
                  include: { permission: true },
                },
              },
            },
          },
        },
      },
    });
  }

  async updateRole(orgId: string, actorId: string, dto: UpdateRoleDto) {
    await this.actionRateLimit.enforceRbacWrite(orgId, actorId);
    await this.userAdminService.assertActorIsOrgAdmin(orgId, actorId);
    const actorPermissions = await this.getActorPermissionSet(orgId, actorId);

    const existingRole = await this.prisma.role.findFirst({
      where: {
        id: dto.id,
        orgId,
      },
      include: {
        permissions: {
          include: { permission: true },
        },
      },
    });
    if (!existingRole) {
      throw new NotFoundException('Role not found');
    }
    if (existingRole.isSystem) {
      throw new ForbiddenException('System roles cannot be edited');
    }
    this.assertActorCanManagePermissions(
      actorPermissions,
      existingRole.permissions.map((permission) => permission.permission.name),
    );

    const permissions = await this.prisma.permission.findMany({
      where: { name: { in: dto.permissions } },
    });
    if (permissions.length !== dto.permissions.length) {
      throw new NotFoundException('One or more permissions not found');
    }
    this.assertActorCanManagePermissions(
      actorPermissions,
      permissions.map((permission) => permission.name),
    );

    const role = await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: existingRole.id } });
      if (permissions.length > 0) {
        await tx.rolePermission.createMany({
          data: permissions.map((permission) => ({
            roleId: existingRole.id,
            permissionId: permission.id,
          })),
        });
      }

      return tx.role.update({
        where: { id: existingRole.id },
        data: {
          description: dto.description ?? null,
        },
        include: {
          permissions: { include: { permission: true } },
        },
      });
    });

    await this.userAdminService.invalidateUsersWithRole(orgId, existingRole.id);
    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: 'roles',
          action: 'update',
          metadata: {
            roleId: dto.id,
            description: dto.description ?? null,
            permissions: dto.permissions,
          },
        },
      },
      {
        orgId,
        actorId,
        resource: 'roles',
        action: 'update',
      },
    );

    return role;
  }

  async auditLogs(orgId: string, limit = 20) {
    return this.prisma.auditLog.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
