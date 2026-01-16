import { ProcessedItemModel } from '@modular/mongo';
import { createLogger } from '@modular/utils';
import { VectorClient } from '@modular/vector-client';
import mongoose, { Types } from 'mongoose';
import { z } from 'zod';

const logger = createLogger({ name: 'vector-backfill' });

const envBoolean = z.preprocess((value) => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '') return undefined;
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  return value;
}, z.boolean());

const cliSchema = z.object({
  sinceDays: z.number().int().positive().optional(),
  batchSize: z.number().int().positive().optional(),
  concurrency: z.number().int().positive().optional(),
  maxDocs: z.number().int().positive().optional(),
  resumeAfterId: z.string().optional(),
  dryRun: z.boolean().default(false),
});

const envSchema = z.object({
  MONGO_URI: z.string().min(1),
  VECTOR_SERVICE_BASE_URL: z.string().url(),
  VECTOR_INTERNAL_TOKEN: z.string().min(1),
  VECTOR_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  VECTOR_SERVICE_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
  VECTOR_BACKFILL_SINCE_DAYS: z.coerce.number().int().positive().optional(),
  VECTOR_BACKFILL_BATCH_SIZE: z.coerce.number().int().positive().optional(),
  VECTOR_BACKFILL_CONCURRENCY: z.coerce.number().int().positive().optional(),
  VECTOR_BACKFILL_MAX_DOCS: z.coerce.number().int().positive().optional(),
  VECTOR_BACKFILL_RESUME_AFTER_ID: z.string().optional(),
  VECTOR_BACKFILL_DRY_RUN: envBoolean.default(false),
});

const parseCliArgs = (): z.infer<typeof cliSchema> => {
  const raw = process.argv.slice(2);
  const args: Record<string, unknown> = {};
  for (const arg of raw) {
    const trimmed = arg.trim();
    if (!trimmed) continue;
    if (trimmed === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    const [key, value] = trimmed.split('=', 2);
    if (!key || value === undefined) continue;
    if (key === '--since-days') args.sinceDays = Number(value);
    if (key === '--batch-size') args.batchSize = Number(value);
    if (key === '--concurrency') args.concurrency = Number(value);
    if (key === '--max-docs') args.maxDocs = Number(value);
    if (key === '--resume-after-id') args.resumeAfterId = value;
  }

  const parsed = cliSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error('Invalid CLI arguments');
  }
  return parsed.data;
};

const executeWithConcurrencyLimit = async <T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  concurrency: number,
) => {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => (async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      const item = items[current];
      if (!item) continue;
      await fn(item);
    }
  })());
  await Promise.all(workers);
};

const DAY_MS = 24 * 60 * 60 * 1000;

