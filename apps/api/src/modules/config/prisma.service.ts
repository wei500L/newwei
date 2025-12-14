import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { EnvService } from "./config.service";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
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
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  async runInTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.$transaction(fn, { timeout: 15000 });
  }
}
