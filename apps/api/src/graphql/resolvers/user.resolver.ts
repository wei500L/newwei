import { Args, Context, Int, Query, Resolver } from "@nestjs/graphql";
import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { UserModel } from "../models/user.model";
import { PrismaService } from "../../modules/config/prisma.service";
import { AuthService, AuthenticatedUser } from "../../modules/auth/auth.service";
import { ForbiddenException, UseGuards } from "@nestjs/common";
import { HasPermission } from "../decorators/has-permission.decorator";
import { AllowAuthenticated } from "../../common/decorators/allow-authenticated.decorator";

function decodeCursor(cursor?: string | null) {
  return cursor ? Buffer.from(cursor, "base64").toString("utf8") : undefined;
}

@Resolver(() => UserModel)
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class UsersResolver {
  constructor(private readonly prisma: PrismaService, private readonly authService: AuthService) {}

  @Query(() => UserModel)
  @AllowAuthenticated()
  async me(@Context("req") req: any): Promise<UserModel> {
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
    @Context("req") req: any,
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
      this.toGraphQLUser({
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        orgId: user.memberships[0]?.orgId ?? requester.orgId,
        roleIds: user.memberships.map((membership) => membership.roleId),
        permissions: Array.from(
          new Set(
            user.memberships.flatMap((membership) =>
              membership.role.permissions.map((permission) => permission.permission.name)
            )
          )
        )
      })
    );
  }

  private toGraphQLUser(user: AuthenticatedUser): UserModel {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      orgId: user.orgId,
      roleIds: user.roleIds,
      permissions: user.permissions
    } satisfies UserModel;
  }
}
