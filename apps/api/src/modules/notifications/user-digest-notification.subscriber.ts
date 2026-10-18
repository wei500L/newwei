import { createLogger } from "@modular/utils";
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { Notification, NotificationType } from "@prisma/client";
import Redis from "ioredis";

import { REDIS_CLIENT } from "../cache/cache.tokens";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

import { NotificationEvent } from "./notification.dispatcher";
import { NotificationsGateway } from "./notifications.gateway";

/**
 * The digest-only Redis pub/sub channel Go publishes after it writes a
 * Notification row. It is intentionally separate from the ordinary in-process
 * NotificationDispatcher: the Socket.IO Redis adapter already broadcasts room
 * emits across instances, so feeding this message back into the shared
 * dispatcher would duplicate every digest notification once per Nest instance.
 */
export const USER_DIGEST_NOTIFICATION_CHANNEL = "user-digest:notifications:v1";

const USER_DIGEST_RELAY_VERSION = 1;

const USER_DIGEST_NOTIFICATION_KINDS = new Set<string>([
  "user_digest_ready",
  "user_digest_empty",
  "user_digest_delivery_failed",
]);

interface UserDigestRelayMessage {
  version: number;
  notificationId: string;
  orgId: string;
  userId: string;
}

/**
 * Digest-specific realtime relay. In `legacy` mode it opens no connection and
 * registers no listener; in `go` mode it duplicates the shared Redis client,
 * re-reads the Notification row by id + orgId + userId and delivers the event
 * only to local authenticated sockets of this instance.
 */
@Injectable()
export class UserDigestNotificationSubscriber
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = createLogger({
    name: "user-digest-notification-subscriber",
  });
  private subscriber?: Redis;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly env: EnvService,
    private readonly prisma: PrismaService,
    private readonly gateway: NotificationsGateway,
  ) {}

  async onModuleInit() {
    if (this.resolveDeliveryMode() !== "go") {
      return;
    }

    const subscriber = this.redis.duplicate();
    subscriber.on("error", (error) => {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "User digest notification subscriber redis error",
      );
    });
    subscriber.on("message", (channel, message) => {
      if (channel !== USER_DIGEST_NOTIFICATION_CHANNEL) {
        return;
      }
      void this.handleMessage(message).catch((error) => {
        this.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "Failed to handle user digest notification relay message",
        );
      });
    });
    this.subscriber = subscriber;

    try {
      await subscriber.subscribe(USER_DIGEST_NOTIFICATION_CHANNEL);
      this.logger.info(
        { channel: USER_DIGEST_NOTIFICATION_CHANNEL },
        "User digest notification subscriber connected",
      );
    } catch (error) {
      this.subscriber = undefined;
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to subscribe user digest notification channel",
      );
      await subscriber.quit().catch(() => subscriber.disconnect());
    }
  }

  async onModuleDestroy() {
    const subscriber = this.subscriber;
    this.subscriber = undefined;
    if (!subscriber) {
      return;
    }
    try {
      await subscriber.unsubscribe(USER_DIGEST_NOTIFICATION_CHANNEL);
    } catch {
      // best-effort unsubscribe
    }
    try {
      // Only the duplicate connection is closed; the shared REDIS_CLIENT stays
      // owned by CacheModule.
      await subscriber.quit();
    } catch {
      subscriber.disconnect();
    }
  }

  private resolveDeliveryMode(): string {
    return (
      this.env.get("API_GO_USER_DIGEST_DELIVERY_MODE", {
        infer: true,
      }) ?? "legacy"
    );
  }

  private async handleMessage(raw: string) {
    const relay = this.parseRelayMessage(raw);
    if (!relay) {
      return;
    }
    const record = await this.prisma.notification.findFirst({
      where: {
        id: relay.notificationId,
        orgId: relay.orgId,
        userId: relay.userId,
      },
    });
    if (!record) {
      return;
    }
    if (record.type !== NotificationType.system) {
      return;
    }
    if (!this.isUserDigestNotification(record.data)) {
      return;
    }
    const delivered = this.gateway.emitLocalNotification(
      relay.orgId,
      relay.userId,
      this.toEvent(record),
    );
    if (delivered > 0) {
      this.logger.debug(
        { notificationId: relay.notificationId, orgId: relay.orgId, delivered },
        "Delivered user digest notification to local sockets",
      );
    }
  }

  private parseRelayMessage(raw: string): UserDigestRelayMessage | null {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (record.version !== USER_DIGEST_RELAY_VERSION) {
      return null;
    }
    if (
      typeof record.notificationId !== "string" ||
      record.notificationId.length === 0 ||
      typeof record.orgId !== "string" ||
      record.orgId.length === 0 ||
      typeof record.userId !== "string" ||
      record.userId.length === 0
    ) {
      return null;
    }
    return {
      version: USER_DIGEST_RELAY_VERSION,
      notificationId: record.notificationId,
      orgId: record.orgId,
      userId: record.userId,
    };
  }

  private isUserDigestNotification(data: unknown): boolean {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return false;
    }
    const presentation = (data as Record<string, unknown>).presentation;
    if (
      !presentation ||
      typeof presentation !== "object" ||
      Array.isArray(presentation)
    ) {
      return false;
    }
    const kind = (presentation as Record<string, unknown>).kind;
    return (
      typeof kind === "string" && USER_DIGEST_NOTIFICATION_KINDS.has(kind)
    );
  }

  private toEvent(record: Notification): NotificationEvent {
    return {
      id: record.id,
      orgId: record.orgId,
      userId: record.userId,
      type: record.type,
      title: record.title,
      body: record.body,
      data: record.data as Record<string, unknown> | null,
      readAt: record.readAt ? record.readAt.toISOString() : null,
      createdAt: record.createdAt.toISOString(),
    };
  }
}
