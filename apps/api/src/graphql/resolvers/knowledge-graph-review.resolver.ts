import { ForbiddenException, UseGuards } from "@nestjs/common";
import { Args, Context, Directive, Float, Int, Mutation, Query, Resolver } from "@nestjs/graphql";

import { Permissions } from "../../common/decorators/permissions.decorator";
import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import { KnowledgeGraphReviewService } from "../../modules/knowledge-graph/knowledge-graph-review.service";
import { KnowledgeGraphSettingsService } from "../../modules/knowledge-graph/knowledge-graph-settings.service";
import { ReviewKnowledgeGraphEvidenceInput } from "../dto/knowledge-graph-review.input";
import type { GqlRequest } from "../graphql.types";
import {
  KnowledgeGraphEvidenceReviewItemModel,
  KnowledgeGraphReviewArticleModel,
  KnowledgeGraphReviewEdgeModel
} from "../models/knowledge-graph-review.model";

@Resolver()
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class KnowledgeGraphReviewResolver {
  constructor(
    private readonly settings: KnowledgeGraphSettingsService,
    private readonly review: KnowledgeGraphReviewService
  ) {}

  @Permissions("settings.manage", "knowledgegraph.review")
  @Directive('@hasPermission(name: "knowledgegraph.review")')
  @Query(() => [KnowledgeGraphEvidenceReviewItemModel])
  async knowledgeGraphEvidenceReviewQueue(
    @Context("req") req: GqlRequest,
    @Args("limit", { type: () => Int, nullable: true }) limit?: number,
    @Args("maxConfidence", { type: () => Float, nullable: true }) maxConfidence?: number,
    @Args("onlyUnreviewed", { type: () => Boolean, nullable: true }) onlyUnreviewed?: boolean
  ): Promise<KnowledgeGraphEvidenceReviewItemModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }

    const settings = await this.settings.getSettings(requester.orgId);
    if (!settings.enabled) {
      return [];
    }

    const rows = await this.review.listEvidenceReviewQueue({
      orgId: requester.orgId,
      limit: typeof limit === "number" ? limit : 50,
      maxEvidenceConfidence: typeof maxConfidence === "number" ? maxConfidence : settings.minEdgeConfidence,
      onlyUnreviewed: typeof onlyUnreviewed === "boolean" ? onlyUnreviewed : true
    });

    return rows
      .map((row) => {
        const processed = row.article.processed;

        const article: KnowledgeGraphReviewArticleModel = {
          id: row.articleId,
          url: row.article.url,
          title: processed?.title ?? row.article.titleGuess ?? null,
          summary: processed?.summary ?? null,
          language: processed?.language ?? row.article.language ?? null,
          crawlAt: row.article.crawlAt
        };

        const edge: KnowledgeGraphReviewEdgeModel = {
          id: row.edgeId,
          type: row.edge.type,
          confidence: row.edge.confidence,
          weight: row.edge.weight,
          fromEntity: {
            id: row.edge.fromEntity.id,
            name: row.edge.fromEntity.canonicalName,
            type: row.edge.fromEntity.type,
            properties: (row.edge.fromEntity.properties as Record<string, unknown> | null) ?? null
          },
          toEntity: {
            id: row.edge.toEntity.id,
            name: row.edge.toEntity.canonicalName,
            type: row.edge.toEntity.type,
            properties: (row.edge.toEntity.properties as Record<string, unknown> | null) ?? null
          },
          properties: (row.edge.properties as Record<string, unknown> | null) ?? null
        };

        return {
          id: row.id,
          confidence: row.confidence,
          extractorVersion: row.extractorVersion ?? null,
          createdAt: row.createdAt,
          evidence: (row.evidence as Record<string, unknown> | null) ?? null,
          edge,
          article
        } satisfies KnowledgeGraphEvidenceReviewItemModel;
      })
      .filter(Boolean);
  }

  @Permissions("settings.manage", "knowledgegraph.review")
  @Directive('@hasPermission(name: "knowledgegraph.review")')
  @Mutation(() => KnowledgeGraphEvidenceReviewItemModel, { nullable: true })
  async reviewKnowledgeGraphEvidence(
    @Context("req") req: GqlRequest,
    @Args("input") input: ReviewKnowledgeGraphEvidenceInput
  ): Promise<KnowledgeGraphEvidenceReviewItemModel | null> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }

    const settings = await this.settings.getSettings(requester.orgId);
    if (!settings.enabled) {
      return null;
    }

    const row = await this.review.reviewEvidence({
      orgId: requester.orgId,
      actorId: requester.id,
      evidenceId: input.evidenceId,
      status: input.status,
      note: input.note ?? null,
      correctedRelation: input.correctedRelation ?? null
    });

    if (!row) {
      return null;
    }

    const processed = row.article.processed;

    const article: KnowledgeGraphReviewArticleModel = {
      id: row.articleId,
      url: row.article.url,
      title: processed?.title ?? row.article.titleGuess ?? null,
      summary: processed?.summary ?? null,
      language: processed?.language ?? row.article.language ?? null,
      crawlAt: row.article.crawlAt
    };

    const edge: KnowledgeGraphReviewEdgeModel = {
      id: row.edgeId,
      type: row.edge.type,
      confidence: row.edge.confidence,
      weight: row.edge.weight,
      fromEntity: {
        id: row.edge.fromEntity.id,
        name: row.edge.fromEntity.canonicalName,
        type: row.edge.fromEntity.type,
        properties: (row.edge.fromEntity.properties as Record<string, unknown> | null) ?? null
      },
      toEntity: {
        id: row.edge.toEntity.id,
        name: row.edge.toEntity.canonicalName,
        type: row.edge.toEntity.type,
        properties: (row.edge.toEntity.properties as Record<string, unknown> | null) ?? null
      },
      properties: (row.edge.properties as Record<string, unknown> | null) ?? null
    };

    return {
      id: row.id,
      confidence: row.confidence,
      extractorVersion: row.extractorVersion ?? null,
      createdAt: row.createdAt,
      evidence: (row.evidence as Record<string, unknown> | null) ?? null,
      edge,
      article
    } satisfies KnowledgeGraphEvidenceReviewItemModel;
  }
}
