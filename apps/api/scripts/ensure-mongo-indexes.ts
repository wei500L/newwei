import {
  ProcessedItemModel,
  connectMongo,
  disconnectMongo,
} from "@modular/mongo";

async function main() {
  await connectMongo();

  try {
    const models = [
      {
        label: "ProcessedItem",
        model: ProcessedItemModel,
      },
    ] as const;

    for (const entry of models) {
      console.log(`[mongo:indexes] ensuring ${entry.label} indexes...`);
      const created = await entry.model.createIndexes();
      console.log(
        `[mongo:indexes] ${entry.label} indexes ensured (${created.length} index specs acknowledged)`,
      );
    }

    console.log("[mongo:indexes] done");
  } finally {
    await disconnectMongo();
  }
}

main().catch((error) => {
  console.error(
    `[mongo:indexes] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
