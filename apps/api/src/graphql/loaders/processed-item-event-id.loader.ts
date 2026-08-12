import { Injectable, Scope } from "@nestjs/common";
import DataLoader from "dataloader";

import { PrismaService } from "../../modules/config/prisma.service";

/**
 * DataLoader for resolving ProcessedItem ID to NewsEvent ID.
 *
 * Mapping chain (in order of preference):
 * 1. processedItemId -> NewsEventItem.processedItemId -> eventId (direct link)
 * 2. processedItemId -> ProcessedArticle (via cleanedMarkdownRef)
 *    -> NewsEventItem (via processedArticleId) -> eventId (fallback)
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

      const normalizedIds = [...processedItemIds].map((id) => String(id).trim());

      // Step 1: direct link via NewsEventItem.processedItemId
      const directMemberships = (await this.prisma.newsEventItem.findMany({
        where: {
          orgId,
          processedItemId: { in: normalizedIds },
        },
        select: {
          processedItemId: true,
          eventId: true,
        },
        // An item can be re-clustered into a newer event; prefer the most
        // recent membership when multiple rows reference the same item.
        orderBy: { createdAt: "desc" },
      })) as { processedItemId: string; eventId: string }[];

      const eventIdByProcessedItemId = new Map<string, string>();
      for (const row of directMemberships) {
        const processedItemId = String(row.processedItemId).trim();
        if (processedItemId && !eventIdByProcessedItemId.has(processedItemId)) {
          eventIdByProcessedItemId.set(processedItemId, row.eventId);
        }
      }

      // Step 2: fallback for ids without a direct link, via cleanedMarkdownRef
      const missingIds = normalizedIds.filter((id) => !eventIdByProcessedItemId.has(id));
      if (missingIds.length > 0) {
        // Step 2a: processedItemId -> processedArticleId via cleanedMarkdownRef
        const processedArticles = (await this.prisma.processedArticle.findMany({
          where: {
            cleanedMarkdownRef: { in: missingIds },
            article: { orgId },
          },
          select: {
            id: true,
            cleanedMarkdownRef: true,
          },
        })) as { id: string; cleanedMarkdownRef: string | null }[];

        const processedArticleIdByProcessedItemId = new Map<string, string>();
        for (const row of processedArticles) {
          if (row.cleanedMarkdownRef) {
            processedArticleIdByProcessedItemId.set(row.cleanedMarkdownRef, row.id);
          }
        }

        // Step 2b: processedArticleId -> eventId via NewsEventItem
        const processedArticleIds = [...new Set(processedArticles.map((row) => row.id))];

        if (processedArticleIds.length > 0) {
          const memberships = (await this.prisma.newsEventItem.findMany({
            where: {
              orgId,
              processedArticleId: { in: processedArticleIds },
            },
            select: {
              processedArticleId: true,
              eventId: true,
            },
          })) as { processedArticleId: string; eventId: string }[];

          const eventIdByProcessedArticleId = new Map<string, string>();
          for (const row of memberships) {
            eventIdByProcessedArticleId.set(row.processedArticleId, row.eventId);
          }

          for (const processedItemId of missingIds) {
            const processedArticleId =
              processedArticleIdByProcessedItemId.get(processedItemId);
            if (!processedArticleId) {
              continue;
            }
            const eventId = eventIdByProcessedArticleId.get(processedArticleId);
            if (eventId) {
              eventIdByProcessedItemId.set(processedItemId, eventId);
            }
          }
        }
      }

      // Step 3: Return in same order as input
      return normalizedIds.map((processedItemId) => {
        return eventIdByProcessedItemId.get(processedItemId) ?? null;
      });
    });

    this.loaderByOrgId.set(orgId, loader);
    return loader;
  }
}
