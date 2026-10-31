// Operational Mongo index maintenance: create the runtime indexes declared by
// the shared @modular/mongo models. This is a standalone Node tool so index
// operations no longer depend on the NestJS application module tree.
//
// Behaviour is preserved from the former apps/api script: RawItem is synced to
// its schema; the other hot-path models only create missing indexes. The tool
// connects, works, then always disconnects and exits non-zero on failure.
import {
  ItemReadModelModel,
  LlmRequestLogModel,
  NewsEventClusteringFailureModel,
  ProcessedItemModel,
  RawItemModel,
  TaskLogModel,
  connectMongo,
  disconnectMongo,
} from "../index";

async function main() {
  await connectMongo();

  try {
    const models = [
      {
        label: "RawItem",
        model: RawItemModel,
        mode: "sync",
      },
      {
        label: "ProcessedItem",
        model: ProcessedItemModel,
        mode: "create",
      },
      {
        label: "ItemReadModel",
        model: ItemReadModelModel,
        mode: "create",
      },
      {
        label: "NewsEventClusteringFailure",
        model: NewsEventClusteringFailureModel,
        mode: "create",
      },
      {
        label: "LlmRequestLog",
        model: LlmRequestLogModel,
        mode: "create",
      },
      {
        label: "TaskLog",
        model: TaskLogModel,
        mode: "create",
      },
    ] as const;

    for (const entry of models) {
      console.log(`[mongo:indexes] ensuring ${entry.label} indexes...`);
      if (entry.mode === "sync") {
        await entry.model.syncIndexes();
        console.log(`[mongo:indexes] ${entry.label} indexes synced to schema`);
        continue;
      }
      const created = await entry.model.createIndexes();
      const acknowledgedCount = Array.isArray(created)
        ? created.length
        : created && typeof created === "object"
          ? Object.keys(created).length
          : 0;
      console.log(
        `[mongo:indexes] ${entry.label} indexes ensured (${acknowledgedCount} index specs acknowledged)`,
      );
    }

    console.log("[mongo:indexes] done");
  } finally {
    await disconnectMongo();
  }
}

void main().catch((error) => {
  console.error(
    `[mongo:indexes] failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exitCode = 1;
});
