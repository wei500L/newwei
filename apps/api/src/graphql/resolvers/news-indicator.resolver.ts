import { ForbiddenException, UseGuards } from "@nestjs/common";
import { Args, Context, Int, Mutation, Query, Resolver } from "@nestjs/graphql";
import { NewsIndicatorFeatureMetric, NewsIndicatorScopeType } from "@prisma/client";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import { NewsIndicatorAssociationService } from "../../modules/news-indicator/news-indicator-association.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import type { GqlRequest } from "../graphql.types";
import { EconomicDataItemModel } from "../models/economic-data.model";
import {
  NewsIndicatorAssociationBacktestRunModel,
  NewsIndicatorAssociationModel
} from "../models/news-indicator.model";

@Resolver()
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class NewsIndicatorResolver {
  constructor(private readonly associations: NewsIndicatorAssociationService) {}

  @HasPermission("dashboard.read")
  @Query(() => [NewsIndicatorAssociationModel])
  async newsIndicatorAssociations(
    @Context("req") req: GqlRequest,
    @Args("limit", { type: () => Int, nullable: true }) limit?: number,
    @Args("indicatorSlug", { nullable: true }) indicatorSlug?: string,
    @Args("scopeType", { type: () => NewsIndicatorScopeType, nullable: true }) scopeType?: NewsIndicatorScopeType,
    @Args("scopeKey", { nullable: true }) scopeKey?: string,
    @Args("featureMetric", { type: () => NewsIndicatorFeatureMetric, nullable: true }) featureMetric?: NewsIndicatorFeatureMetric
  ): Promise<NewsIndicatorAssociationModel[]> {
    const user = this.requireUser(req);
    const rows = await this.associations.listAssociations(user.orgId, {
      limit,
      indicatorSlug,
      scopeType,
      scopeKey,
      featureMetric
    });

    return rows.map((row) => this.toAssociationModel(row));
  }

  @HasPermission("dashboard.read")
  @Query(() => NewsIndicatorAssociationModel, { nullable: true })
  async newsIndicatorAssociation(
    @Context("req") req: GqlRequest,
    @Args("id") id: string,
    @Args("backtestsLimit", { type: () => Int, nullable: true }) backtestsLimit?: number
  ): Promise<NewsIndicatorAssociationModel | null> {
    const user = this.requireUser(req);
    const row = await this.associations.getAssociation(user.orgId, id, {
      backtestsLimit: typeof backtestsLimit === "number" ? backtestsLimit : 10
    });
    if (!row) {
      return null;
    }
    return this.toAssociationModel(row, {
      backtests: Array.isArray(row.backtests) ? row.backtests.map((bt) => this.toBacktestModel(bt)) : undefined
    });
  }

  @HasPermission("settings.manage")
  @Mutation(() => Boolean)
  async refreshNewsIndicatorAssociations(@Context("req") req: GqlRequest): Promise<boolean> {
    const user = this.requireUser(req);
    await this.associations.refreshOrg(user.orgId);
    return true;
  }

  private toAssociationModel(row: any, extras?: { backtests?: NewsIndicatorAssociationBacktestRunModel[] }): NewsIndicatorAssociationModel {
    const indicator = row.indicatorItem;
    const indicatorModel: EconomicDataItemModel = {
      slug: indicator.slug,
      displayName: indicator.displayName ?? indicator.slug,
      groupLabel: indicator.groupLabel ?? undefined,
      defaultUnit: indicator.defaultUnit ?? null,
      metadata: (indicator.metadata as Record<string, unknown> | null) ?? null
    };

    const latestBacktest = Array.isArray(row.backtests) && row.backtests.length > 0 ? row.backtests[0] : null;

    return {
      id: row.id,
      scopeType: row.scopeType,
      scopeKey: row.scopeKey,
      scopeKeyType: row.scopeKeyType,
      featureMetric: row.featureMetric,
      indicator: indicatorModel,
      windowDays: row.windowDays,
      lagDays: row.lagDays,
      correlation: row.correlation,
      pValue: row.pValue ?? null,
      sampleSize: row.sampleSize,
      analyzedStartAt: row.analyzedStartAt,
      analyzedEndAt: row.analyzedEndAt,
      lastEvaluatedAt: row.lastEvaluatedAt,
      metadata: row.metadata ?? null,
      latestBacktest: latestBacktest ? this.toBacktestModel(latestBacktest) : null,
      ...(extras?.backtests ? { backtests: extras.backtests } : {})
    };
  }

  private toBacktestModel(row: any): NewsIndicatorAssociationBacktestRunModel {
    return {
      id: row.id,
      status: row.status,
      windowStart: row.windowStart,
      windowEnd: row.windowEnd,
      config: row.config ?? null,
      metrics: row.metrics ?? null,
      error: row.error ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
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

