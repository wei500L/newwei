import { ForbiddenException, UseGuards } from "@nestjs/common";
import { Args, Context, Int, Query, Resolver } from "@nestjs/graphql";
import { KnowledgeEntityType, KnowledgeRelationType } from "@prisma/client";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import { CacheService } from "../../modules/cache/cache.service";
import { KnowledgeGraphSettingsService } from "../../modules/knowledge-graph/knowledge-graph-settings.service";
import { KnowledgeGraphService } from "../../modules/knowledge-graph/knowledge-graph.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import type { GqlRequest } from "../graphql.types";
import { ArticleEntityLinkModel } from "../models/article-entity-link.model";
import { KnowledgeGraphEdgeEvidenceItemModel } from "../models/knowledge-graph-evidence.model";
import { KnowledgeGraphModel, KnowledgeGraphSubgraphInput } from "../models/knowledge-graph.model";

function normalizeEnumValue<T extends Record<string, string>>(value: string, enumObject: T): T[keyof T] | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const allowed = new Set(Object.values(enumObject));
  return allowed.has(normalized as T[keyof T]) ? (normalized as T[keyof T]) : undefined;
}

@Resolver()
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class KnowledgeGraphResolver {
  constructor(
    private readonly settings: KnowledgeGraphSettingsService,
    private readonly graph: KnowledgeGraphService,
    private readonly cache: CacheService
  ) {}

  @HasPermission("dashboards.read")
  @Query(() => KnowledgeGraphModel, { nullable: true, description: "Get a knowledge graph subgraph for a seed entity" })
  async getKnowledgeGraphSubgraph(
    @Context("req") req: GqlRequest,
    @Args("input") input: KnowledgeGraphSubgraphInput
  ): Promise<KnowledgeGraphModel | null> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }

    const settings = await this.settings.getSettings(requester.orgId);
    if (!settings.enabled) {
      return null;
    }

    const maxDepth = Math.min(5, Math.max(1, input.maxDepth ?? 2));
    const maxNodes = Math.min(500, Math.max(10, input.maxNodes ?? 200));

    const seedType = input.seedType
      ? normalizeEnumValue(input.seedType, KnowledgeEntityType)
      : undefined;

    const relationTypes = Array.isArray(input.relationTypes)
      ? input.relationTypes
          .map((value) => normalizeEnumValue(value, KnowledgeRelationType))
          .filter((value): value is KnowledgeRelationType => Boolean(value))
      : undefined;

    const cacheTtlSeconds = settings.cacheTtlSeconds ?? 0;
    const cacheKey = this.buildCacheKey({
      orgId: requester.orgId,
      seedName: input.seedName,
      seedType: seedType ?? null,
      maxDepth,
      maxNodes,
      relationTypes: relationTypes ?? null
    });

    const loader = async () => {
      const subgraph = await this.graph.getSubgraph({
        orgId: requester.orgId,
        seedName: input.seedName,
        seedType,
        maxDepth,
        maxNodes,
        relationTypes
      });

      if (!subgraph) {
        return null;
      }

      const nodes = subgraph.nodes.map((node) => ({
        id: node.id,
        name: node.canonicalName,
        type: node.type,
        properties: (node.properties as Record<string, unknown> | null) ?? null
      }));

      const edges = subgraph.edges.map((edge) => ({
        id: edge.id,
        from: edge.fromEntityId,
        to: edge.toEntityId,
        type: edge.type,
        weight: edge.weight,
        confidence: edge.confidence,
        properties: (edge.properties as Record<string, unknown> | null) ?? null
      }));

      const generatedAt = new Date().toISOString();

      return {
        seed: {
          id: subgraph.seed.id,
          name: subgraph.seed.canonicalName,
          type: subgraph.seed.type,
          properties: (subgraph.seed.properties as Record<string, unknown> | null) ?? null
        },
        nodes,
        edges,
        metadata: {
          totalNodes: nodes.length,
          totalEdges: edges.length,
          generatedAt
        }
      } satisfies Omit<KnowledgeGraphModel, "metadata"> & {
        metadata: Omit<KnowledgeGraphModel["metadata"], "generatedAt"> & { generatedAt: string };
      };
    };

    const cached =
      cacheTtlSeconds > 0
        ? await this.cache.wrap(cacheKey, cacheTtlSeconds, loader, {
            lockTtlMs: Math.min(300_000, Math.max(30_000, cacheTtlSeconds * 1000)),
            maxWaitMs: Math.min(300_000, Math.max(30_000, cacheTtlSeconds * 1000)),
            retryDelayMs: 200
          })
        : await loader();

    if (!cached) {
      return null;
    }

    return {
      ...cached,
      metadata: {
        ...cached.metadata,
        generatedAt: new Date(cached.metadata.generatedAt)
      }
    };
  }

  @HasPermission("items.read")
  @Query(() => [ArticleEntityLinkModel])
  async articleEntityLinks(
    @Context("req") req: GqlRequest,
    @Args("articleId") articleId: string,
    @Args("limit", { type: () => Int, nullable: true }) limit?: number
  ): Promise<ArticleEntityLinkModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }

    const settings = await this.settings.getSettings(requester.orgId);
    if (!settings.enabled) {
      return [];
    }

    const rows = await this.graph.listArticleEntityLinks(
      requester.orgId,
      articleId,
      typeof limit === "number" ? limit : 50
    );

    return rows.map((row) => ({
      articleId: row.articleId,
      mention: row.mention,
      confidence: row.confidence,
      createdAt: row.createdAt,
      entity: {
        id: row.entity.id,
        name: row.entity.canonicalName,
        type: row.entity.type,
        properties: (row.entity.properties as Record<string, unknown> | null) ?? null
      }
    }));
  }

  @HasPermission("dashboards.read")
  @Query(() => [KnowledgeGraphEdgeEvidenceItemModel])
  async knowledgeGraphEdgeEvidence(
    @Context("req") req: GqlRequest,
    @Args("edgeId") edgeId: string,
    @Args("limit", { type: () => Int, nullable: true }) limit?: number
  ): Promise<KnowledgeGraphEdgeEvidenceItemModel[]> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }

    const settings = await this.settings.getSettings(requester.orgId);
    if (!settings.enabled) {
      return [];
    }

    const rows = await this.graph.listEdgeEvidence(
      requester.orgId,
      edgeId,
      typeof limit === "number" ? limit : 20
    );

    return rows.map((row) => ({
      id: row.id,
      confidence: row.confidence,
      extractorVersion: row.extractorVersion,
      createdAt: row.createdAt,
      evidence: row.evidence,
      article: row.article
    }));
  }

  private buildCacheKey(input: {
    orgId: string;
    seedName: string;
    seedType: KnowledgeEntityType | null;
    maxDepth: number;
    maxNodes: number;
    relationTypes: KnowledgeRelationType[] | null;
  }) {
    const seedName = input.seedName.trim().toLowerCase();
    const seedType = input.seedType ?? "any";
    const relationTypes = input.relationTypes?.slice().sort().join(",") ?? "any";
    return `knowledgeGraph:subgraph:${input.orgId}:seed=${seedName}:type=${seedType}:depth=${input.maxDepth}:max=${input.maxNodes}:rels=${relationTypes}`;
  }
}
