import { ForbiddenException, UseGuards } from "@nestjs/common";
import { Args, Context, Int, Query, Resolver } from "@nestjs/graphql";
import { NewsEventStatus } from "@prisma/client";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import { NewsEventsService } from "../../modules/news-events/news-events.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import type { GqlRequest } from "../graphql.types";
import {
  NewsEventModel,
  NewsEventItemModel,
  NewsEventTimelineEntryModel
} from "../models/news-events.model";

@Resolver(() => NewsEventModel)
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class NewsEventsResolver {
  constructor(private readonly events: NewsEventsService) {}

  @HasPermission("items.read")
  @Query(() => [NewsEventModel])
  async newsEvents(
    @Context("req") req: GqlRequest,
    @Args("limit", { type: () => Int, nullable: true }) limit?: number,
    @Args("windowDays", { type: () => Int, nullable: true }) windowDays?: number,
    @Args("status", { type: () => NewsEventStatus, nullable: true }) status?: NewsEventStatus
  ): Promise<NewsEventModel[]> {
    const user = this.requireUser(req);
    const rows = await this.events.listEvents(user.orgId, { limit, windowDays, status });
    return rows.map((row) => this.toModel(row));
  }

  @HasPermission("items.read")
  @Query(() => NewsEventModel, { nullable: true })
  async newsEvent(
    @Context("req") req: GqlRequest,
    @Args("id") id: string,
    @Args("itemsLimit", { type: () => Int, nullable: true }) itemsLimit?: number,
    @Args("timelineLimit", { type: () => Int, nullable: true }) timelineLimit?: number
  ): Promise<NewsEventModel | null> {
    const user = this.requireUser(req);
    const row = await this.events.getEvent(user.orgId, id, { itemsLimit, timelineLimit });
    if (!row) {
      return null;
    }
    return this.toModel(row, {
      items: row.items.map((item) => this.toItemModel(item)),
      timeline: row.timeline.map((entry) => this.toTimelineModel(entry))
    });
  }

  private toModel(
    row: any,
    extras?: { items: NewsEventItemModel[]; timeline: NewsEventTimelineEntryModel[] }
  ): NewsEventModel {
    return {
      id: row.id,
      status: row.status,
      language: row.language,
      primaryTopic: row.primaryTopic,
      primaryEntity: row.primaryEntity,
      title: row.title,
      summary: row.summary,
      startAt: row.startAt,
      lastAt: row.lastAt,
      itemCount: row._count?.items ?? 0,
      representativeProcessedArticleId: row.representativeProcessedArticleId,
      representativeProcessedItemId: row.representativeProcessedItemId,
      metadata: row.metadata ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(extras ? { items: extras.items, timeline: extras.timeline } : {})
    };
  }

  private toItemModel(item: any): NewsEventItemModel {
    return {
      id: item.id,
      eventId: item.eventId,
      processedArticleId: item.processedArticleId,
      processedItemId: item.processedItemId,
      similarity: item.similarity,
      assignedBy: item.assignedBy,
      createdAt: item.createdAt,
      processedArticle: {
        id: item.processedArticle.id,
        articleId: item.processedArticle.articleId,
        title: item.processedArticle.title,
        summary: item.processedArticle.summary,
        publishedAt: item.processedArticle.publishedAt,
        language: item.processedArticle.language,
        processedAt: item.processedArticle.processedAt,
        article: {
          id: item.processedArticle.article.id,
          url: item.processedArticle.article.url,
          sourceLabel: item.processedArticle.article.sourceLabel,
          crawlAt: item.processedArticle.article.crawlAt
        }
      }
    };
  }

  private toTimelineModel(entry: any): NewsEventTimelineEntryModel {
    return {
      id: entry.id,
      eventId: entry.eventId,
      bucketStart: entry.bucketStart,
      title: entry.title,
      summary: entry.summary,
      keyPoints: entry.keyPoints ?? null,
      referencedArticleIds: entry.referencedArticleIds ?? null,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt
    };
  }

  private requireUser(req: GqlRequest): AuthenticatedUser {
    const user = req?.user as AuthenticatedUser | undefined;
    if (!user) {
      throw new ForbiddenException("Unauthenticated");
    }
    return user;
  }
}
