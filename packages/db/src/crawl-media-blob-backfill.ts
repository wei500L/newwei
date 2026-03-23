import { CrawlImageStorageProvider, type PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

export interface CrawlMediaBlobBackfillOptions {
  batchSize?: number;
  maxBatches?: number;
  sleepMs?: number;
  startAfterId?: string;
}

export interface CrawlMediaBlobBackfillResult {
  batches: number;
  scannedAssets: number;
  hydratedAssets: number;
  exhausted: boolean;
  lastProcessedId?: string;
}

const DEFAULT_BATCH_SIZE = 64;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function backfillCrawlMediaBlobs(
  client: PrismaClient,
  options: CrawlMediaBlobBackfillOptions = {},
): Promise<CrawlMediaBlobBackfillResult> {
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
  let scannedAssets = 0;
  let hydratedAssets = 0;
  let lastProcessedId = options.startAfterId?.trim() || undefined;

  while (batches < maxBatches) {
    const rows = await client.crawlMediaAsset.findMany({
      ...(lastProcessedId
        ? {
            cursor: { id: lastProcessedId },
            skip: 1,
          }
        : {}),
      where: {
        provider: CrawlImageStorageProvider.mysql,
        blobId: null,
        blobData: {
          not: null,
        },
      },
      orderBy: { id: "asc" },
      take: batchSize,
      select: {
        id: true,
      },
    });

    batches += 1;
    if (rows.length === 0) {
      return {
        batches,
        scannedAssets,
        hydratedAssets,
        exhausted: true,
        ...(lastProcessedId ? { lastProcessedId } : {}),
      };
    }

    scannedAssets += rows.length;
    lastProcessedId = rows[rows.length - 1]?.id;

    for (const row of rows) {
      const didHydrate = await client.$transaction(async (tx) => {
        const asset = await tx.crawlMediaAsset.findUnique({
          where: { id: row.id },
          select: {
            id: true,
            orgId: true,
            provider: true,
            blobId: true,
            blobData: true,
            bytes: true,
            contentType: true,
          },
        });

        if (
          !asset ||
          asset.provider !== CrawlImageStorageProvider.mysql ||
          asset.blobId ||
          !asset.blobData
        ) {
          return false;
        }

        const blobBytes = Uint8Array.from(asset.blobData);
        const sha256 = createHash("sha256").update(blobBytes).digest("hex");
        const blobData = Buffer.from(blobBytes);
        const blob = await tx.crawlMediaBlob.upsert({
          where: {
            orgId_sha256: {
              orgId: asset.orgId,
              sha256,
            },
          },
          update: {
            refCount: {
              increment: 1,
            },
          },
          create: {
            orgId: asset.orgId,
            sha256,
            bytes: asset.bytes,
            contentType: asset.contentType,
            blobData,
            refCount: 1,
          },
          select: {
            id: true,
          },
        });

        await tx.crawlMediaAsset.update({
          where: { id: asset.id },
          data: {
            blobId: blob.id,
            blobData: null,
          },
        });

        return true;
      });

      if (didHydrate) {
        hydratedAssets += 1;
      }
    }

    if (sleepMs > 0) {
      await delay(sleepMs);
    }
  }

  return {
    batches,
    scannedAssets,
    hydratedAssets,
    exhausted: false,
    ...(lastProcessedId ? { lastProcessedId } : {}),
  };
}
