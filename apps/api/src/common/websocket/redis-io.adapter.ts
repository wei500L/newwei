import { createLogger } from "@modular/utils";
import type { INestApplicationContext } from "@nestjs/common";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import type { ServerOptions } from "socket.io";

import type { EnvService } from "../../modules/config/config.service";
import { toNodeRedisConnection } from "../../modules/config/redis-connection";

export class RedisIoAdapter extends IoAdapter {
  private pubClient?: ReturnType<typeof createClient>;
  private subClient?: ReturnType<typeof createClient>;
  private readonly logger = createLogger({ name: "redis-io-adapter" });

  constructor(
    app: INestApplicationContext,
    private readonly env: EnvService
  ) {
    super(app);
  }

  async connectToRedis() {
    const redisConfig = this.env.redisConfig;
    const pubClient = createClient(
      toNodeRedisConnection(redisConfig) as Parameters<typeof createClient>[0],
    );
    const subClient = pubClient.duplicate();
    this.pubClient = pubClient;
    this.subClient = subClient;

    pubClient.on("error", (error) => {
      this.logger.error({ error }, "Socket.io Redis pub client error");
    });
    subClient.on("error", (error) => {
      this.logger.error({ error }, "Socket.io Redis sub client error");
    });

    await Promise.all([pubClient.connect(), subClient.connect()]);
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
