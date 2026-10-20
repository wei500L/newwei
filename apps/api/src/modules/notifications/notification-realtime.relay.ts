import { createLogger } from "@modular/utils";
import { Inject, Injectable } from "@nestjs/common";
import type Redis from "ioredis";

import { REDIS_CLIENT } from "../cache/cache.tokens";
import { EnvService } from "../config/config.service";

import type { NotificationEvent } from "./notification.dispatcher";

/**
 * Identifiers-only relay for the Go notifications transport. The row is
 * committed before publish; the Go subscriber re-reads it and emits only to
 * its local sockets. Keeping the payload out of Redis means a mutable display
 * field cannot be delivered from a stale envelope.
 */
export const NOTIFICATION_REALTIME_CHANNEL = "notification:events:v1";

const RELAY_VERSION = 1;

interface NotificationRelayMessage {
  version: number;
  notificationId: string;
  orgId: string;
  userId?: string;
}

@Injectable()
export class NotificationRealtimeRelay {
  private readonly logger = createLogger({
    name: "notification-realtime-relay",
  });

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly env: EnvService,
  ) {}

  /** API_GO_NOTIFICATIONS_SOCKET_MODE, defaulting to legacy. */
  get enabled(): boolean {
    return (
      this.env.get<string>("API_GO_NOTIFICATIONS_SOCKET_MODE", {
        infer: true,
      }) === "go"
    );
  }

  async publish(event: NotificationEvent): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const message: NotificationRelayMessage = {
      version: RELAY_VERSION,
      notificationId: event.id,
      orgId: event.orgId,
    };
    if (event.userId) {
      message.userId = event.userId;
    }
    try {
      await this.redis.publish(
        NOTIFICATION_REALTIME_CHANNEL,
        JSON.stringify(message),
      );
    } catch (error) {
      // Realtime delivery is best effort; the Notification row is already
      // committed and remains readable through the inbox query.
      this.logger.warn(
        { notificationId: event.id, error },
        "Failed to publish notification realtime relay",
      );
    }
  }
}
