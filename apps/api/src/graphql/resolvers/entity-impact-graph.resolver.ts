import { ForbiddenException, UseGuards } from "@nestjs/common";
import { Args, Context, Query, Resolver } from "@nestjs/graphql";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import { EntityImpactGraphService } from "../../modules/dashboard/entity-impact-graph.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import type { GqlRequest } from "../graphql.types";
import { EntityImpactGraphInput, EntityImpactGraphModel } from "../models/entity-impact-graph.model";


@Resolver()
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class EntityImpactGraphResolver {
  constructor(private readonly entityImpactGraphService: EntityImpactGraphService) {}

  @HasPermission("dashboard.read")
  @Query(() => EntityImpactGraphModel, { description: "Get entity impact graph data for visualization" })
  async getEntityImpactGraph(
    @Context("req") req: GqlRequest,
    @Args("input", { nullable: true }) input?: EntityImpactGraphInput
  ): Promise<EntityImpactGraphModel> {
    const requester = req?.user as AuthenticatedUser | undefined;
    if (!requester) {
      throw new ForbiddenException("Unauthenticated");
    }

    // Default date range: last 30 days
    const endDate = input?.endDate ?? new Date();
    const startDate = input?.startDate ?? new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    const minEntityConfidence = input?.minConfidence ?? 0.5;
    const minCorrelation = input?.minCorrelation ?? 0.3;
    const minCoOccurrence = input?.minCoOccurrence ?? 2;
    const maxNodes = input?.maxNodes ?? 100;
    const categories = input?.categories ?? ["person", "organization", "stock", "commodity"];

    const graphData = await this.entityImpactGraphService.getEntityImpactGraph({
      orgId: requester.orgId,
      startDate,
      endDate,
      minEntityConfidence,
      minCoOccurrence,
      minCorrelation,
      maxNodes,
      categories
    });

    return {
      nodes: graphData.nodes.map((node) => ({
        id: node.id,
        name: node.name,
        category: node.category,
        type: node.category,
        value: node.value
      })),
      links: graphData.links.map((link) => ({
        source: link.source,
        target: link.target,
        value: link.value,
        type: link.linkType
      })),
      metadata: {
        totalNodes: graphData.nodes.length,
        totalLinks: graphData.links.length,
        generatedAt: new Date()
      }
    };
  }
}
