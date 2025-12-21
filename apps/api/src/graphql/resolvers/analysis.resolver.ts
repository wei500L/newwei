import { ForbiddenException, Inject, UseGuards } from "@nestjs/common";
import { Args, Context, Int, Mutation, Query, Resolver, Subscription } from "@nestjs/graphql";
import { PubSubEngine , withFilter } from "graphql-subscriptions";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { ANALYSIS_PUBSUB } from "../../modules/analysis/analysis.pubsub";
import { AnalysisService } from "../../modules/analysis/analysis.service";
import { AuthenticatedUser } from "../../modules/auth/auth.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import { AnomalyAnalysisInput, CorrelationAnalysisInput } from "../dto/analysis.input";
import type { GqlRequest } from "../graphql.types";
import { AnalysisResultModel } from "../models/analysis.model";


@Resolver()
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class AnalysisResolver {
  constructor(
    private readonly analysisService: AnalysisService,
    @Inject(ANALYSIS_PUBSUB) private readonly pubsub: PubSubEngine
  ) {}

  @HasPermission("analysis.read")
  @Query(() => [AnalysisResultModel])
  async analysisResults(
    @Context("req") req: GqlRequest,
    @Args("limit", { type: () => Int, nullable: true }) limit?: number
  ): Promise<AnalysisResultModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const results = await this.analysisService.listResults(requester.orgId, limit ?? 50);
    return results.map((result) => ({
      id: result._id?.toString?.() ?? result.id,
      type: result.type,
      status: result.status,
      summary: result.summary ?? undefined,
      error: result.error ?? undefined,
      input: result.input as Record<string, unknown> | null,
      output: result.output as Record<string, unknown> | null,
      createdAt: result.createdAt ?? new Date()
    }));
  }

  @HasPermission("analysis.run")
  @Mutation(() => AnalysisResultModel)
  async requestCorrelationAnalysis(
    @Context("req") req: GqlRequest,
    @Args("input") input: CorrelationAnalysisInput
  ): Promise<AnalysisResultModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const record = await this.analysisService.submitCorrelation(requester.orgId, input, requester.id);
    return {
      id: record.id,
      type: "correlation",
      status: "pending",
      createdAt: record.createdAt,
      summary: record.summary ?? undefined,
      input: record.input as Record<string, unknown> | null
    };
  }

  @HasPermission("analysis.run")
  @Mutation(() => AnalysisResultModel)
  async requestAnomalyExplanation(
    @Context("req") req: GqlRequest,
    @Args("input") input: AnomalyAnalysisInput
  ): Promise<AnalysisResultModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const record = await this.analysisService.submitAnomaly(requester.orgId, input, requester.id);
    return {
      id: record.id,
      type: "anomaly",
      status: "pending",
      createdAt: record.createdAt,
      summary: record.summary ?? undefined,
      input: record.input as Record<string, unknown> | null
    };
  }

  @HasPermission("analysis.read")
  @Subscription(() => AnalysisResultModel, {
    name: "analysisEvents",
    resolve: (payload: { event: AnalysisResultModel }) => ({
      id: payload.result.id,
      type: payload.result.type,
      status: payload.result.status,
      summary: payload.result.summary ?? undefined,
      createdAt: payload.result.createdAt,
      input: null,
      output: null,
      error: payload.result.error ?? undefined
    })
  })
  analysisEventsSubscription(@Context("req") req: GqlRequest) {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    return withFilter(
      () => this.pubsub.asyncIterator("analysisEvents"),
      (payload: { orgId: string }) => payload.orgId === requester.orgId
    )();
  }
}
