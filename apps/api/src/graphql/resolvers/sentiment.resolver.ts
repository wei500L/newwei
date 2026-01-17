import { ForbiddenException, UseGuards } from "@nestjs/common";
import { Args, Context, Int, Query, Resolver } from "@nestjs/graphql";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import { SentimentService } from "../../modules/sentiment/sentiment.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import type { GqlRequest } from "../graphql.types";
import { EntitySentimentSnapshotModel, TopicSentimentSnapshotModel } from "../models/sentiment.model";

@Resolver()
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class SentimentResolver {
  constructor(private readonly sentiment: SentimentService) {}

  @HasPermission("dashboard.read")
  @Query(() => [EntitySentimentSnapshotModel])
  async entitySentimentSeries(
    @Context("req") req: GqlRequest,
    @Args("entityName") entityName: string,
    @Args("entityType", { nullable: true }) entityType?: string,
    @Args("days", { type: () => Int, nullable: true }) days?: number
  ): Promise<EntitySentimentSnapshotModel[]> {
    const user = this.requireUser(req);
    return this.sentiment.listEntitySnapshots(user.orgId, {
      entityName,
      entityType,
      days: typeof days === "number" ? days : 30
    });
  }

  @HasPermission("dashboard.read")
  @Query(() => [TopicSentimentSnapshotModel])
  async topicSentimentSeries(
    @Context("req") req: GqlRequest,
    @Args("topic") topic: string,
    @Args("days", { type: () => Int, nullable: true }) days?: number
  ): Promise<TopicSentimentSnapshotModel[]> {
    const user = this.requireUser(req);
    return this.sentiment.listTopicSnapshots(user.orgId, {
      topic,
      days: typeof days === "number" ? days : 30
    });
  }

  private requireUser(req: GqlRequest): AuthenticatedUser {
    const user = req?.user as AuthenticatedUser | undefined;
    if (!user) {
      throw new ForbiddenException("Unauthenticated");
    }
    return user;
  }
}

