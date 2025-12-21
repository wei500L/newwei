import { createLogger } from "@modular/utils";
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";

import { EnvService } from "./config.service";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger({ name: "prisma" });

  constructor(@Inject(EnvService) private readonly env: EnvService) {
    const connectionString =
      process.env.DATABASE_URL ??
      `mysql://${env.get<string>("MYSQL_USER", { infer: true })}:${encodeURIComponent(
        env.get<string>("MYSQL_PASSWORD", { infer: true }) ?? ""
      )}@${env.get<string>("MYSQL_HOST", { infer: true })}:${env.get<number>("MYSQL_PORT", {
        infer: true
      })}/${env.get<string>("MYSQL_DB", { infer: true })}`;

    process.env.DATABASE_URL = connectionString;
    super({
      datasources: {
        db: {
          url: connectionString
        }
      }
    });
  }

  async onModuleInit() {
    await this.$connect();

    if (process.env.NODE_ENV !== "production") {
      try {
        await this.$queryRawUnsafe("SELECT 1 FROM `_prisma_migrations` LIMIT 1");
      } catch (error) {
        this.logger.error(
          { err: error },
          "Database schema not initialized; run `pnpm db:migrate` (and `pnpm db:seed`) before starting the API"
        );
        const migrationError = new Error(
          "Database schema not initialized; run `pnpm db:migrate` (and `pnpm db:seed`) before starting the API"
        );
        try {
          (migrationError as unknown as { cause?: unknown }).cause = error;
        } catch {
          // ignore
        }
        throw migrationError;
      }
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  async runInTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.$transaction(fn, { timeout: 15000 });
  }
}
