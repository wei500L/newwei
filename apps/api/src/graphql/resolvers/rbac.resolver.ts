import { Context, Query, ResolveField, Resolver, UseGuards, Parent } from "@nestjs/graphql";
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
import { ForbiddenException } from "@nestjs/common";

@Resolver(() => MembershipModel)
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class RbacResolver {
  constructor(private readonly rbacService: RbacService) {}

  @HasPermission("roles.read")
  @Query(() => [RoleModel])
  async roles(@Context("req") req: any): Promise<RoleModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const data = await this.rbacService.listRoles(requester.orgId);
    return data.map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description ?? undefined,
      permissions: role.permissions.map((permission) => ({
        id: permission.permission.id,
        name: permission.permission.name,
        description: permission.permission.description ?? undefined
      }))
    }));
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
    return memberships.map((membership) => ({
      id: membership.id,
      orgId: membership.orgId,
      userId: membership.userId,
      role: {
        id: membership.role.id,
        name: membership.role.name,
        description: membership.role.description ?? undefined,
        permissions: membership.role.permissions.map((permission) => ({
          id: permission.permission.id,
          name: permission.permission.name,
          description: permission.permission.description ?? undefined
        }))
      },
      user: {
        id: membership.user.id,
        email: membership.user.email,
        firstName: membership.user.firstName,
        lastName: membership.user.lastName,
        orgId: membership.orgId,
        roleIds: [membership.roleId],
        permissions: membership.role.permissions.map((permission) => permission.permission.name)
      }
    }));
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
}
