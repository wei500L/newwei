import {
  ProcessedItemModel,
  connectMongo,
  disconnectMongo,
  processedItemHasLocation,
} from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Types } from "mongoose";
import { z } from "zod";

const logger = createLogger({ name: "processed-item-location-backfill" });
const DEFAULT_SINCE_HOURS = 24 * 7;
const DEFAULT_BATCH_SIZE = 200;

const cliSchema = z.object({
  sinceHours: z.number().int().positive().optional(),
  batchSize: z.number().int().positive().optional(),
  maxDocs: z.number().int().positive().optional(),
  orgId: z.string().trim().min(1).optional(),
  dryRun: z.boolean().default(false),
});

interface BackfillProcessedItemDoc {
  _id: Types.ObjectId;
  result?: unknown;
  hasLocation?: unknown;
}

const parseCliArgs = (): z.infer<typeof cliSchema> => {
  const raw = process.argv.slice(2);
  const args: Record<string, unknown> = {};

  for (const arg of raw) {
    const trimmed = arg.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    const [key, value] = trimmed.split("=", 2);
    if (!key || value === undefined) {
      continue;
    }
    if (key === "--since-hours") {
      args.sinceHours = Number(value);
    }
    if (key === "--batch-size") {
      args.batchSize = Number(value);
    }
    if (key === "--max-docs") {
      args.maxDocs = Number(value);
    }
    if (key === "--org-id") {
      args.orgId = value;
    }
  }

  const parsed = cliSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error("Invalid CLI arguments");
  }
  return parsed.data;
};

async function main() {
  const cli = parseCliArgs();
  const sinceHours = cli.sinceHours ?? DEFAULT_SINCE_HOURS;
  const batchSize = cli.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxDocs = cli.maxDocs;
  const orgId = cli.orgId;
  const dryRun = cli.dryRun;
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1_000);

  const match: Record<string, unknown> = {
    status: "completed",
    $or: [
      { sortAt: { $gte: since } },
      { ingestedAt: { $gte: since } },
      { createdAt: { $gte: since } },
    ],
  };
  if (orgId) {
    match.orgId = orgId;
  }

  logger.info(
    {
      sinceHours,
      batchSize,
      maxDocs,
      orgId,
      dryRun,
    },
    "Starting processed item hasLocation backfill",
  );

  await connectMongo();

  let scanned = 0;
  let unchanged = 0;
  let pendingUpdates = 0;
  let modified = 0;
  let batch: Array<{ _id: Types.ObjectId; hasLocation: boolean }> = [];

  const flushBatch = async () => {
    if (dryRun || batch.length === 0) {
      batch = [];
      return;
    }

    const result = await ProcessedItemModel.bulkWrite(
      batch.map((entry) => ({
        updateOne: {
          filter: { _id: entry._id },
          update: { $set: { hasLocation: entry.hasLocation } },
        },
      })),
      { ordered: false },
    );
    modified += result.modifiedCount ?? 0;
    batch = [];
  };

  try {
    const cursor = ProcessedItemModel.find(match, {
      _id: 1,
      result: 1,
      hasLocation: 1,
    })
      .sort({ _id: 1 })
      .lean()
      .cursor<BackfillProcessedItemDoc>();

    try {
      for await (const doc of cursor) {
        if (typeof maxDocs === "number" && scanned >= maxDocs) {
          break;
        }

        scanned += 1;
        const nextHasLocation = processedItemHasLocation(doc.result);
        if (doc.hasLocation === nextHasLocation) {
          unchanged += 1;
          continue;
        }

        pendingUpdates += 1;
        batch.push({ _id: doc._id, hasLocation: nextHasLocation });
        if (batch.length >= batchSize) {
          await flushBatch();
        }
      }
    } finally {
      await cursor.close();
    }

    await flushBatch();

    logger.info(
      {
        scanned,
        unchanged,
        pendingUpdates,
        modified,
        dryRun,
      },
      dryRun
        ? "Processed item hasLocation backfill dry run completed"
        : "Processed item hasLocation backfill completed",
    );
  } finally {
    await disconnectMongo();
  }
}

main().catch((error) => {
  logger.error(
    {
      err: error,
    },
    "Processed item hasLocation backfill failed",
  );
  process.exitCode = 1;
});
