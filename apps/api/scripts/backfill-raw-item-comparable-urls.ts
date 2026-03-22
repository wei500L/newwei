import {
  RawItemModel,
  buildComparableUrlVariants,
  connectMongo,
  disconnectMongo,
} from '@modular/mongo';
import { createLogger } from '@modular/utils';
import { Types } from 'mongoose';

const logger = createLogger({ name: 'raw-item-comparable-url-backfill' });

interface CliOptions {
  batchSize: number;
  maxDocs?: number;
  resumeAfterId?: string;
  dryRun: boolean;
}

interface RawItemComparableUrlBackfillStats {
  scanned: number;
  updated: number;
  invalidUrls: number;
  lastId: string | null;
}

type RawItemComparableUrlBackfillModel = Pick<
  typeof RawItemModel,
  'bulkWrite' | 'find' | 'syncIndexes'
>;

const DEFAULT_BATCH_SIZE = 500;

export const parseCliArgsFromArgs = (args: string[]): CliOptions => {
  let batchSize = DEFAULT_BATCH_SIZE;
  let maxDocs: number | undefined;
  let resumeAfterId: string | undefined;
  let dryRun = false;

  for (const arg of args) {
    const trimmed = arg.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === '--dry-run') {
      dryRun = true;
      continue;
    }
    const [key, value] = trimmed.split('=', 2);
    if (!key || value === undefined) {
      continue;
    }
    if (key === '--batch-size') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        batchSize = Math.max(1, Math.min(2_000, Math.round(parsed)));
      }
      continue;
    }
    if (key === '--max-docs') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxDocs = Math.round(parsed);
      }
      continue;
    }
    if (key === '--resume-after-id') {
      const normalized = value.trim();
      if (normalized.length > 0) {
        resumeAfterId = normalized;
      }
    }
  }

  return {
    batchSize,
    dryRun,
    ...(typeof maxDocs === 'number' ? { maxDocs } : {}),
    ...(resumeAfterId ? { resumeAfterId } : {}),
  };
};

const parseCliArgs = (): CliOptions => parseCliArgsFromArgs(process.argv.slice(2));

export const backfillRawItemComparableUrls = async (
  model: RawItemComparableUrlBackfillModel,
  options: CliOptions,
): Promise<RawItemComparableUrlBackfillStats> => {
  logger.info(options, 'Starting raw item comparable URL backfill');
  if (!options.dryRun) {
    logger.info('Syncing RawItem indexes before comparable URL backfill');
    await model.syncIndexes();
  }

  const match: Record<string, unknown> = {
    $or: [
      { urlComparableFull: { $exists: false } },
      { urlComparableFullHash: { $exists: false } },
      { urlComparableBase: { $exists: false } },
    ],
  };

  if (options.resumeAfterId && Types.ObjectId.isValid(options.resumeAfterId)) {
    match._id = { $gt: new Types.ObjectId(options.resumeAfterId) };
  }

  const cursor = model
    .find(match, {
      _id: 1,
      'payload.url': 1,
      urlComparableFull: 1,
      urlComparableFullHash: 1,
      urlComparableBase: 1,
    })
    .sort({ _id: 1 })
    .lean()
    .cursor();

  let scanned = 0;
  let updated = 0;
  let invalidUrls = 0;
  let lastId: string | null = null;
  let batch: {
    _id: Types.ObjectId;
    urlComparableFull: string | null;
    urlComparableFullHash: string | null;
    urlComparableBase: string | null;
  }[] = [];

  const flushBatch = async () => {
    if (batch.length === 0) {
      return;
    }

    if (!options.dryRun) {
      await model.bulkWrite(
        batch.map((entry) => ({
          updateOne: {
            filter: { _id: entry._id },
            update: {
              $set: {
                urlComparableFull: entry.urlComparableFull,
                urlComparableFullHash: entry.urlComparableFullHash,
                urlComparableBase: entry.urlComparableBase,
              },
            },
          },
        })),
        { ordered: false },
      );
    }

    updated += batch.length;
    logger.info({ scanned, updated, invalidUrls, lastId }, 'Raw item comparable URL backfill progress');
    batch = [];
  };

  for await (const doc of cursor) {
    if (options.maxDocs && scanned >= options.maxDocs) {
      break;
    }

    scanned += 1;
    const rawId = (doc as { _id?: unknown })._id;
    if (!(rawId instanceof Types.ObjectId)) {
      continue;
    }
    lastId = rawId.toString();

    const url =
      typeof (doc as { payload?: { url?: unknown } }).payload?.url === 'string'
        ? ((doc as { payload: { url: string } }).payload.url)
        : '';
    const comparable = buildComparableUrlVariants(url);
    if (!comparable) {
      invalidUrls += 1;
    }

    batch.push({
      _id: rawId,
      urlComparableFull: comparable?.full ?? null,
      urlComparableFullHash: comparable?.fullHash ?? null,
      urlComparableBase: comparable?.base ?? null,
    });

    if (batch.length >= options.batchSize) {
      await flushBatch();
    }
  }

  await flushBatch();
  const stats = { scanned, updated, invalidUrls, lastId };
  logger.info(stats, 'Raw item comparable URL backfill completed');
  return stats;
};

const main = async () => {
  const options = parseCliArgs();
  await connectMongo();

  try {
    await backfillRawItemComparableUrls(RawItemModel, options);
  } finally {
    await disconnectMongo();
  }
};

if (process.env.NODE_ENV !== 'test') {
  void main().catch((error) => {
    logger.error(
      { error },
      `Raw item comparable URL backfill failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
