import { ForbiddenException, UseGuards } from "@nestjs/common";
import { Args, Context, Query, Resolver } from "@nestjs/graphql";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { ArchiveService } from "../../modules/archive/archive.service";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import {
  ArchiveCalendarInput,
  ArchiveDetailArgs,
  ArchiveQueryInput,
} from "../dto/archive.input";
import type { GqlRequest } from "../graphql.types";
import {
  ArchiveCalendarDayModel,
  ArchiveDetailModel,
  ArchiveDigestModel,
} from "../models/archive.model";

@Resolver()
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class ArchiveResolver {
  constructor(private readonly archiveService: ArchiveService) {}

  @HasPermission("items.read")
  @Query(() => ArchiveDigestModel)
  async archiveDigest(
    @Context("req") req: GqlRequest,
    @Args("input") input: ArchiveQueryInput,
  ): Promise<ArchiveDigestModel> {
    const user = this.requireUser(req);
    return this.archiveService.getDigest(user.orgId, input);
  }

  @HasPermission("items.read")
  @Query(() => [ArchiveCalendarDayModel])
  async archiveCalendar(
    @Context("req") req: GqlRequest,
    @Args("input") input: ArchiveCalendarInput,
  ): Promise<ArchiveCalendarDayModel[]> {
    const user = this.requireUser(req);
    return this.archiveService.getCalendar(user.orgId, input);
  }

  @HasPermission("items.read")
  @Query(() => ArchiveDetailModel, { nullable: true })
  async archiveDetail(
    @Context("req") req: GqlRequest,
    @Args() args: ArchiveDetailArgs,
  ): Promise<ArchiveDetailModel | null> {
    const user = this.requireUser(req);
    return this.archiveService.getDetail(user.orgId, args.processedArticleId);
  }

  private requireUser(req: GqlRequest): AuthenticatedUser {
    const user = req?.user as AuthenticatedUser | undefined;
    if (!user) {
      throw new ForbiddenException("Unauthenticated");
    }
    return user;
  }
}
