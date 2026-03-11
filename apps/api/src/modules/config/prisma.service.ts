import { createLogger, resolveMysqlConnectionString } from "@modular/utils";
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";

import { EnvService } from "./config.service";

const REQUIRED_KNOWLEDGE_GRAPH_DELEGATES = [
  "knowledgeEntity",
  "knowledgeEntityAlias",
  "knowledgeEdge",
  "knowledgeEdgeEvidence",
  "knowledgeGraphIngestionState",
  "articleEntityLink",
] as const;

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = createLogger({ name: "prisma" });

  constructor(@Inject(EnvService) private readonly env: EnvService) {
    const connectionString = resolveMysqlConnectionString({
      DATABASE_URL: process.env.DATABASE_URL,
      MYSQL_HOST: env.get<string | undefined>("MYSQL_HOST", { infer: true }),
      MYSQL_PORT: env.get<number | undefined>("MYSQL_PORT", { infer: true }),
      MYSQL_USER: env.get<string | undefined>("MYSQL_USER", { infer: true }),
      MYSQL_PASSWORD: env.get<string | undefined>("MYSQL_PASSWORD", {
        infer: true,
      }),
      MYSQL_DB: env.get<string | undefined>("MYSQL_DB", { infer: true }),
    });

    process.env.DATABASE_URL = connectionString;
    super({
      datasources: {
        db: {
          url: connectionString,
        },
      },
    });
  }

  async onModuleInit() {
    await this.$connect();

    if (process.env.NODE_ENV !== "production") {
      try {
        await this.$queryRawUnsafe(
          "SELECT 1 FROM `_prisma_migrations` LIMIT 1",
        );
      } catch (error) {
        this.logger.error(
          { err: error },
          "Database schema not initialized; run `pnpm db:migrate` (and `pnpm db:seed`) before starting the API",
        );
        const migrationError = new Error(
          "Database schema not initialized; run `pnpm db:migrate` (and `pnpm db:seed`) before starting the API",
        );
        try {
          (migrationError as unknown as { cause?: unknown }).cause = error;
        } catch {
          // ignore
        }
        throw migrationError;
      }

      this.ensureKnowledgeGraphDelegates();
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  async runInTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.$transaction(fn, { timeout: 15000 });
  }

  private ensureKnowledgeGraphDelegates() {
    const delegates = this as unknown as Record<string, unknown>;
    const missingDelegates = REQUIRED_KNOWLEDGE_GRAPH_DELEGATES.filter(
      (delegate) => {
        const candidate = delegates[delegate];
        return !candidate || typeof candidate !== "object";
      },
    );

    if (missingDelegates.length === 0) {
      return;
    }

    const message =
      "Prisma client is missing knowledge graph delegates. Run `pnpm --filter @modular/db prisma:generate` and restart the API.";
    this.logger.error({ missingDelegates }, message);
    throw new Error(`${message} Missing: ${missingDelegates.join(", ")}`);
  }
}
