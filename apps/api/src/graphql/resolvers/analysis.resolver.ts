import { ForbiddenException, Inject, UseGuards } from "@nestjs/common";
import { Args, Context, Int, Mutation, Query, Resolver, Subscription } from "@nestjs/graphql";
import { PubSubEngine , withFilter } from "graphql-subscriptions";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { ANALYSIS_PUBSUB } from "../../modules/analysis/analysis.pubsub";
import { AnalysisService } from "../../modules/analysis/analysis.service";
import { AuthenticatedUser } from "../../modules/auth/auth.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import {
  AnomalyAnalysisInput,
  CorrelationAnalysisInput,
  GeoTransportAnalysisInput,
} from "../dto/analysis.input";
import type { GqlRequest } from "../graphql.types";
import { AnalysisResultModel, AnalysisStatus, AnalysisType } from "../models/analysis.model";


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
      type: AnalysisResolver.toAnalysisType(result.type),
      status: AnalysisResolver.toAnalysisStatus(result.status),
      summary: result.summary ?? undefined,
      error: result.error ?? undefined,
      input: (result.input as Record<string, unknown> | null | undefined) ?? null,
      output: (result.output as Record<string, unknown> | null | undefined) ?? null,
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
      type: AnalysisType.correlation,
      status: AnalysisStatus.pending,
      createdAt: record.createdAt ?? new Date(),
      summary: record.summary ?? undefined,
      input: (record.input as Record<string, unknown> | null | undefined) ?? null
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
      type: AnalysisType.anomaly,
      status: AnalysisStatus.pending,
      createdAt: record.createdAt ?? new Date(),
      summary: record.summary ?? undefined,
      input: (record.input as Record<string, unknown> | null | undefined) ?? null
    };
  }

  @HasPermission("analysis.run")
  @Mutation(() => AnalysisResultModel)
  async requestGeoTransportAnalysis(
    @Context("req") req: GqlRequest,
    @Args("input") input: GeoTransportAnalysisInput
  ): Promise<AnalysisResultModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const record = await this.analysisService.submitGeoTransport(
      requester.orgId,
      {
        transportKinds: input.transportKinds,
        startDate: input.startDate,
        endDate: input.endDate,
        ...(input.bbox?.length === 4
          ? { bbox: input.bbox as [number, number, number, number] }
          : {}),
        ...(input.objectKeys?.length ? { objectKeys: input.objectKeys } : {}),
      },
      requester.id,
    );
    return {
      id: record.id,
      type: AnalysisType.geo_transport,
      status: AnalysisStatus.pending,
      createdAt: record.createdAt ?? new Date(),
      summary: record.summary ?? undefined,
      input: (record.input as Record<string, unknown> | null | undefined) ?? null
    };
  }

  @HasPermission("analysis.read")
  @Subscription(() => AnalysisResultModel, {
    name: "analysisEvents",
    resolve: (payload: {
      result: {
        id: string;
        type: string;
        status: string;
        summary?: string;
        error?: string;
        createdAt: string;
      };
    }) => ({
      id: payload.result.id,
      type: AnalysisResolver.toAnalysisType(payload.result.type),
      status: AnalysisResolver.toAnalysisStatus(payload.result.status),
      summary: payload.result.summary ?? null,
      createdAt: new Date(payload.result.createdAt),
      input: null,
      output: null,
      error: payload.result.error ?? null
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

  private static toAnalysisType(value: unknown): AnalysisType {
    if (value === AnalysisType.geo_transport || value === "geo_transport") {
      return AnalysisType.geo_transport;
    }
    if (value === AnalysisType.anomaly || value === "anomaly") {
      return AnalysisType.anomaly;
    }
    return AnalysisType.correlation;
  }

  private static toAnalysisStatus(value: unknown): AnalysisStatus {
    switch (value) {
      case AnalysisStatus.pending:
      case "pending":
        return AnalysisStatus.pending;
      case AnalysisStatus.running:
      case "running":
        return AnalysisStatus.running;
      case AnalysisStatus.completed:
      case "completed":
        return AnalysisStatus.completed;
      case AnalysisStatus.failed:
      case "failed":
        return AnalysisStatus.failed;
      default:
        return AnalysisStatus.pending;
    }
  }
}
