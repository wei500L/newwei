import { Injectable, Scope } from "@nestjs/common";
import DataLoader from "dataloader";

import { PrismaService } from "../../modules/config/prisma.service";

/**
 * DataLoader for resolving ProcessedItem ID to NewsEvent ID.
 *
 * Mapping chain:
 * processedItemId -> ProcessedArticle (via cleanedMarkdownRef)
 * -> NewsEventItem (via processedArticleId) -> eventId
 */
@Injectable({ scope: Scope.REQUEST })
export class ProcessedItemEventIdLoader {
  constructor(private readonly prisma: PrismaService) {}

  private readonly loaderByOrgId = new Map<string, DataLoader<string, string | null>>();

  generateDataLoader(orgId: string): DataLoader<string, string | null> {
    const existing = this.loaderByOrgId.get(orgId);
    if (existing) {
      return existing;
    }

    const loader = new DataLoader<string, string | null>(async (processedItemIds) => {
      if (processedItemIds.length === 0) {
        return [];
      }

      // Step 1: processedItemId -> processedArticleId via cleanedMarkdownRef
      const processedArticles = (await this.prisma.processedArticle.findMany({
        where: {
          cleanedMarkdownRef: { in: [...processedItemIds] },
          article: { orgId }
        },
        select: {
          id: true,
          cleanedMarkdownRef: true
        }
      })) as Array<{ id: string; cleanedMarkdownRef: string | null }>;

      const processedArticleIdByProcessedItemId = new Map<string, string>();
      for (const row of processedArticles) {
        if (row.cleanedMarkdownRef) {
          processedArticleIdByProcessedItemId.set(row.cleanedMarkdownRef, row.id);
        }
      }

      // Step 2: processedArticleId -> eventId via NewsEventItem
      const processedArticleIds = [...new Set(processedArticles.map((row) => row.id))];

      if (processedArticleIds.length === 0) {
        return processedItemIds.map(() => null);
      }

      const memberships = (await this.prisma.newsEventItem.findMany({
        where: {
          orgId,
          processedArticleId: { in: processedArticleIds }
        },
        select: {
          processedArticleId: true,
          eventId: true
        }
      })) as Array<{ processedArticleId: string; eventId: string }>;

      const eventIdByProcessedArticleId = new Map<string, string>();
      for (const row of memberships) {
        eventIdByProcessedArticleId.set(row.processedArticleId, row.eventId);
      }

      // Step 3: Return in same order as input
      return processedItemIds.map((processedItemId) => {
        const processedArticleId = processedArticleIdByProcessedItemId.get(processedItemId);
        if (!processedArticleId) {
          return null;
        }
        return eventIdByProcessedArticleId.get(processedArticleId) ?? null;
      });
    });

    this.loaderByOrgId.set(orgId, loader);
    return loader;
  }
}
