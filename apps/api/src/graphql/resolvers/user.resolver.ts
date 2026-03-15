import { ForbiddenException, UseGuards } from "@nestjs/common";
import { Args, Context, Int, Mutation, Query, Resolver } from "@nestjs/graphql";

import { AllowAuthenticated } from "../../common/decorators/allow-authenticated.decorator";
import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import {
  AuthService,
  AuthenticatedUser,
} from "../../modules/auth/auth.service";
import { UserAdminService } from "../../modules/rbac/user-admin.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import {
  SetUserActiveInput,
  UpdateMembershipRolesInput,
} from "../dto/rbac.input";
import type { GqlRequest } from "../graphql.types";
import { UserLoginRecordModel, UserModel } from "../models/user.model";
import { resolveEffectiveUserActive } from "../utils/resolve-effective-user-active";

interface GraphqlUserSource {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string | null;
  planTier?: string | null;
  subscriptionStatus?: string | null;
  orgId: string;
  primaryRoleId?: string | null;
  roleIds: string[];
  permissions: string[];
  isActive?: boolean;
  emailVerified?: string | Date | null;
  lastLoginAt?: string | Date | null;
}

function decodeCursor(cursor?: string | null) {
  return cursor ? Buffer.from(cursor, "base64").toString("utf8") : undefined;
}

function parseOptionalDate(value?: string | Date | null) {
  if (!value) {
    return undefined;
  }

  return value instanceof Date ? value : new Date(value);
}

