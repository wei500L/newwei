import {
  ItemReadModelModel,
  LlmRequestLogModel,
  ProcessedItemModel,
  RawItemModel,
  connectMongo,
  disconnectMongo,
} from "@modular/mongo";
import type { Model } from "mongoose";

type IndexKey = Record<string, 1 | -1 | "text">;

interface IndexPruneSpec {
  name: string;
  key: IndexKey;
}

interface IndexPruneTarget {
  label: string;
  model: Model<unknown>;
  indexes: IndexPruneSpec[];
}

interface MongoIndexInfo {
  name?: unknown;
  key?: unknown;
}

const targets: IndexPruneTarget[] = [
  {
    label: "RawItem",
    model: RawItemModel as Model<unknown>,
    indexes: [{ name: "itemMetaId_1", key: { itemMetaId: 1 } }],
  },
  {
    label: "ProcessedItem",
    model: ProcessedItemModel as Model<unknown>,
    indexes: [
      { name: "orgId_1", key: { orgId: 1 } },
      { name: "itemMetaId_1", key: { itemMetaId: 1 } },
      { name: "sourceId_1", key: { sourceId: 1 } },
    ],
  },
  {
    label: "ItemReadModel",
    model: ItemReadModelModel as Model<unknown>,
    indexes: [{ name: "orgId_1", key: { orgId: 1 } }],
  },
  {
    label: "LlmRequestLog",
    model: LlmRequestLogModel as Model<unknown>,
    indexes: [
      { name: "orgId_1", key: { orgId: 1 } },
      { name: "requestType_1", key: { requestType: 1 } },
      { name: "model_1", key: { model: 1 } },
      { name: "status_1", key: { status: 1 } },
      { name: "feature_1", key: { feature: 1 } },
      { name: "gatewayProfileId_1", key: { gatewayProfileId: 1 } },
      { name: "governanceApplied_1", key: { governanceApplied: 1 } },
      { name: "authMode_1", key: { authMode: 1 } },
      {
        name: "governanceTargetProfileId_1",
        key: { governanceTargetProfileId: 1 },
      },
      { name: "apiSurface_1", key: { apiSurface: 1 } },
    ],
  },
];

function keysMatch(actual: unknown, expected: IndexKey): boolean {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    return false;
  }

  const actualEntries = Object.entries(actual as Record<string, unknown>);
  const expectedEntries = Object.entries(expected);
  if (actualEntries.length !== expectedEntries.length) {
    return false;
  }

  return expectedEntries.every(([field, value], index) => {
    const actualEntry = actualEntries[index];
    return actualEntry?.[0] === field && actualEntry[1] === value;
  });
}

function isNamespaceNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  const codeName = (error as { codeName?: unknown }).codeName;
  return code === 26 || codeName === "NamespaceNotFound";
}

function isIndexNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  const codeName = (error as { codeName?: unknown }).codeName;
  return code === 27 || codeName === "IndexNotFound";
}

async function loadIndexes(target: IndexPruneTarget): Promise<MongoIndexInfo[]> {
  try {
    return (await target.model.collection.indexes()) as MongoIndexInfo[];
  } catch (error) {
    if (isNamespaceNotFound(error)) {
      return [];
    }
    throw error;
  }
}

async function pruneTarget(target: IndexPruneTarget): Promise<void> {
  const currentIndexes = await loadIndexes(target);

  for (const spec of target.indexes) {
    const current = currentIndexes.find((index) => index.name === spec.name);
    if (!current) {
      console.log(`[mongo:indexes:prune] ${target.label}.${spec.name} not present`);
      continue;
    }

    if (!keysMatch(current.key, spec.key)) {
      console.warn(
        `[mongo:indexes:prune] ${target.label}.${spec.name} key mismatch; leaving index in place`,
      );
      continue;
    }

    try {
      await target.model.collection.dropIndex(spec.name);
      console.log(`[mongo:indexes:prune] dropped ${target.label}.${spec.name}`);
    } catch (error) {
      if (isIndexNotFound(error)) {
        console.log(`[mongo:indexes:prune] ${target.label}.${spec.name} already dropped`);
        continue;
      }
      throw error;
    }
  }
}

async function main() {
  await connectMongo();
  try {
    for (const target of targets) {
      await pruneTarget(target);
    }
    console.log("[mongo:indexes:prune] done");
  } finally {
    await disconnectMongo();
  }
}

main().catch((error) => {
  console.error(
    `[mongo:indexes:prune] failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exitCode = 1;
});
