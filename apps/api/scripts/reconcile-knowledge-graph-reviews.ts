import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

if (!process.env.BULL_BOARD_ENABLED?.trim()) {
  process.env.BULL_BOARD_ENABLED = "false";
}
if (!process.env.BULL_BOARD_USERNAME?.trim()) {
  process.env.BULL_BOARD_USERNAME = "script";
}
if (!process.env.BULL_BOARD_PASSWORD?.trim()) {
  process.env.BULL_BOARD_PASSWORD = "script";
}

const { AppModule } = require("../src/app.module");
const { KnowledgeGraphReviewService } = require("../src/modules/knowledge-graph/knowledge-graph-review.service");

function parseArgs() {
  const args: { orgId?: string; batchSize?: number; maxRows?: number } = {};
  for (const raw of process.argv.slice(2)) {
    const [key, value] = raw.split("=", 2);
    if (!key || value === undefined) {
      continue;
    }
    if (key === "--org-id" && value.trim()) {
      args.orgId = value.trim();
    }
    if (key === "--batch-size") {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.batchSize = Math.floor(parsed);
      }
    }
    if (key === "--max-rows") {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.maxRows = Math.floor(parsed);
      }
    }
  }
  return args;
}

async function bootstrap() {
  const logger = new Logger("ReconcileKnowledgeGraphReviews");
  const input = parseArgs();
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn", "log"]
  });

  try {
    const review = app.get<typeof KnowledgeGraphReviewService>(KnowledgeGraphReviewService);
    logger.log(
      `Reconciling reviewed knowledge graph evidence${input.orgId ? ` for org ${input.orgId}` : ""}...`
    );
    const result = await review.reconcileReviewedEvidence(input);
    logger.log(
      `Reconciliation complete: scanned=${result.scanned}, reconciled=${result.reconciled}, skipped=${result.skipped}, failed=${result.failed}`
    );
    if (result.failed > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    logger.error(
      `Knowledge graph review reconciliation failed: ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }`
    );
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void bootstrap();