@Resolver(() => UserModel)
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class UsersResolver {
  constructor(
    private readonly authService: AuthService,
    private readonly userAdminService: UserAdminService,
  ) {}

  @Query(() => UserModel)
  @AllowAuthenticated()
  async me(@Context("req") req: GqlRequest): Promise<UserModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const profile = await this.authService.getUserProfile(
      requester.id,
      requester.orgId,
    );
    return this.toGraphQLUser(profile);
  }

  @HasPermission("users.read")
  @Query(() => [UserModel])
  async users(
    @Context("req") req: GqlRequest,
    @Args("first", { type: () => Int, nullable: true }) first = 20,
    @Args("after", { nullable: true }) after?: string,
    @Args("search", { nullable: true }) search?: string,
  ): Promise<UserModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }

    const users = await this.userAdminService.listUsers(
      requester.orgId,
      requester.id,
      {
        first,
        after: decodeCursor(after),
        search,
      },
    );

    return users.map((user) => {
      const membership = Array.isArray(user.memberships)
        ? user.memberships[0]
        : undefined;
      const roleLinks = Array.isArray(membership?.roles)
        ? membership.roles
        : [];
      const roles = roleLinks
        .map((link) => link.role)
        .filter(
          (role): role is NonNullable<(typeof roleLinks)[number]["role"]> =>
            Boolean(role),
        );
      if (roles.length === 0 && membership?.role) {
        roles.push(membership.role);
      }

      return this.toGraphQLUser({
        id: user.id,
        email: user.email,
        firstName: user.firstName ?? "",
        lastName: user.lastName ?? "",
        avatarUrl: user.avatarUrl ?? null,
        orgId: membership?.orgId ?? requester.orgId,
        primaryRoleId: membership?.roleId ?? null,
        roleIds: (roleLinks.length > 0
          ? roleLinks.map((link) => link.roleId)
          : [membership?.roleId]
        ).filter((roleId): roleId is string => typeof roleId === "string"),
        permissions: Array.from(
          new Set(
            roles.flatMap((role) =>
              (role.permissions ?? []).map((entry) => entry.permission.name),
            ),
          ),
        ),
        isActive: resolveEffectiveUserActive(
          user.isActive,
          membership?.isActive,
        ),
        emailVerified: user.emailVerified,
        lastLoginAt: user.lastLoginAt,
      });
    });
  }

  @HasPermission("users.read")
  @Query(() => [UserLoginRecordModel])
  async userLoginRecords(
    @Context("req") req: GqlRequest,
    @Args("userId") userId: string,
    @Args("limit", { type: () => Int, nullable: true }) limit = 20,
  ): Promise<UserLoginRecordModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }

    return this.userAdminService.listUserLoginRecords(
      requester.orgId,
      requester.id,
      userId,
      limit,
    );
  }

  @HasPermission("users.write")
  @Mutation(() => UserModel)
  async updateMembershipRoles(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateMembershipRolesInput,
  ): Promise<UserModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }

    const membership = await this.userAdminService.updateMembershipRoles(
      requester.orgId,
      requester.id,
      input,
    );

    const roleLinks = Array.isArray(membership.roles) ? membership.roles : [];
    const roles = roleLinks
      .map((link) => link.role)
      .filter((role): role is NonNullable<(typeof roleLinks)[number]["role"]> =>
        Boolean(role),
      );
    if (roles.length === 0 && membership.role) {
      roles.push(membership.role);
    }

    return this.toGraphQLUser({
      id: membership.user.id,
      email: membership.user.email,
      firstName: membership.user.firstName ?? "",
      lastName: membership.user.lastName ?? "",
      avatarUrl: membership.user.avatarUrl ?? null,
      orgId: membership.orgId,
      primaryRoleId: membership.roleId ?? null,
      roleIds: roles.map((role) => role.id),
      permissions: Array.from(
        new Set(
          roles.flatMap((role) =>
            (role.permissions ?? []).map((entry) => entry.permission.name),
          ),
        ),
      ),
      isActive: resolveEffectiveUserActive(
        membership.user.isActive,
        membership.isActive,
      ),
      emailVerified: membership.user.emailVerified,
      lastLoginAt: membership.user.lastLoginAt,
    });
  }

  @HasPermission("users.write")
  @Mutation(() => UserModel)
  async setUserActive(
    @Context("req") req: GqlRequest,
    @Args("input") input: SetUserActiveInput,
  ): Promise<UserModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }

    const membership = await this.userAdminService.setUserActive(
      requester.orgId,
      requester.id,
      input.userId,
      input.isActive,
    );

    const roleLinks = Array.isArray(membership.roles) ? membership.roles : [];
    const roles = roleLinks
      .map((link) => link.role)
      .filter((role): role is NonNullable<(typeof roleLinks)[number]["role"]> =>
        Boolean(role),
      );
    if (roles.length === 0 && membership?.role) {
      roles.push(membership.role);
    }

    return this.toGraphQLUser({
      id: membership.user.id,
      email: membership.user.email,
      firstName: membership.user.firstName ?? "",
      lastName: membership.user.lastName ?? "",
      avatarUrl: membership.user.avatarUrl ?? null,
      orgId: membership.orgId,
      primaryRoleId: membership.roleId ?? null,
      roleIds: (roleLinks.length > 0
        ? roleLinks.map((link) => link.roleId)
        : [membership.roleId]
      ).filter((roleId): roleId is string => typeof roleId === "string"),
      permissions: Array.from(
        new Set(
          roles.flatMap((role) =>
            (role.permissions ?? []).map((entry) => entry.permission.name),
          ),
        ),
      ),
      isActive: resolveEffectiveUserActive(
        membership.user.isActive,
        membership.isActive,
      ),
      emailVerified: membership.user.emailVerified,
      lastLoginAt: membership.user.lastLoginAt,
    });
  }

  private toGraphQLUser(user: GraphqlUserSource): UserModel {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarUrl: user.avatarUrl ?? undefined,
      planTier: user.planTier ?? undefined,
      subscriptionStatus: user.subscriptionStatus ?? undefined,
      orgId: user.orgId,
      primaryRoleId: user.primaryRoleId ?? undefined,
      isActive: user.isActive ?? true,
      emailVerified: parseOptionalDate(user.emailVerified) ?? null,
      lastLoginAt: parseOptionalDate(user.lastLoginAt) ?? null,
      roleIds: user.roleIds,
      permissions: user.permissions,
    } satisfies UserModel;
  }
}
