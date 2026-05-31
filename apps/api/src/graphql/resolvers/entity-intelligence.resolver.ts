import { ForbiddenException, UseGuards } from "@nestjs/common";
import { Args, Context, Query, Resolver } from "@nestjs/graphql";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import { KnowledgeGraphIntelligenceService } from "../../modules/knowledge-graph/knowledge-graph-intelligence.service";
import { KnowledgeGraphSettingsService } from "../../modules/knowledge-graph/knowledge-graph-settings.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import type { GqlRequest } from "../graphql.types";
import {
  EntityIntelligenceCardInput,
  EntityIntelligenceCardModel,
  EntityIntelligenceEvidenceInput,
  EntityIntelligenceEvidenceModel,
} from "../models/entity-intelligence.model";
import { KnowledgeGraphNodeModel } from "../models/knowledge-graph.model";

@Resolver()
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class EntityIntelligenceResolver {
  constructor(
    private readonly settings: KnowledgeGraphSettingsService,
    private readonly intelligence: KnowledgeGraphIntelligenceService
  ) {}

  @HasPermission("dashboards.read")
  @Query(() => EntityIntelligenceCardModel, {
    nullable: true,
    description: "Get a 360-degree intelligence card for a knowledge graph entity",
  })
  async entityIntelligenceCard(
    @Context("req") req: GqlRequest,
    @Args("input") input: EntityIntelligenceCardInput
  ): Promise<EntityIntelligenceCardModel | null> {
    const requester = this.requireUser(req);
    const settings = await this.settings.getSettings(requester.orgId);
    if (!settings.enabled) {
      return null;
    }

    const card = await this.intelligence.getCard({
      orgId: requester.orgId,
      entityId: input.entityId,
      windowDays: input.windowDays,
      relatedLimit: input.relatedLimit,
    });

    if (!card) {
      return null;
    }

    return {
      entity: this.toNode(card.entity),
      aliases: card.aliases,
      metrics: card.metrics,
      relationships: card.relationships.map((relationship) => ({
        direction: relationship.direction,
        edge: this.toEdge(relationship.edge),
        neighbor: this.toNode(relationship.neighbor),
        evidenceCount: relationship.evidenceCount,
        latestEvidenceAt: relationship.latestEvidenceAt,
      })),
      sentimentSeries: card.sentimentSeries,
      neighborhood: {
        seed: this.toNode(card.neighborhood.seed),
        nodes: card.neighborhood.nodes.map((node) => this.toNode(node)),
        edges: card.neighborhood.edges.map((edge) => this.toEdge(edge)),
        metadata: {
          totalNodes: card.neighborhood.nodes.length,
          totalEdges: card.neighborhood.edges.length,
          generatedAt: card.generatedAt,
        },
      },
      generatedAt: card.generatedAt,
    };
  }

  @HasPermission("dashboards.read")
  @Query(() => EntityIntelligenceEvidenceModel, {
    nullable: true,
    description: "Get content evidence for a knowledge graph entity intelligence card",
  })
  async entityIntelligenceEvidence(
    @Context("req") req: GqlRequest,
    @Args("input") input: EntityIntelligenceEvidenceInput
  ): Promise<EntityIntelligenceEvidenceModel | null> {
    const requester = this.requireUser(req);
    const settings = await this.settings.getSettings(requester.orgId);
    if (!settings.enabled) {
      return null;
    }

    return this.intelligence.getEvidence({
      orgId: requester.orgId,
      entityId: input.entityId,
      windowDays: input.windowDays,
      eventsLimit: input.eventsLimit,
      evidenceLimit: input.evidenceLimit,
      canReadItems: requester.permissions.includes("items.read"),
    });
  }

  @HasPermission("dashboards.read")
  @Query(() => KnowledgeGraphNodeModel, {
    nullable: true,
    description: "Resolve an entity name to the preferred knowledge graph entity",
  })
  async knowledgeEntityByName(
    @Context("req") req: GqlRequest,
    @Args("name") name: string,
    @Args("type", { nullable: true }) type?: string
  ): Promise<KnowledgeGraphNodeModel | null> {
    const requester = this.requireUser(req);
    const settings = await this.settings.getSettings(requester.orgId);
    if (!settings.enabled) {
      return null;
    }

    const entity = await this.intelligence.resolveEntityByName(
      requester.orgId,
      name,
      type
    );
    return entity ? this.toNode(entity) : null;
  }

  private requireUser(req: GqlRequest): AuthenticatedUser {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }
    return requester;
  }

  private toNode(entity: {
    id: string;
    canonicalName: string;
    type: string;
    properties?: unknown;
  }): KnowledgeGraphNodeModel {
    return {
      id: entity.id,
      name: entity.canonicalName,
      type: entity.type,
      properties:
        entity.properties && typeof entity.properties === "object"
          ? (entity.properties as Record<string, unknown>)
          : null,
    };
  }

  private toEdge(edge: {
    id: string;
    fromEntityId: string;
    toEntityId: string;
    type: string;
    weight: number;
    confidence: number;
    properties?: unknown;
  }) {
    return {
      id: edge.id,
      from: edge.fromEntityId,
      to: edge.toEntityId,
      type: edge.type,
      weight: edge.weight,
      confidence: edge.confidence,
      properties:
        edge.properties && typeof edge.properties === "object"
          ? (edge.properties as Record<string, unknown>)
          : null,
    };
  }
}
