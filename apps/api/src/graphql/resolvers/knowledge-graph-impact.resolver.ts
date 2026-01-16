import { ForbiddenException, UseGuards } from "@nestjs/common";
import { Args, Context, Query, Resolver } from "@nestjs/graphql";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import { CacheService } from "../../modules/cache/cache.service";
import { KnowledgeGraphImpactService, type ImpactAnalysisResult } from "../../modules/knowledge-graph/knowledge-graph-impact.service";
import { KnowledgeGraphSettingsService } from "../../modules/knowledge-graph/knowledge-graph-settings.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import type { GqlRequest } from "../graphql.types";
import {
  CommodityMoveImpactInput,
  ExecutiveChangeImpactInput,
  KnowledgeGraphImpactAnalysisModel,
  PolicyEventImpactInput
} from "../models/knowledge-graph-impact.model";

@Resolver()
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class KnowledgeGraphImpactResolver {
  constructor(
    private readonly settings: KnowledgeGraphSettingsService,
    private readonly impact: KnowledgeGraphImpactService,
    private readonly cache: CacheService
  ) {}

  @HasPermission("dashboard.read")
  @Query(() => KnowledgeGraphImpactAnalysisModel, { nullable: true })
  async getExecutiveChangeImpact(
    @Context("req") req: GqlRequest,
    @Args("input") input: ExecutiveChangeImpactInput
  ): Promise<KnowledgeGraphImpactAnalysisModel | null> {
    const maxCandidates = input.maxCandidates ?? 50;
    return this.runCached(req, {
      scenario: "executive_change",
      seedName: input.companyName,
      maxCandidates
    }, async (orgId) => {
      return this.impact.analyzeExecutiveChange({
        orgId,
        companyName: input.companyName,
        maxCandidates
      });
    });
  }

  @HasPermission("dashboard.read")
  @Query(() => KnowledgeGraphImpactAnalysisModel, { nullable: true })
  async getCommodityMoveImpact(
    @Context("req") req: GqlRequest,
    @Args("input") input: CommodityMoveImpactInput
  ): Promise<KnowledgeGraphImpactAnalysisModel | null> {
    const maxCandidates = input.maxCandidates ?? 50;
    return this.runCached(req, {
      scenario: "commodity_move",
      seedName: input.commodityName,
      maxCandidates
    }, async (orgId) => {
      return this.impact.analyzeCommodityMove({
        orgId,
        commodityName: input.commodityName,
        maxCandidates
      });
    });
  }

  @HasPermission("dashboard.read")
  @Query(() => KnowledgeGraphImpactAnalysisModel, { nullable: true })
  async getPolicyEventImpact(
    @Context("req") req: GqlRequest,
    @Args("input") input: PolicyEventImpactInput
  ): Promise<KnowledgeGraphImpactAnalysisModel | null> {
    const maxCandidates = input.maxCandidates ?? 50;
    const includeLprSnapshot = Boolean(input.includeLprSnapshot);
    return this.runCached(req, {
      scenario: "policy_event",
      seedName: input.policyName,
      maxCandidates,
      includeLprSnapshot
    }, async (orgId) => {
      return this.impact.analyzePolicyEvent({
        orgId,
        policyName: input.policyName,
        maxCandidates,
        includeLprSnapshot
      });
    });
  }

  private async runCached(
    req: GqlRequest,
    cacheParams: Record<string, string | number | boolean>,
    loader: (orgId: string) => Promise<ImpactAnalysisResult | null>
  ): Promise<KnowledgeGraphImpactAnalysisModel | null> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }

    const settings = await this.settings.getSettings(requester.orgId);
    if (!settings.enabled) {
      return null;
    }

    const cacheTtlSeconds = settings.cacheTtlSeconds ?? 0;
    const cacheKey = this.buildCacheKey({
      orgId: requester.orgId,
      params: cacheParams
    });

    const execute = async () => {
      const result = await loader(requester.orgId);
      if (!result) {
        return null;
      }

      const mapNode = (node: ImpactAnalysisResult["seed"]) => ({
        id: node.id,
        name: node.canonicalName,
        type: node.type,
        properties: (node.properties as Record<string, unknown> | null) ?? null
      });

      const mapEdge = (edge: ImpactAnalysisResult["candidates"][number]["chains"][number]["edges"][number]) => ({
        id: edge.id,
        from: edge.fromEntityId,
        to: edge.toEntityId,
        type: edge.type,
        weight: edge.weight,
        confidence: edge.confidence,
        properties: (edge.properties as Record<string, unknown> | null) ?? null
      });

      const generatedAt = new Date().toISOString();

      return {
        scenario: result.scenario,
        seed: mapNode(result.seed),
        candidates: result.candidates.map((candidate) => ({
          entity: mapNode(candidate.entity),
          score: candidate.score,
          kind: candidate.kind,
          chains: candidate.chains.map((chain) => ({
            reason: chain.reason,
            nodes: chain.nodes.map(mapNode),
            edges: chain.edges.map(mapEdge)
          }))
        })),
        metadata: result.metadata,
        generatedAt
      } satisfies Omit<KnowledgeGraphImpactAnalysisModel, "generatedAt"> & { generatedAt: string };
    };

    const cached =
      cacheTtlSeconds > 0
        ? await this.cache.wrap(cacheKey, cacheTtlSeconds, execute, {
            lockTtlMs: Math.min(300_000, Math.max(30_000, cacheTtlSeconds * 1000)),
            maxWaitMs: Math.min(300_000, Math.max(30_000, cacheTtlSeconds * 1000)),
            retryDelayMs: 200
          })
        : await execute();

    if (!cached) {
      return null;
    }

    return {
      ...cached,
      generatedAt: new Date(cached.generatedAt)
    };
  }

  private buildCacheKey(input: { orgId: string; params: Record<string, string | number | boolean> }) {
    const parts = Object.entries(input.params)
      .map(([key, value]) => {
        const normalized =
          typeof value === "string" ? value.trim().toLowerCase() : typeof value === "boolean" ? String(value) : String(value);
        return `${key}=${normalized}`;
      })
      .sort()
      .join(":");
    return `knowledgeGraph:impact:${input.orgId}:${parts}`;
  }
}
