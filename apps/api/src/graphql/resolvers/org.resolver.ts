import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { ForbiddenException, UseGuards } from "@nestjs/common";
import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { AllowAuthenticated } from "../../common/decorators/allow-authenticated.decorator";
import { HasPermission } from "../decorators/has-permission.decorator";
import { OrgModel } from "../models/org.model";
import { CreateOrgInput, SetOrgActiveInput, UpdateOrgInput } from "../dto/org.input";
import { OrgService } from "../../modules/org/org.service";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";

@Resolver(() => OrgModel)
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class OrgResolver {
  constructor(private readonly orgService: OrgService) {}

  @Query(() => [OrgModel])
  @AllowAuthenticated()
  async myOrganizations(@Context("req") req: any): Promise<OrgModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const orgs = await this.orgService.listOrganizationsForUser(requester.id);
    return orgs;
  }

  @HasPermission("org.write")
  @Mutation(() => OrgModel)
  async createOrg(@Context("req") req: any, @Args("input") input: CreateOrgInput): Promise<OrgModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    return this.orgService.createOrg(requester.id, input);
  }

  @HasPermission("org.write")
  @Mutation(() => OrgModel)
  async updateOrg(@Context("req") req: any, @Args("input") input: UpdateOrgInput): Promise<OrgModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    return this.orgService.updateOrg(requester.id, input);
  }

  @HasPermission("org.write")
  @Mutation(() => OrgModel)
  async setOrgActive(
    @Context("req") req: any,
    @Args("input") input: SetOrgActiveInput
  ): Promise<OrgModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    return this.orgService.setOrgActive(requester.id, input.id, input.isActive);
  }
}
