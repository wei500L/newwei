import {
  Args,
  Context,
  Mutation,
  Query,
  ResolveField,
  Resolver,
  Parent
} from "@nestjs/graphql";
import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { RbacService } from "../../modules/rbac/rbac.service";
import { PermissionModel, RoleModel, MembershipModel } from "../models/rbac.model";
import { HasPermission } from "../decorators/has-permission.decorator";
import type DataLoader from "dataloader";
import { Loader } from "nestjs-dataloader";
import { UserLoader } from "../loaders/user.loader";
import { UserModel } from "../models/user.model";
import { AuthenticatedUser } from "../../modules/auth/auth.service";
import { ForbiddenException, UseGuards } from "@nestjs/common";
import { AssignRoleInput, UpdateRoleInput } from "../dto/rbac.input";

@Resolver(() => MembershipModel)
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class RbacResolver {
  constructor(private readonly rbacService: RbacService) {}

  @HasPermission("roles.read")
  @Query(() => [RoleModel])
  async roles(
    @Context("req") req: any,
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
  async memberships(@Context("req") req: any): Promise<MembershipModel[]> {
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
    @Context("req") req: any,
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
    @Context("req") req: any,
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
    @Loader(UserLoader) userLoader: DataLoader<string, any>
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

  private mapRole(role: any): RoleModel {
    return {
      id: role.id,
      name: role.name,
      description: role.description ?? undefined,
      isSystem: role.isSystem,
      permissions: role.permissions.map((permission: any) => ({
        id: permission.permission.id,
        name: permission.permission.name,
        description: permission.permission.description ?? undefined
      }))
    };
  }

  private mapMembership(membership: any): MembershipModel {
    return {
      id: membership.id,
      orgId: membership.orgId,
      userId: membership.userId,
      role: this.mapRole(membership.role),
      user: {
        id: membership.user.id,
        email: membership.user.email,
        firstName: membership.user.firstName,
        lastName: membership.user.lastName,
        orgId: membership.orgId,
        roleIds: [membership.roleId],
        permissions: membership.role.permissions.map(
          (permission: any) => permission.permission.name
        )
      }
    };
  }
}
