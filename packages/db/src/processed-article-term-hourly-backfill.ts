import type { PrismaClient } from "@prisma/client";

import {
  alignUtcHourStart,
  extractProcessedArticleTerms,
  normalizeProcessedArticleSource,
} from "./processed-article-backfill-utils";

export interface ProcessedArticleTermHourlyBackfillOptions {
  batchSize?: number;
  maxBatches?: number;
  sleepMs?: number;
  startAfterId?: string;
}

export interface ProcessedArticleTermHourlyBackfillResult {
  batches: number;
  scannedArticles: number;
  insertedRows: number;
  exhausted: boolean;
  lastProcessedId?: string;
}

const DEFAULT_BATCH_SIZE = 500;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function backfillProcessedArticleTermHourly(
  client: PrismaClient,
  options: ProcessedArticleTermHourlyBackfillOptions = {},
): Promise<ProcessedArticleTermHourlyBackfillResult> {
  const batchSize = Math.max(
    1,
    Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE),
  );
  const maxBatches = Math.max(
    1,
    Math.floor(options.maxBatches ?? Number.MAX_SAFE_INTEGER),
  );
  const sleepMs = Math.max(0, Math.floor(options.sleepMs ?? 0));

  let batches = 0;
  let scannedArticles = 0;
  let insertedRows = 0;
  let lastProcessedId = options.startAfterId?.trim() || undefined;

  while (batches < maxBatches) {
    const rows = await client.processedArticle.findMany({
      ...(lastProcessedId
        ? {
            cursor: { id: lastProcessedId },
            skip: 1,
          }
        : {}),
      orderBy: { id: "asc" },
      take: batchSize,
      select: {
        id: true,
        orgId: true,
        title: true,
        summary: true,
        source: true,
        topics: true,
        eventAt: true,
      },
    });

    batches += 1;
    if (rows.length === 0) {
      return {
        batches,
        scannedArticles,
        insertedRows,
        exhausted: true,
        ...(lastProcessedId ? { lastProcessedId } : {}),
      };
    }

    scannedArticles += rows.length;
    lastProcessedId = rows[rows.length - 1]?.id;

    const data = rows.flatMap((row) => {
      const orgId = row.orgId;
      const eventAt = row.eventAt;
      if (!orgId || !eventAt) {
        return [];
      }
      const terms = extractProcessedArticleTerms({
        title: row.title,
        summary: row.summary,
        topics: row.topics,
      });
      if (terms.length === 0) {
        return [];
      }
      const bucketStart = alignUtcHourStart(eventAt);
      const source = normalizeProcessedArticleSource(row.source);
      return terms.map((term) => ({
        orgId,
        processedArticleId: row.id,
        bucketStart,
        term,
        source,
        articleCount: 1,
      }));
    });

    if (data.length > 0) {
      const result = await client.processedArticleTermHourly.createMany({
        data,
        skipDuplicates: true,
      });
      insertedRows += result.count;
    }

    if (sleepMs > 0) {
      await delay(sleepMs);
    }
  }

  return {
    batches,
    scannedArticles,
    insertedRows,
    exhausted: false,
    ...(lastProcessedId ? { lastProcessedId } : {}),
  };
}
