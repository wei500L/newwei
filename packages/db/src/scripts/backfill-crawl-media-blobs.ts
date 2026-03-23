import {
  baseEnvSchema,
  loadAndValidateEnv,
  resolveMysqlConnectionString,
} from "@modular/utils";
import path from "node:path";
import process from "node:process";

import { prisma } from "../client";
import { backfillCrawlMediaBlobs } from "../crawl-media-blob-backfill";

const env = loadAndValidateEnv(
  baseEnvSchema.pick({
    DATABASE_URL: true,
    MYSQL_HOST: true,
    MYSQL_PORT: true,
    MYSQL_USER: true,
    MYSQL_PASSWORD: true,
    MYSQL_DB: true,
  }),
  {
    dotenvPath: path.resolve(process.cwd(), "../../.env"),
    overrideProcessEnv: false,
  },
);

process.env.DATABASE_URL = resolveMysqlConnectionString(env);

const batchSize = Number.parseInt(
  process.env.CRAWL_MEDIA_BLOB_BACKFILL_BATCH_SIZE ?? "",
  10,
);
const maxBatches = Number.parseInt(
  process.env.CRAWL_MEDIA_BLOB_BACKFILL_MAX_BATCHES ?? "",
  10,
);
const sleepMs = Number.parseInt(
  process.env.CRAWL_MEDIA_BLOB_BACKFILL_SLEEP_MS ?? "",
  10,
);
const startAfterId =
  process.env.CRAWL_MEDIA_BLOB_BACKFILL_START_AFTER_ID?.trim();

backfillCrawlMediaBlobs(prisma, {
  ...(Number.isFinite(batchSize) ? { batchSize } : {}),
  ...(Number.isFinite(maxBatches) ? { maxBatches } : {}),
  ...(Number.isFinite(sleepMs) ? { sleepMs } : {}),
  ...(startAfterId ? { startAfterId } : {}),
})
  .then(async (result) => {
    console.log(
      [
        "Crawl media blob backfill completed.",
        `Batches: ${result.batches}`,
        `Scanned assets: ${result.scannedAssets}`,
        `Hydrated assets: ${result.hydratedAssets}`,
        `Exhausted: ${result.exhausted}`,
        ...(result.lastProcessedId
          ? [`Last processed id: ${result.lastProcessedId}`]
          : []),
      ].join(" "),
    );
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("Failed to backfill crawl media blobs", error);
    await prisma.$disconnect();
    process.exit(1);
  });
