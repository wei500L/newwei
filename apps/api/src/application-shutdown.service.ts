import { disconnectMongo } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Injectable, OnApplicationShutdown } from "@nestjs/common";

import { BullmqConnectionService } from "./modules/config/bullmq-connection.service";
import { WebSocketAdapterRegistry } from "./modules/websocket/websocket-adapter-registry.service";

@Injectable()
export class ApplicationShutdownService implements OnApplicationShutdown {
  private readonly logger = createLogger({ name: "application-shutdown" });
  private shutdownPromise?: Promise<void>;

  constructor(
    private readonly webSocketAdapterRegistry: WebSocketAdapterRegistry,
    private readonly bullmqConnections: BullmqConnectionService,
  ) {}

  onApplicationShutdown(signal?: string) {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.shutdown(signal);
    }

    return this.shutdownPromise;
  }

  private async shutdown(signal?: string) {
    this.logger.info({ signal }, "Shutting down application resources");

    const [mongoResult, adapterResult, bullmqResult] = await Promise.allSettled([
      disconnectMongo(),
      this.webSocketAdapterRegistry.disconnectRedisIoAdapter(),
      this.bullmqConnections.shutdown(),
    ]);

    if (mongoResult.status === "rejected") {
      this.logger.warn(
        { error: mongoResult.reason, signal },
        "Failed to disconnect Mongo during application shutdown",
      );
    }

    if (adapterResult.status === "rejected") {
      this.logger.warn(
        { error: adapterResult.reason, signal },
        "Failed to disconnect Socket.IO Redis adapter during application shutdown",
      );
    }

    if (bullmqResult.status === "rejected") {
      this.logger.warn(
        { error: bullmqResult.reason, signal },
        "Failed to disconnect BullMQ shared Redis client during application shutdown",
      );
    }
  }
}
