import { ForbiddenException, UseGuards } from "@nestjs/common";
import {
  Args,
  Context,
  Mutation,
  Query,
  ResolveField,
  Resolver,
  Parent
} from "@nestjs/graphql";
import type DataLoader from "dataloader";
import { Loader } from "nestjs-dataloader";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { AuthenticatedUser } from "../../modules/auth/auth.service";
import { RbacService } from "../../modules/rbac/rbac.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import { AssignRoleInput, UpdateRoleInput } from "../dto/rbac.input";
import type { GqlRequest } from "../graphql.types";
import { UserLoader } from "../loaders/user.loader";
import { PermissionModel, RoleModel, MembershipModel } from "../models/rbac.model";
import { UserModel } from "../models/user.model";

interface RolePermissionRecord {
  permission: {
    id: string;
    name: string;
    description?: string | null;
  };
}

interface RoleRecord {
  id: string;
  name: string;
  description?: string | null;
  isSystem: boolean;
  permissions: RolePermissionRecord[];
}

interface RoleLinkRecord {
  roleId?: string | null;
  role?: RoleRecord | null;
}

interface UserRecord {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}

interface MembershipRecord {
  id: string;
  orgId: string;
  userId: string;
  roleId?: string | null;
  role: RoleRecord;
  roles?: RoleLinkRecord[] | null;
  user: UserRecord;
}

@Resolver(() => MembershipModel)
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class RbacResolver {
  constructor(private readonly rbacService: RbacService) {}

  @HasPermission("roles.read")
  @Query(() => [RoleModel])
  async roles(
    @Context("req") req: GqlRequest,
    @Args("includeSystem", { type: () => Boolean, nullable: true }) includeSystem?: boolean
  ): Promise<RoleModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const data = await this.rbacService.listRoles(requester.orgId, { includeSystem });
    return data.map((role) => this.mapRole(role));
  }

  @HasPermission("permissions.read")
  @Query(() => [PermissionModel])
  async permissions(): Promise<PermissionModel[]> {
    const data = await this.rbacService.listPermissions();
    return data.map((permission) => ({
      id: permission.id,
      name: permission.name,
      description: permission.description ?? undefined
    }));
  }

  @HasPermission("users.read")
  @Query(() => [MembershipModel])
  async memberships(@Context("req") req: GqlRequest): Promise<MembershipModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const memberships = await this.rbacService.listMembers(requester.orgId);
    return memberships.map((membership) => this.mapMembership(membership));
  }

  @HasPermission("roles.write")
  @Mutation(() => MembershipModel)
  async assignRole(
    @Context("req") req: GqlRequest,
    @Args("input") input: AssignRoleInput
  ): Promise<MembershipModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const membership = await this.rbacService.assignRole(requester.orgId, requester.id, input);
    return this.mapMembership(membership);
  }

  @HasPermission("roles.write")
  @Mutation(() => RoleModel)
  async updateRole(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateRoleInput
  ): Promise<RoleModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const role = await this.rbacService.updateRole(requester.orgId, requester.id, input);
    return this.mapRole(role);
  }

  @ResolveField(() => UserModel)
  async user(
    @Parent() membership: MembershipModel,
    @Loader(UserLoader) userLoader: DataLoader<string, UserRecord | null>
  ): Promise<UserModel> {
    if (membership.user) {
      return membership.user;
    }
    const user = await userLoader.load(membership.userId);
    if (!user) {
      throw new ForbiddenException("User not found");
    }
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      orgId: membership.orgId,
      roleIds: [],
      permissions: []
    };
  }

  private mapRole(role: RoleRecord): RoleModel {
    return {
      id: role.id,
      name: role.name,
      description: role.description ?? undefined,
      isSystem: role.isSystem,
      permissions: role.permissions.map((permission) => ({
        id: permission.permission.id,
        name: permission.permission.name,
        description: permission.permission.description ?? undefined
      }))
    };
  }

  private mapMembership(membership: MembershipRecord): MembershipModel {
    const roleLinks = Array.isArray(membership?.roles) ? membership.roles : [];
    const roles = roleLinks
      .map((link) => link.role)
      .filter((role): role is RoleRecord => Boolean(role));
    if (roles.length === 0 && membership?.role) {
      roles.push(membership.role);
    }

    const roleIds = (
      roleLinks.length > 0 ? roleLinks.map((link) => link.roleId) : [membership.roleId]
    ).filter((id): id is string => typeof id === "string");
    const permissions = Array.from(
      new Set(
        roles.flatMap((role) =>
          (role.permissions ?? []).map((permission) => permission.permission.name)
        )
      )
    );

    return {
      id: membership.id,
      orgId: membership.orgId,
      userId: membership.userId,
      role: this.mapRole(membership.role),
      roles: roles.map((role) => this.mapRole(role)),
      user: {
        id: membership.user.id,
        email: membership.user.email,
        firstName: membership.user.firstName,
        lastName: membership.user.lastName,
        orgId: membership.orgId,
        roleIds,
        permissions
      }
    };
  }
}
