import { ProcessedItemModel, connectMongo, disconnectMongo } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Types } from "mongoose";
import { z } from "zod";

const logger = createLogger({ name: "processed-item-embedding-dimensions-backfill" });
const DEFAULT_BATCH_SIZE = 500;

const cliSchema = z.object({
  batchSize: z.number().int().positive().optional(),
  maxDocs: z.number().int().positive().optional(),
  orgId: z.string().trim().min(1).optional(),
  resumeAfterId: z.string().trim().min(1).optional(),
  dryRun: z.boolean().default(false),
});

interface BackfillProcessedItemDoc {
  _id: Types.ObjectId;
  summaryEmbedding?: unknown;
  summaryEmbeddingDimensions?: unknown;
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
    if (key === "--batch-size") {
      args.batchSize = Number(value);
    }
    if (key === "--max-docs") {
      args.maxDocs = Number(value);
    }
    if (key === "--org-id") {
      args.orgId = value;
    }
    if (key === "--resume-after-id") {
      args.resumeAfterId = value;
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
  const batchSize = cli.batchSize ?? DEFAULT_BATCH_SIZE;
  const match: Record<string, unknown> = {
    summaryEmbedding: { $type: "array" },
  };

  if (cli.orgId) {
    match.orgId = cli.orgId;
  }
  if (cli.resumeAfterId) {
    if (!Types.ObjectId.isValid(cli.resumeAfterId)) {
      throw new Error("--resume-after-id must be a valid ObjectId");
    }
    match._id = { $gt: new Types.ObjectId(cli.resumeAfterId) };
  }

  logger.info(
    {
      batchSize,
      maxDocs: cli.maxDocs,
      orgId: cli.orgId,
      resumeAfterId: cli.resumeAfterId,
      dryRun: cli.dryRun,
    },
    "Starting processed item embedding dimensions backfill",
  );

  await connectMongo();

  let scanned = 0;
  let unchanged = 0;
  let pendingUpdates: Array<{ _id: Types.ObjectId; dimensions: number }> = [];
  let modified = 0;
  let lastId: string | null = null;

  const flushBatch = async () => {
    if (pendingUpdates.length === 0) {
      return;
    }
    if (cli.dryRun) {
      pendingUpdates = [];
      return;
    }

    const result = await ProcessedItemModel.bulkWrite(
      pendingUpdates.map((entry) => ({
        updateOne: {
          filter: { _id: entry._id },
          update: { $set: { summaryEmbeddingDimensions: entry.dimensions } },
        },
      })),
      { ordered: false },
    );
    modified += result.modifiedCount ?? 0;
    pendingUpdates = [];
  };

  try {
    const cursor = ProcessedItemModel.find(match, {
      _id: 1,
      summaryEmbedding: 1,
      summaryEmbeddingDimensions: 1,
    })
      .sort({ _id: 1 })
      .lean()
      .cursor<BackfillProcessedItemDoc>();

    try {
      for await (const doc of cursor) {
        if (typeof cli.maxDocs === "number" && scanned >= cli.maxDocs) {
          break;
        }

        scanned += 1;
        lastId = doc._id.toString();
        const dimensions = Array.isArray(doc.summaryEmbedding) ? doc.summaryEmbedding.length : 0;
        if (doc.summaryEmbeddingDimensions === dimensions) {
          unchanged += 1;
          continue;
        }

        pendingUpdates.push({ _id: doc._id, dimensions });
        if (pendingUpdates.length >= batchSize) {
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
        modified,
        dryRun: cli.dryRun,
        lastId,
      },
      "Processed item embedding dimensions backfill completed",
    );
  } finally {
    await disconnectMongo();
  }
}

main().catch((error) => {
  logger.error(
    { error },
    "Processed item embedding dimensions backfill failed",
  );
  process.exitCode = 1;
});
