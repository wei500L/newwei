import { ForbiddenException, UseGuards } from "@nestjs/common";
import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";

import { AllowAuthenticated } from "../../common/decorators/allow-authenticated.decorator";
import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import { OrgService } from "../../modules/org/org.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import { CreateOrgInput, SetOrgActiveInput, UpdateOrgInput } from "../dto/org.input";
import type { GqlRequest } from "../graphql.types";
import { OrgModel } from "../models/org.model";

@Resolver(() => OrgModel)
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class OrgResolver {
  constructor(private readonly orgService: OrgService) {}

  @Query(() => [OrgModel])
  @AllowAuthenticated()
  async myOrganizations(@Context("req") req: GqlRequest): Promise<OrgModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const orgs = await this.orgService.listOrganizationsForUser(requester.id);
    return orgs;
  }

  @HasPermission("org.write")
  @Mutation(() => OrgModel)
  async createOrg(@Context("req") req: GqlRequest, @Args("input") input: CreateOrgInput): Promise<OrgModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    return this.orgService.createOrg(requester.id, input);
  }

  @HasPermission("org.write")
  @Mutation(() => OrgModel)
  async updateOrg(@Context("req") req: GqlRequest, @Args("input") input: UpdateOrgInput): Promise<OrgModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    return this.orgService.updateOrg(requester.id, input);
  }

  @HasPermission("org.write")
  @Mutation(() => OrgModel)
  async setOrgActive(
    @Context("req") req: GqlRequest,
    @Args("input") input: SetOrgActiveInput
  ): Promise<OrgModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    return this.orgService.setOrgActive(requester.id, input.id, input.isActive);
  }
}
