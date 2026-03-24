import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";

import type { RedisIoAdapter } from "../../common/websocket/redis-io.adapter";

@Injectable()
export class WebSocketAdapterRegistry {
  private readonly logger = createLogger({
    name: "websocket-adapter-registry",
  });
  private redisIoAdapter?: RedisIoAdapter;

  setRedisIoAdapter(adapter: RedisIoAdapter) {
    this.redisIoAdapter = adapter;
  }

  async disconnectRedisIoAdapter() {
    if (!this.redisIoAdapter) {
      return;
    }

    const adapter = this.redisIoAdapter;
    this.redisIoAdapter = undefined;

    await adapter.disconnect();
    this.logger.info("Socket.IO Redis adapter disconnected");
  }
}
