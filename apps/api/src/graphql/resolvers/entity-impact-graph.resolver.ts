import { UseGuards } from "@nestjs/common";
import { Args, Query, Resolver } from "@nestjs/graphql";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { EntityImpactGraphService } from "../../modules/dashboard/entity-impact-graph.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import { EntityImpactGraphInput, EntityImpactGraphModel } from "../models/entity-impact-graph.model";


@Resolver()
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class EntityImpactGraphResolver {
  constructor(private readonly entityImpactGraphService: EntityImpactGraphService) {}

  @HasPermission("dashboard.read")
  @Query(() => EntityImpactGraphModel, { description: "Get entity impact graph data for visualization" })
  async getEntityImpactGraph(
    @Args("input", { nullable: true }) input?: EntityImpactGraphInput
  ): Promise<EntityImpactGraphModel> {
    // Default date range: last 30 days
    const endDate = input?.endDate ?? new Date();
    const startDate = input?.startDate ?? new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    const minConfidence = input?.minConfidence ?? 0.5;
    const maxNodes = input?.maxNodes ?? 100;

    const graphData = await this.entityImpactGraphService.getEntityImpactGraph({
      orgId: "", // Will be populated from context in actual implementation
      startDate,
      endDate,
      minCoOccurrence: 2,
      minCorrelation: minConfidence,
      maxNodes
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
