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

const { AkshareService } = require("../src/modules/akshare/akshare.service");
const { AppModule } = require("../src/app.module");

async function bootstrap() {
  const logger = new Logger("FetchEconomicData");
  const slugs = process.argv
    .slice(2)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (slugs.length === 0) {
    logger.error("Usage: pnpm --filter @modular/api economic:fetch <slug> [...slug]");
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn", "log"],
  });

  try {
    const service = app.get(AkshareService);
    for (const slug of slugs) {
      logger.log(`Fetching ${slug}...`);
      const storedCount = await service.fetchAndPersist(slug);
      logger.log(`Fetch complete for ${slug}; stored ${storedCount} points`);
    }
  } catch (error) {
    logger.error(
      `Failed to fetch economic data: ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void bootstrap();
