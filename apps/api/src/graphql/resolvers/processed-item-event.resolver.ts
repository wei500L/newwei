import { Context, Parent, ResolveField, Resolver } from "@nestjs/graphql";
import { ProcessedItemEventIdLoader } from "../loaders/processed-item-event-id.loader";
import {
  ProcessedItemModelGraph,
  ProcessedItemPreviewModelGraph
} from "../models/item.model";
import type { GqlRequest } from "../graphql.types";

/**
 * Resolver for eventId field on ProcessedItem types.
 * Uses DataLoader to avoid N+1 queries.
 */
@Resolver(() => ProcessedItemModelGraph)
export class ProcessedItemEventResolver {
  constructor(private readonly eventIdLoader: ProcessedItemEventIdLoader) {}

  @ResolveField(() => String, { nullable: true })
  async eventId(
    @Parent() item: ProcessedItemModelGraph,
    @Context("req") req: GqlRequest
  ): Promise<string | null> {
    const user = req.user as { orgId: string } | undefined;
    if (!user?.orgId) {
      return null;
    }

    const loader = this.eventIdLoader.generateDataLoader(user.orgId);
    return loader.load(item.id);
  }
}

@Resolver(() => ProcessedItemPreviewModelGraph)
export class ProcessedItemPreviewEventResolver {
  constructor(private readonly eventIdLoader: ProcessedItemEventIdLoader) {}

  @ResolveField(() => String, { nullable: true })
  async eventId(
    @Parent() item: ProcessedItemPreviewModelGraph,
    @Context("req") req: GqlRequest
  ): Promise<string | null> {
    const user = req.user as { orgId: string } | undefined;
    if (!user?.orgId) {
      return null;
    }

    const loader = this.eventIdLoader.generateDataLoader(user.orgId);
    return loader.load(item.id);
  }
}
