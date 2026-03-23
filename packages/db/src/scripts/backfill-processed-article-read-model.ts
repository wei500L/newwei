import {
  baseEnvSchema,
  loadAndValidateEnv,
  resolveMysqlConnectionString,
} from "@modular/utils";
import path from "node:path";
import process from "node:process";

import { prisma } from "../client";
import { backfillProcessedArticleReadModel } from "../processed-article-read-model-backfill";

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
  process.env.PROCESSED_ARTICLE_BACKFILL_BATCH_SIZE ?? "",
  10,
);
const maxBatches = Number.parseInt(
  process.env.PROCESSED_ARTICLE_BACKFILL_MAX_BATCHES ?? "",
  10,
);
const sleepMs = Number.parseInt(
  process.env.PROCESSED_ARTICLE_BACKFILL_SLEEP_MS ?? "",
  10,
);

backfillProcessedArticleReadModel(prisma, {
  ...(Number.isFinite(batchSize) ? { batchSize } : {}),
  ...(Number.isFinite(maxBatches) ? { maxBatches } : {}),
  ...(Number.isFinite(sleepMs) ? { sleepMs } : {}),
})
  .then(async (result) => {
    console.log(
      [
        "ProcessedArticle read model backfill completed.",
        `Batches: ${result.batches}`,
        `Updated rows: ${result.updatedRows}`,
        `Exhausted: ${result.exhausted}`,
      ].join(" "),
    );
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("Failed to backfill ProcessedArticle read model", error);
    await prisma.$disconnect();
    process.exit(1);
  });
