import { ForbiddenException, UseGuards } from "@nestjs/common";
import { Args, Context, Int, Query, Resolver } from "@nestjs/graphql";

import { AllowAuthenticated } from "../../common/decorators/allow-authenticated.decorator";
import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { AuthService, AuthenticatedUser } from "../../modules/auth/auth.service";
import { PrismaService } from "../../modules/config/prisma.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import type { GqlRequest } from "../graphql.types";
import { UserModel } from "../models/user.model";

interface UserMembershipRolePermission {
  permission?: { name?: string | null };
}

interface UserMembershipRole {
  permissions?: UserMembershipRolePermission[];
}

interface UserMembershipLink {
  roleId?: string | null;
  role?: UserMembershipRole | null;
}

interface UserMembershipRecord {
  roleId?: string | null;
  role?: UserMembershipRole | null;
  roles?: UserMembershipLink[] | null;
}

interface UserRecord {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  avatarUrl?: string | null;
  memberships?: UserMembershipRecord[] | null;
}

function decodeCursor(cursor?: string | null) {
  return cursor ? Buffer.from(cursor, "base64").toString("utf8") : undefined;
}

@Resolver(() => UserModel)
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class UsersResolver {
  constructor(private readonly prisma: PrismaService, private readonly authService: AuthService) {}

  @Query(() => UserModel)
  @AllowAuthenticated()
  async me(@Context("req") req: GqlRequest): Promise<UserModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const profile = await this.authService.getUserProfile(requester.id, requester.orgId);
    return this.toGraphQLUser(profile);
  }

  @HasPermission("users.read")
  @Query(() => [UserModel])
  async users(
    @Context("req") req: GqlRequest,
    @Args("first", { type: () => Int, nullable: true }) first = 20,
    @Args("after", { nullable: true }) after?: string,
    @Args("search", { nullable: true }) search?: string
  ): Promise<UserModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }

    const cursorId = decodeCursor(after);

    const users = await this.prisma.user.findMany({
      where: {
        memberships: {
          some: {
            orgId: requester.orgId
          }
        },
        ...(search
          ? {
              OR: [
                { firstName: { contains: search, mode: "insensitive" } },
                { lastName: { contains: search, mode: "insensitive" } },
                { email: { contains: search, mode: "insensitive" } }
              ]
            }
          : {})
      },
      take: first,
      ...(cursorId
        ? {
            skip: 1,
            cursor: { id: cursorId }
          }
        : {}),
      orderBy: { createdAt: "desc" },
      include: {
        memberships: {
          where: { orgId: requester.orgId },
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
        }
      }
    });

    return users.map((user) =>
      this.toGraphQLUser(this.mapUserMembership(user, requester.orgId))
    );
  }

  private mapUserMembership(user: UserRecord, orgId: string): AuthenticatedUser {
    const membership = Array.isArray(user.memberships) ? user.memberships[0] : undefined;
    const roleIds = new Set<string>();
    const permissions = new Set<string>();

    const roleLinks = Array.isArray(membership?.roles) ? membership.roles : [];
    if (roleLinks.length > 0) {
      for (const link of roleLinks) {
        if (typeof link?.roleId === "string") {
          roleIds.add(link.roleId);
        }
        const rolePermissions = Array.isArray(link?.role?.permissions) ? link.role.permissions : [];
        for (const rolePermission of rolePermissions) {
          const name = rolePermission?.permission?.name;
          if (typeof name === "string") {
            permissions.add(name);
          }
        }
      }
    } else if (membership?.role) {
      if (typeof membership.roleId === "string") {
        roleIds.add(membership.roleId);
      }
      const rolePermissions = Array.isArray(membership.role.permissions) ? membership.role.permissions : [];
      for (const rolePermission of rolePermissions) {
        const name = rolePermission?.permission?.name;
        if (typeof name === "string") {
          permissions.add(name);
        }
      }
    }

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarUrl: user.avatarUrl ?? null,
      orgId: membership?.orgId ?? orgId,
      roleIds: Array.from(roleIds),
      permissions: Array.from(permissions)
    };
  }

  private toGraphQLUser(user: AuthenticatedUser): UserModel {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarUrl: user.avatarUrl ?? undefined,
      planTier: user.planTier ?? undefined,
      subscriptionStatus: user.subscriptionStatus ?? undefined,
      orgId: user.orgId,
      roleIds: user.roleIds,
      permissions: user.permissions
    } satisfies UserModel;
  }
}
