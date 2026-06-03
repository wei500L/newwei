import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import Redis, { type RedisOptions } from "ioredis";

import { EnvService } from "./config.service";
import { toBullmqConnection } from "./redis-connection";

const logger = createLogger({ name: "bullmq-redis" });

function connectionName(label: string): string {
  const safeLabel = label.replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 80);
  return `modular-api:bullmq:${safeLabel}:${process.pid}`;
}

@Injectable()
export class BullmqConnectionService {
  private sharedConnection?: Redis;

  constructor(private readonly env: EnvService) {}

  getSharedConnection(): Redis {
    if (
      !this.sharedConnection ||
      this.sharedConnection.status === "end" ||
      this.sharedConnection.status === "close"
    ) {
      const redisConfig = this.env.redisConfig;
      const connection = new Redis({
        ...toBullmqConnection(redisConfig),
        connectionName: connectionName("shared"),
      });
      connection.on("error", (error) => {
        logger.warn({ error }, "BullMQ shared Redis client error");
      });
      this.sharedConnection = connection;
      logger.info(
        { host: redisConfig.host, port: redisConfig.port, db: redisConfig.db },
        "BullMQ shared Redis client created",
      );
    }

    return this.sharedConnection;
  }

  createDedicatedConnectionOptions(label: string): RedisOptions {
    return {
      ...toBullmqConnection(this.env.redisConfig),
      connectionName: connectionName(label),
    };
  }

  async shutdown(): Promise<void> {
    const connection = this.sharedConnection;
    this.sharedConnection = undefined;
    if (!connection || connection.status === "end") {
      return;
    }

    try {
      await connection.quit();
    } catch (error) {
      logger.warn({ error }, "Failed to quit BullMQ shared Redis client");
      connection.disconnect();
    }
  }
}
