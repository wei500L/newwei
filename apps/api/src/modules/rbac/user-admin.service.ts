import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  collectMembershipPermissionSet,
  collectMembershipRoles,
  type MembershipRoleWithPermissions,
} from '../../common/authz/membership-permissions';
import { writeAuditLogBestEffort } from '../audit/audit-log.writer';
import { ActionRateLimitService } from '../cache/action-rate-limit.service';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../config/prisma.service';

interface UserAdminListOptions {
  first?: number;
  after?: string;
  search?: string;
}

interface UpdateMembershipRolesInput {
  userId: string;
  primaryRoleId: string;
  roleIds: string[];
}

interface MembershipRoleRecord extends MembershipRoleWithPermissions {
  id: string;
  name: string;
  isSystem: boolean;
}

const SYSTEM_ADMIN_ROLE_NAME = 'admin';
const LOGIN_ACTION_TO_METHOD: Record<string, string> = {
  login: 'password',
  login_with_code: 'email_code',
};

@Injectable()
export class UserAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actionRateLimit: ActionRateLimitService,
    private readonly cache: CacheService,
  ) {}

  private async getMembershipWithRoles(orgId: string, userId: string) {
    return this.prisma.membership.findUnique({
      where: {
        userId_orgId: {
          userId,
          orgId,
        },
      },
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

  private isSystemAdminRole(role: { name: string; isSystem: boolean }) {
    return role.isSystem && role.name.toLowerCase() === SYSTEM_ADMIN_ROLE_NAME;
  }

  private ensureRoleScope(
    actorPermissions: Set<string>,
    roles: MembershipRoleRecord[],
  ) {
    const missing = roles
      .flatMap((role) =>
        (role.permissions ?? [])
          .map((entry) => entry?.permission?.name)
          .filter(
            (permission): permission is string =>
              typeof permission === 'string' && permission.trim().length > 0,
          ),
      )
      .find((permission) => !actorPermissions.has(permission));
    if (missing) {
      throw new ForbiddenException(
        'Insufficient permission scope for RBAC change',
      );
    }
  }

  private extractUserAgent(metadata: unknown) {
    if (!metadata || typeof metadata !== 'object') {
      return null;
    }

    const rawUserAgent = (metadata as { userAgent?: unknown }).userAgent;
    return typeof rawUserAgent === 'string' && rawUserAgent.trim()
      ? rawUserAgent
      : null;
  }

  private async invalidateProfileCache(userId: string, orgId?: string) {
    await this.cache.del(`profile:${userId}:${orgId ?? 'default'}`);

    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      select: { orgId: true },
    });
    for (const membership of memberships) {
      await this.cache.del(`profile:${userId}:${membership.orgId}`);
    }
  }

  async assertActorIsOrgAdmin(orgId: string, actorId: string) {
    const membership = await this.getMembershipWithRoles(orgId, actorId);
    if (!membership) {
      throw new ForbiddenException('Actor is not a member of the organization');
    }

    const roles = collectMembershipRoles(membership);
    if (!roles.some((role) => this.isSystemAdminRole(role))) {
      throw new ForbiddenException('Admin access required');
    }

    return membership;
  }

  async listUsers(orgId: string, actorId: string, options?: UserAdminListOptions) {
    await this.assertActorIsOrgAdmin(orgId, actorId);

    const take = Math.max(1, Math.min(options?.first ?? 100, 200));
    const after = options?.after?.trim();
    const search = options?.search?.trim();

    return this.prisma.user.findMany({
      where: {
        memberships: {
          some: {
            orgId,
          },
        },
        ...(search
          ? {
              OR: [
                { firstName: { contains: search } },
                { lastName: { contains: search } },
                { email: { contains: search } },
              ],
            }
          : {}),
      },
      take,
      ...(after
        ? {
            skip: 1,
            cursor: { id: after },
          }
        : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        memberships: {
          where: { orgId },
          include: {
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
        },
      },
    });
  }

  async updateMembershipRoles(
    orgId: string,
    actorId: string,
    input: UpdateMembershipRolesInput,
  ) {
    await this.actionRateLimit.enforceRbacWrite(orgId, actorId);
    const actorMembership = await this.assertActorIsOrgAdmin(orgId, actorId);
    const targetMembership = await this.getMembershipWithRoles(orgId, input.userId);

    if (!targetMembership) {
      throw new NotFoundException('User is not a member of the organization');
    }

    if (targetMembership.userId === actorId) {
      throw new ForbiddenException('Administrators cannot change their own roles');
    }

    const targetRoles = collectMembershipRoles(targetMembership);
    if (targetRoles.some((role) => this.isSystemAdminRole(role))) {
      throw new ForbiddenException('System administrators cannot be managed');
    }

    const roleIds = Array.from(
      new Set(
        input.roleIds
          .map((roleId) => roleId.trim())
          .filter((roleId) => roleId.length > 0),
      ),
    );
    if (roleIds.length === 0) {
      throw new BadRequestException('At least one role is required');
    }
    if (!roleIds.includes(input.primaryRoleId)) {
      throw new BadRequestException(
        'Primary role must be included in the selected roles',
      );
    }

    const roles = await this.prisma.role.findMany({
      where: {
        orgId,
        id: { in: roleIds },
      },
      include: {
        permissions: {
          include: { permission: true },
        },
      },
    });
    if (roles.length !== roleIds.length) {
      throw new NotFoundException('One or more roles not found');
    }
    if (roles.some((role) => this.isSystemAdminRole(role))) {
      throw new ForbiddenException(
        'System administrator role cannot be assigned from user management',
      );
    }

    const actorPermissions = collectMembershipPermissionSet(actorMembership);
    this.ensureRoleScope(actorPermissions, roles);

    const membership = await this.prisma.$transaction(async (tx) => {
      const updatedMembership = await tx.membership.update({
        where: {
          userId_orgId: {
            userId: input.userId,
            orgId,
          },
        },
        data: {
          roleId: input.primaryRoleId,
        },
      });

      await tx.membershipRole.deleteMany({
        where: { membershipId: updatedMembership.id },
      });
      await tx.membershipRole.createMany({
        data: roleIds.map((roleId) => ({
          membershipId: updatedMembership.id,
          orgId,
          roleId,
        })),
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

    await this.invalidateProfileCache(input.userId, orgId);
    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: 'users',
          action: 'update_membership_roles',
          metadata: {
            targetUserId: input.userId,
            primaryRoleId: input.primaryRoleId,
            roleIds,
          },
        },
      },
      {
        orgId,
        actorId,
        resource: 'users',
        action: 'update_membership_roles',
      },
    );

    return membership;
  }

  async setUserActive(
    orgId: string,
    actorId: string,
    userId: string,
    isActive: boolean,
  ) {
    await this.actionRateLimit.enforceRbacWrite(orgId, actorId);
    await this.assertActorIsOrgAdmin(orgId, actorId);
    const targetMembership = await this.getMembershipWithRoles(orgId, userId);

    if (!targetMembership) {
      throw new NotFoundException('User is not a member of the organization');
    }

    if (targetMembership.userId === actorId) {
      throw new ForbiddenException('Administrators cannot change their own status');
    }

    const targetRoles = collectMembershipRoles(targetMembership);
    if (targetRoles.some((role) => this.isSystemAdminRole(role))) {
      throw new ForbiddenException('System administrators cannot be managed');
    }

    const membership = await this.prisma.membership.update({
      where: {
        userId_orgId: {
          userId,
          orgId,
        },
      },
      data: { isActive },
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

    await this.invalidateProfileCache(userId, orgId);
    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: 'users',
          action: 'set_active',
          metadata: {
            targetUserId: userId,
            isActive,
          },
        },
      },
      {
        orgId,
        actorId,
        resource: 'users',
        action: 'set_active',
      },
    );

    return membership;
  }

  async listUserLoginRecords(
    orgId: string,
    actorId: string,
    userId: string,
    limit = 20,
  ) {
    await this.assertActorIsOrgAdmin(orgId, actorId);

    const targetMembership = await this.getMembershipWithRoles(orgId, userId);
    if (!targetMembership) {
      throw new NotFoundException('User is not a member of the organization');
    }

    const targetRoles = collectMembershipRoles(targetMembership);
    if (targetRoles.some((role) => this.isSystemAdminRole(role))) {
      throw new ForbiddenException('System administrators cannot be managed');
    }

    const rows = await this.prisma.auditLog.findMany({
      where: {
        orgId,
        actorId: userId,
        resource: 'auth',
        action: { in: Object.keys(LOGIN_ACTION_TO_METHOD) },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.max(1, Math.min(limit, 100)),
    });

    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      ipAddress: row.ipAddress ?? null,
      userAgent: this.extractUserAgent(row.metadata),
      method: LOGIN_ACTION_TO_METHOD[row.action] ?? row.action,
    }));
  }

  async invalidateUsersWithRole(orgId: string, roleId: string) {
    const memberships = await this.prisma.membership.findMany({
      where: {
        orgId,
        OR: [
          { roleId },
          {
            roles: {
              some: {
                roleId,
              },
            },
          },
        ],
      },
      select: { userId: true },
    });

    const userIds = Array.from(new Set(memberships.map((entry) => entry.userId)));
    for (const userId of userIds) {
      await this.invalidateProfileCache(userId, orgId);
    }
  }
}
