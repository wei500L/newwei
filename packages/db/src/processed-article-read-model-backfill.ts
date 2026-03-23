export interface ProcessedArticleReadModelBackfillClient {
  $executeRawUnsafe: (query: string) => Promise<number>;
}

export interface ProcessedArticleReadModelBackfillOptions {
  batchSize?: number;
  maxBatches?: number;
  sleepMs?: number;
}

export interface ProcessedArticleReadModelBackfillResult {
  batches: number;
  updatedRows: number;
  exhausted: boolean;
}

const DEFAULT_BATCH_SIZE = 1_000;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function backfillProcessedArticleReadModel(
  client: ProcessedArticleReadModelBackfillClient,
  options: ProcessedArticleReadModelBackfillOptions = {},
): Promise<ProcessedArticleReadModelBackfillResult> {
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
  let updatedRows = 0;

  while (batches < maxBatches) {
    const updated = await client.$executeRawUnsafe(`
      UPDATE \`ProcessedArticle\` pa
      INNER JOIN \`Article\` a ON a.\`id\` = pa.\`articleId\`
      SET
        pa.\`orgId\` = a.\`orgId\`,
        pa.\`eventAt\` = COALESCE(pa.\`publishedAt\`, a.\`crawlAt\`, pa.\`processedAt\`),
        pa.\`hasLocation\` = CASE
          WHEN pa.\`location\` IS NOT NULL AND CHAR_LENGTH(TRIM(pa.\`location\`)) > 0 THEN true
          ELSE false
        END
      WHERE
        pa.\`orgId\` IS NULL
        OR pa.\`eventAt\` IS NULL
        OR (
          pa.\`hasLocation\` = false
          AND pa.\`location\` IS NOT NULL
          AND CHAR_LENGTH(TRIM(pa.\`location\`)) > 0
        )
      LIMIT ${batchSize}
    `);

    batches += 1;
    updatedRows += updated;
    if (updated <= 0) {
      return {
        batches,
        updatedRows,
        exhausted: true,
      };
    }
    if (sleepMs > 0) {
      await delay(sleepMs);
    }
  }

  return {
    batches,
    updatedRows,
    exhausted: false,
  };
}
