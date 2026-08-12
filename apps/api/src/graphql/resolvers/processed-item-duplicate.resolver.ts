import { Context, Parent, ResolveField, Resolver } from "@nestjs/graphql";

import type { GqlRequest } from "../graphql.types";
import { ProcessedItemDuplicateLoader } from "../loaders/processed-item-duplicate.loader";
import {
  ProcessedItemModelGraph,
  ProcessedItemPreviewModelGraph
} from "../models/item.model";

/**
 * Resolves `ProcessedItem.duplicateOf` (a ProcessedItem._id) to the target
 * item's ItemMeta id so consumers can navigate with `/items/:itemMetaId`.
 * Uses DataLoader to avoid N+1 queries.
 */
@Resolver(() => ProcessedItemModelGraph)
export class ProcessedItemDuplicateResolver {
  constructor(private readonly duplicateLoader: ProcessedItemDuplicateLoader) {}

  @ResolveField(() => String, { nullable: true })
  async duplicateOf(
    @Parent() item: ProcessedItemModelGraph,
    @Context("req") req: GqlRequest
  ): Promise<string | null> {
    const rawDuplicate = item.duplicateOf;
    if (!rawDuplicate) {
      return null;
    }
    const user = req.user as { orgId: string } | undefined;
    if (!user?.orgId) {
      return null;
    }

    const loader = this.duplicateLoader.generateDataLoader(user.orgId);
    return loader.load(String(rawDuplicate));
  }
}

@Resolver(() => ProcessedItemPreviewModelGraph)
export class ProcessedItemPreviewDuplicateResolver {
  constructor(private readonly duplicateLoader: ProcessedItemDuplicateLoader) {}

  @ResolveField(() => String, { nullable: true })
  async duplicateOf(
    @Parent() item: ProcessedItemPreviewModelGraph,
    @Context("req") req: GqlRequest
  ): Promise<string | null> {
    const rawDuplicate = item.duplicateOf;
    if (!rawDuplicate) {
      return null;
    }
    const user = req.user as { orgId: string } | undefined;
    if (!user?.orgId) {
      return null;
    }

    const loader = this.duplicateLoader.generateDataLoader(user.orgId);
    return loader.load(String(rawDuplicate));
  }
}
