import { createLogger } from "@modular/utils";
import { createAdapter } from "@socket.io/redis-adapter";
import { IoAdapter } from "@nestjs/platform-socket.io";
import type { INestApplicationContext } from "@nestjs/common";
import { createClient, type RedisClientType } from "redis";
import type { ServerOptions } from "socket.io";

import { EnvService } from "../../modules/config/config.service";

export class RedisIoAdapter extends IoAdapter {
  private pubClient?: RedisClientType;
  private subClient?: RedisClientType;
  private readonly logger = createLogger({ name: "redis-io-adapter" });

  constructor(
    app: INestApplicationContext,
    private readonly env: EnvService
  ) {
    super(app);
  }

  async connectToRedis() {
    const redisConfig = this.env.redisConfig;
    this.pubClient = createClient({
      socket: {
        host: redisConfig.host,
        port: redisConfig.port
      },
      username: redisConfig.username,
      database: redisConfig.db
    });
    this.subClient = this.pubClient.duplicate();

    this.pubClient.on("error", (error) => {
      this.logger.error({ error }, "Socket.io Redis pub client error");
    });
    this.subClient.on("error", (error) => {
      this.logger.error({ error }, "Socket.io Redis sub client error");
    });

    await Promise.all([this.pubClient.connect(), this.subClient.connect()]);
    this.logger.info(
      { host: redisConfig.host, port: redisConfig.port, db: redisConfig.db },
      "Socket.io Redis adapter connected"
    );
  }

  override createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options);
    if (this.pubClient && this.subClient && this.env.webSocketRedisAdapter.enabled) {
      server.adapter(
        createAdapter(this.pubClient, this.subClient, {
          key: this.env.webSocketRedisAdapter.key
        })
      );
      this.logger.info({ key: this.env.webSocketRedisAdapter.key }, "Socket.io Redis adapter enabled");
    }
    return server;
  }

  async disconnect() {
    try {
      await this.pubClient?.quit();
    } catch {
      // best-effort
    }
    try {
      await this.subClient?.quit();
    } catch {
      // best-effort
    }
  }
}

