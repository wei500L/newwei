// Operational backfill: recompute ProcessedItem.hasLocation from the stored
// result. Standalone Node tool using the shared @modular/mongo models; no Nest
// app module is started. Behaviour (flags, defaults, dry-run, org scoping,
// batch writes, failure exit) is preserved from the former apps/api script.
//
// CLI validation mirrors the previous Zod schema without a Zod dependency:
// integer-positive numbers for --since-hours/--batch-size/--max-docs, a
// non-empty trimmed --org-id, and --dry-run for a read-only pass. Any invalid
// value fails with "Invalid CLI arguments" and a non-zero exit code.
import { createLogger } from "@modular/utils";
import type { Types } from "mongoose";

import {
  ProcessedItemModel,
  connectMongo,
  disconnectMongo,
  processedItemHasLocation,
} from "../src/index";

const logger = createLogger({ name: "processed-item-location-backfill" });
const DEFAULT_SINCE_HOURS = 24 * 7;
const DEFAULT_BATCH_SIZE = 200;

interface CliOptions {
  sinceHours?: number;
  batchSize?: number;
  maxDocs?: number;
  orgId?: string;
  dryRun: boolean;
}

interface BackfillProcessedItemDoc {
  _id: Types.ObjectId;
  result?: unknown;
  hasLocation?: unknown;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Invalid CLI arguments");
  }
  return parsed;
}

export function parseCliArgsFromArgs(args: string[]): CliOptions {
  const options: CliOptions = { dryRun: false };

  for (const arg of args) {
    const trimmed = arg.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const [key, value] = trimmed.split("=", 2);
    if (!key || value === undefined) {
      continue;
    }
    if (key === "--since-hours") {
      options.sinceHours = parsePositiveInteger(value);
    } else if (key === "--batch-size") {
      options.batchSize = parsePositiveInteger(value);
    } else if (key === "--max-docs") {
      options.maxDocs = parsePositiveInteger(value);
    } else if (key === "--org-id") {
      const orgId = value.trim();
      if (orgId.length === 0) {
        throw new Error("Invalid CLI arguments");
      }
      options.orgId = orgId;
    }
  }

  return options;
}

async function main() {
  const cli = parseCliArgsFromArgs(process.argv.slice(2));
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
  let batch: { _id: Types.ObjectId; hasLocation: boolean }[] = [];

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

void main().catch((error) => {
  logger.error(
    {
      err: error,
    },
    "Processed item hasLocation backfill failed",
  );
  process.exitCode = 1;
});