const main = async () => {
  const cli = parseCliArgs();
  const envRaw = envSchema.safeParse(process.env);
  if (!envRaw.success) {
    logger.error({ errors: envRaw.error.format() }, 'Missing required environment variables');
    process.exitCode = 1;
    return;
  }
  const env = envRaw.data;

  const sinceDays =
    cli.sinceDays ??
    env.VECTOR_BACKFILL_SINCE_DAYS ??
    undefined;
  const batchSize =
    cli.batchSize ??
    env.VECTOR_BACKFILL_BATCH_SIZE ??
    200;
  const concurrency =
    cli.concurrency ??
    env.VECTOR_BACKFILL_CONCURRENCY ??
    5;
  const maxDocs = cli.maxDocs ?? env.VECTOR_BACKFILL_MAX_DOCS ?? undefined;
  const resumeAfterId = cli.resumeAfterId ?? env.VECTOR_BACKFILL_RESUME_AFTER_ID ?? undefined;
  const dryRun = cli.dryRun || env.VECTOR_BACKFILL_DRY_RUN;

  const vector = new VectorClient({
    baseUrl: env.VECTOR_SERVICE_BASE_URL,
    token: env.VECTOR_INTERNAL_TOKEN,
    timeoutMs: env.VECTOR_SERVICE_TIMEOUT_MS,
    maxRetries: env.VECTOR_SERVICE_MAX_RETRIES,
  });

  logger.info(
    { sinceDays, batchSize, concurrency, maxDocs, resumeAfterId, dryRun },
    'Starting vector backfill',
  );

  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 10_000 });

  const match: Record<string, unknown> = {
    status: 'completed',
    duplicateOf: null,
    summaryEmbeddingModel: { $type: 'string' },
    summaryEmbedding: { $exists: true, $ne: [] },
  };
  if (typeof sinceDays === 'number' && Number.isFinite(sinceDays)) {
    const cutoff = new Date(Date.now() - sinceDays * DAY_MS);
    match.createdAt = { $gte: cutoff };
  }
  if (resumeAfterId && Types.ObjectId.isValid(resumeAfterId)) {
    match._id = { $gt: new Types.ObjectId(resumeAfterId) };
  }

  const cursor = ProcessedItemModel.find(match, {
    orgId: 1,
    itemMetaId: 1,
    createdAt: 1,
    summaryEmbedding: 1,
    summaryEmbeddingModel: 1,
  })
    .sort({ _id: 1 })
    .lean()
    .cursor();

  let scanned = 0;
  let upserted = 0;
  let failed = 0;

  let batch: Array<{
    processedItemId: string;
    orgId: string;
    itemMetaId: string;
    createdAtMs: number;
    embeddingModel: string;
    vector: number[];
  }> = [];

  const flushBatch = async () => {
    if (batch.length === 0) {
      return;
    }

    const groups = new Map<
      string,
      {
        orgId: string;
        embeddingModel: string;
        points: {
          processedItemId: string;
          itemMetaId: string;
          createdAtMs: number;
          vector: number[];
        }[];
      }
    >();

    for (const item of batch) {
      const key = `${item.orgId}:${item.embeddingModel}`;
      const existing = groups.get(key);
      if (existing) {
        existing.points.push({
          processedItemId: item.processedItemId,
          itemMetaId: item.itemMetaId,
          createdAtMs: item.createdAtMs,
          vector: item.vector,
        });
        continue;
      }
      groups.set(key, {
        orgId: item.orgId,
        embeddingModel: item.embeddingModel,
        points: [
          {
            processedItemId: item.processedItemId,
            itemMetaId: item.itemMetaId,
            createdAtMs: item.createdAtMs,
            vector: item.vector,
          },
        ],
      });
    }

    const entries = Array.from(groups.values());

    await executeWithConcurrencyLimit(
      entries,
      async (entry) => {
        try {
          if (dryRun) {
            upserted += entry.points.length;
            return;
          }
          await vector.upsert({
            orgId: entry.orgId,
            embeddingModel: entry.embeddingModel,
            points: entry.points,
          });
          upserted += entry.points.length;
        } catch (error) {
          failed += entry.points.length;
          logger.warn(
            { error, orgId: entry.orgId, embeddingModel: entry.embeddingModel, points: entry.points.length },
            'Vector upsert failed',
          );
        }
      },
      concurrency,
    );

    batch = [];
    logger.info({ scanned, upserted, failed }, 'Vector backfill progress');
  };

  try {
    for await (const doc of cursor) {
      scanned += 1;
      if (maxDocs && scanned > maxDocs) {
        break;
      }

      const rawId = (doc as { _id?: unknown })._id;
      const processedItemId =
        typeof rawId === 'string' ? rawId : rawId?.toString?.();
      const orgId = typeof (doc as { orgId?: unknown }).orgId === 'string' ? (doc as { orgId: string }).orgId : '';
      const itemMetaId =
        typeof (doc as { itemMetaId?: unknown }).itemMetaId === 'string'
          ? (doc as { itemMetaId: string }).itemMetaId
          : '';
      const embeddingModelRaw =
        typeof (doc as { summaryEmbeddingModel?: unknown }).summaryEmbeddingModel === 'string'
          ? (doc as { summaryEmbeddingModel: string }).summaryEmbeddingModel.trim()
          : '';
      const vectorRaw = (doc as { summaryEmbedding?: unknown }).summaryEmbedding;
      const createdAt = (doc as { createdAt?: unknown }).createdAt;
      const createdAtMs =
        createdAt instanceof Date && Number.isFinite(createdAt.getTime()) ? createdAt.getTime() : Date.now();

      if (!processedItemId || !orgId || !itemMetaId || !embeddingModelRaw) {
        continue;
      }
      if (!Array.isArray(vectorRaw) || vectorRaw.length === 0) {
        continue;
      }
      if (!vectorRaw.every((v) => typeof v === 'number' && Number.isFinite(v))) {
        continue;
      }

      batch.push({
        processedItemId,
        orgId,
        itemMetaId,
        createdAtMs,
        embeddingModel: embeddingModelRaw,
        vector: vectorRaw,
      });

      if (batch.length >= batchSize) {
        await flushBatch();
      }
    }
  } finally {
    await flushBatch();
    await cursor.close().catch(() => undefined);
    await mongoose.disconnect().catch(() => undefined);
  }

  logger.info({ scanned, upserted, failed }, 'Vector backfill completed');
};

void main().catch((error) => {
  logger.error({ error }, 'Vector backfill failed');
  process.exitCode = 1;
});
