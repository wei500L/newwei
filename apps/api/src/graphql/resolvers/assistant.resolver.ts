import { BadRequestException, ForbiddenException, Inject, UseGuards } from "@nestjs/common";
import { Args, Context, Int, Mutation, Query, Resolver, Subscription } from "@nestjs/graphql";
import { PubSubEngine, withFilter } from "graphql-subscriptions";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { ASSISTANT_PUBSUB } from "../../modules/assistant/assistant.pubsub";
import { AssistantService } from "../../modules/assistant/assistant.service";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import { AssistantForecastInput, AssistantQueryInput, AssistantReportInput } from "../dto/assistant.input";
import type { GqlRequest } from "../graphql.types";
import {
  AssistantLlmApiSurface,
  AssistantRunModel,
  AssistantRunStatus,
  AssistantRunType,
  AssistantRuntimeCapabilitiesModel,
  EconomicSeriesSuggestionModel
} from "../models/assistant.model";

@Resolver()
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class AssistantResolver {
  constructor(
    private readonly assistantService: AssistantService,
    @Inject(ASSISTANT_PUBSUB) private readonly pubsub: PubSubEngine
  ) {}

  @HasPermission("assistant.read")
  @Query(() => [AssistantRunModel])
  async assistantRuns(
    @Context("req") req: GqlRequest,
    @Args("limit", { type: () => Int, nullable: true }) limit?: number
  ): Promise<AssistantRunModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const results = await this.assistantService.listRuns(requester.orgId, limit ?? 50);
    return results.map((result) => ({
      id: result._id?.toString?.() ?? result.id,
      type: AssistantResolver.toRunType(result.type),
      status: AssistantResolver.toRunStatus(result.status),
      summary: result.summary ?? undefined,
      error: result.error ?? undefined,
      input: (result.input as Record<string, unknown> | null | undefined) ?? null,
      output: (result.output as Record<string, unknown> | null | undefined) ?? null,
      conversationId: typeof result.conversationId === "string" ? result.conversationId : null,
      createdAt: result.createdAt ?? new Date()
    }));
  }

  @HasPermission("assistant.run")
  @Query(() => [EconomicSeriesSuggestionModel])
  async assistantEconomicSeriesSuggestions(
    @Context("req") req: GqlRequest,
    @Args("term") term: string,
    @Args("limit", { type: () => Int, nullable: true, defaultValue: 8 }) limit = 8
  ): Promise<EconomicSeriesSuggestionModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }

    const normalizedTerm = term.trim();
    if (normalizedTerm.length < 2) {
      throw new BadRequestException("term must be at least 2 characters");
    }
    if (normalizedTerm.length > 100) {
      throw new BadRequestException("term must be at most 100 characters");
    }

    const resolvedLimit = Math.min(Math.max(limit, 1), 20);

    // NOTE: Add per-user/IP rate limiting at gateway or resolver level to prevent suggestion endpoint abuse.
    const candidates = await this.assistantService.searchEconomicSeriesCandidates(normalizedTerm, resolvedLimit);

    return candidates.map((candidate) => ({
      slug: candidate.slug,
      displayName: candidate.displayName,
      description: candidate.description ?? null,
      docUrl: candidate.sourceDocUrl ?? null
    }));
  }

  @HasPermission("assistant.read")
  @Query(() => AssistantRuntimeCapabilitiesModel)
  async assistantRuntimeCapabilities(
    @Context("req") req: GqlRequest
  ): Promise<AssistantRuntimeCapabilitiesModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const capabilities = await this.assistantService.getRuntimeCapabilities();
    return {
      assistantModel: capabilities.assistantModel,
      apiSurface:
        capabilities.apiSurface === "responses"
          ? AssistantLlmApiSurface.responses
          : capabilities.apiSurface === "chat_completions"
            ? AssistantLlmApiSurface.chat_completions
            : null,
      webSearchSupported: capabilities.webSearchSupported
    };
  }

  @HasPermission("assistant.run")
  @Mutation(() => AssistantRunModel)
  async requestAssistantQuery(
    @Context("req") req: GqlRequest,
    @Args("input") input: AssistantQueryInput
  ): Promise<AssistantRunModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const record = await this.assistantService.submitQuery(requester.orgId, input, requester.id);
    return {
      id: record.id,
      type: AssistantRunType.query,
      status: AssistantRunStatus.pending,
      createdAt: record.createdAt ?? new Date(),
      summary: record.summary ?? undefined,
      input: (record.input as Record<string, unknown> | null | undefined) ?? null,
      conversationId: typeof record.conversationId === "string" ? record.conversationId : null,
      output: null,
      error: null
    };
  }

  @HasPermission("assistant.run")
  @Mutation(() => AssistantRunModel)
  async requestAssistantReport(
    @Context("req") req: GqlRequest,
    @Args("input") input: AssistantReportInput
  ): Promise<AssistantRunModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const record = await this.assistantService.submitReport(requester.orgId, input, requester.id);
    return {
      id: record.id,
      type: AssistantRunType.report,
      status: AssistantRunStatus.pending,
      createdAt: record.createdAt ?? new Date(),
      summary: record.summary ?? undefined,
      input: (record.input as Record<string, unknown> | null | undefined) ?? null,
      output: null,
      error: null
    };
  }

  @HasPermission("assistant.run")
  @Mutation(() => AssistantRunModel)
  async requestAssistantForecast(
    @Context("req") req: GqlRequest,
    @Args("input") input: AssistantForecastInput
  ): Promise<AssistantRunModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    const record = await this.assistantService.submitForecast(requester.orgId, input, requester.id);
    return {
      id: record.id,
      type: AssistantRunType.forecast,
      status: AssistantRunStatus.pending,
      createdAt: record.createdAt ?? new Date(),
      summary: record.summary ?? undefined,
      input: (record.input as Record<string, unknown> | null | undefined) ?? null,
      output: null,
      error: null
    };
  }

  @HasPermission("assistant.run")
  @Mutation(() => Boolean)
  async deleteAssistantRun(
    @Context("req") req: GqlRequest,
    @Args("runId") runId: string
  ): Promise<boolean> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }

    const normalizedRunId = runId.trim();
    if (!normalizedRunId) {
      throw new BadRequestException("runId is required");
    }

    return this.assistantService.deleteRun(requester.orgId, normalizedRunId);
  }

  @HasPermission("assistant.read")
  @Subscription(() => AssistantRunModel, {
    name: "assistantEvents",
    resolve: (payload: {
      run: {
        id: string;
        type: string;
        status: string;
        summary?: string;
        error?: string;
        createdAt: string;
      };
    }) => ({
      id: payload.run.id,
      type: AssistantResolver.toRunType(payload.run.type),
      status: AssistantResolver.toRunStatus(payload.run.status),
      summary: payload.run.summary ?? null,
      error: payload.run.error ?? null,
      createdAt: new Date(payload.run.createdAt),
      input: null,
      output: null
    })
  })
  assistantEventsSubscription(@Context("req") req: GqlRequest) {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    return withFilter(
      () => this.pubsub.asyncIterator("assistantEvents"),
      (payload: { orgId: string }) => payload.orgId === requester.orgId
    )();
  }

  private static toRunType(value: unknown): AssistantRunType {
    switch (value) {
      case AssistantRunType.query:
      case "query":
        return AssistantRunType.query;
      case AssistantRunType.report:
      case "report":
        return AssistantRunType.report;
      case AssistantRunType.forecast:
      case "forecast":
        return AssistantRunType.forecast;
      default:
        return AssistantRunType.query;
    }
  }

  private static toRunStatus(value: unknown): AssistantRunStatus {
    switch (value) {
      case AssistantRunStatus.pending:
      case "pending":
        return AssistantRunStatus.pending;
      case AssistantRunStatus.running:
      case "running":
        return AssistantRunStatus.running;
      case AssistantRunStatus.completed:
      case "completed":
        return AssistantRunStatus.completed;
      case AssistantRunStatus.failed:
      case "failed":
        return AssistantRunStatus.failed;
      default:
        return AssistantRunStatus.pending;
    }
  }
}
