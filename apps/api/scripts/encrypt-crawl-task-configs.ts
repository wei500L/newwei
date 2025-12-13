import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import {
  decodeCrawlTaskConfigKey,
  protectCrawlTaskConfigForStorage
} from "../src/modules/crawl/crawl-config-secrets";

type ScriptArgs = {
  orgId?: string;
  dryRun: boolean;
  batchSize: number;
};

function parseArgs(argv: string[]): ScriptArgs {
  const args: ScriptArgs = { dryRun: false, batchSize: 200 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (value === "--org" || value === "--orgId") {
      args.orgId = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--batch") {
      const raw = argv[index + 1];
      const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
      if (!Number.isNaN(parsed) && parsed > 0) {
        args.batchSize = Math.min(1000, parsed);
      }
      index += 1;
      continue;
    }
  }
  return args;
}

async function main() {
  const { orgId, dryRun, batchSize } = parseArgs(process.argv.slice(2));
  const rawKey = process.env.CRAWL_TASK_CONFIG_ENCRYPTION_KEY;
  if (!rawKey) {
    throw new Error("CRAWL_TASK_CONFIG_ENCRYPTION_KEY is required");
  }
  const key = decodeCrawlTaskConfigKey(rawKey);
  const prisma = new PrismaClient();

  let scanned = 0;
  let updated = 0;
  let cursor: string | undefined;

  try {
    for (;;) {
      const tasks = await prisma.crawlTask.findMany({
        take: batchSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        where: orgId ? { orgId } : undefined,
        select: { id: true, orgId: true, config: true }
      });
      if (tasks.length === 0) {
        break;
      }

      for (const task of tasks) {
        scanned += 1;
        const config =
          task.config && typeof task.config === "object" && !Array.isArray(task.config)
            ? (task.config as Record<string, unknown>)
            : null;
        if (!config) {
          continue;
        }

        const result = protectCrawlTaskConfigForStorage(config, key);
        if (!result.didEncrypt || !result.config) {
          continue;
        }

        updated += 1;
        if (!dryRun) {
          await prisma.crawlTask.update({
            where: { id: task.id },
            data: { config: result.config }
          });
        }
      }

      cursor = tasks[tasks.length - 1]?.id;
    }
  } finally {
    await prisma.$disconnect();
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun,
        orgId: orgId ?? null,
        scanned,
        updated
      },
      null,
      2
    )
  );
}

void main();

