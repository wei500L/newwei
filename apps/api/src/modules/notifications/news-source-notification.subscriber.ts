import { createLogger, NotificationPresentationKind } from "@modular/utils";
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

import type { NotificationEvent } from "./notification.dispatcher";
import { NotificationsGateway } from "./notifications.gateway";

/**
 * News-source Redis pub/sub channel. The api-go scheduler and the four ops
 * POSTs write the org-wide Notification row themselves and then publish this
 * identifiers-only envelope, exactly like the alert and analysis relays.
 */
export const NEWS_SOURCE_NOTIFICATION_CHANNEL = "news-source:notifications:v1";

const NEWS_SOURCE_RELAY_VERSION = 1;

const NEWS_SOURCE_PRESENTATION_KINDS = new Set<string>([
  NotificationPresentationKind.NewsSourceSchedulerBackpressure,
  NotificationPresentationKind.NewsSourceRssBodyMissingSpike,
  NotificationPresentationKind.NewsSourcePipelineRetrySpike,
  // Written by the Go itemPipeline worker on the final failure that opens the
  // circuit or auto-disables a source.
  NotificationPresentationKind.NewsSourceCircuitOpened,
  NotificationPresentationKind.NewsSourceAutoDisabled,
]);

interface NewsSourceRelayMessage {
  version: number;
  notificationId: string;
  orgId: string;
}

/**
 * News-source in-app notification relay.
 *
 * The production notifications are org-wide system rows, so the message has no
 * userId and the row must have a null userId. Go committed the Notification
 * row before publishing, so this subscriber only asks the local Socket.IO
 * gateway to emit it. It intentionally does NOT feed the shared
 * NotificationDispatcher: the Socket.IO Redis adapter already broadcasts room
 * emits across instances, and replaying the message through the dispatcher
 * would duplicate every notification once per NestJS instance.
 *
 * When both API_GO_NEWS_SOURCE_SCHEDULER_MODE and API_GO_NEWS_SOURCE_OPS_MODE
 * are legacy (the default) no connection is opened: NestJS owns the scheduler
 * and the four ops routes and publishes through the in-process dispatcher.
 */
@Injectable()
export class NewsSourceNotificationSubscriber
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = createLogger({
    name: "news-source-notification-subscriber",
  });
  private subscriber?: Redis;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly env: EnvService,
    private readonly prisma: PrismaService,
    private readonly gateway: NotificationsGateway,
  ) {}

  async onModuleInit() {
    if (!this.isGoOwned()) {
      return;
    }

    const subscriber = this.redis.duplicate();
    subscriber.on("error", (error) => {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "News-source notification subscriber redis error",
      );
    });
    subscriber.on("message", (channel, message) => {
      if (channel !== NEWS_SOURCE_NOTIFICATION_CHANNEL) {
        return;
      }
      void this.handleMessage(message).catch((error) => {
        this.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "Failed to handle news-source notification relay message",
        );
      });
    });
    this.subscriber = subscriber;

    try {
      await subscriber.subscribe(NEWS_SOURCE_NOTIFICATION_CHANNEL);
      this.logger.info(
        { channel: NEWS_SOURCE_NOTIFICATION_CHANNEL },
        "News-source notification subscriber connected",
      );
    } catch (error) {
      this.subscriber = undefined;
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to subscribe news-source notification channel",
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
      await subscriber.unsubscribe(NEWS_SOURCE_NOTIFICATION_CHANNEL);
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

  /**
   * Subscribes when either switch is go; every other value (including the
   * empty string) opens no connection, matching the legacy default.
   */
  private isGoOwned(): boolean {
    return (
      this.resolveMode("API_GO_NEWS_SOURCE_SCHEDULER_MODE") === "go" ||
      this.resolveMode("API_GO_NEWS_SOURCE_OPS_MODE") === "go" ||
      // The Go item pipeline worker also writes news-source system
      // notifications (circuit opened / auto disabled), so the relay must be
      // subscribed even when the scheduler and ops routes are still legacy.
      this.resolveMode("API_GO_ITEM_PIPELINE_WORKER_MODE") === "go"
    );
  }

  private resolveMode(
    key:
      | "API_GO_NEWS_SOURCE_SCHEDULER_MODE"
      | "API_GO_NEWS_SOURCE_OPS_MODE"
      | "API_GO_ITEM_PIPELINE_WORKER_MODE",
  ): string {
    const mode = this.env.get<string>(key, { infer: true });
    return mode ?? "legacy";
  }

  private async handleMessage(raw: string) {
    const relay = this.parseRelayMessage(raw);
    if (!relay) {
      return;
    }
    const record = await this.prisma.notification.findFirst({
      where: { id: relay.notificationId, orgId: relay.orgId },
    });
    if (!record) {
      return;
    }
    // News-source notifications are org-wide system rows: a user-scoped row
    // with the same id is a different notification and must not be relayed.
    if (record.userId !== null) {
      return;
    }
    if (record.type !== NotificationType.system) {
      return;
    }
    if (!this.isNewsSourceNotification(record.data)) {
      return;
    }
    const delivered = this.gateway.emitLocalOrgNotification(relay.orgId, this.toEvent(record));
    if (delivered > 0) {
      this.logger.debug(
        { notificationId: relay.notificationId, orgId: relay.orgId, delivered },
        "Delivered news-source notification to local org sockets",
      );
    }
  }

  private parseRelayMessage(raw: string): NewsSourceRelayMessage | null {
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
    if (record.version !== NEWS_SOURCE_RELAY_VERSION) {
      return null;
    }
    if (
      typeof record.notificationId !== "string" ||
      record.notificationId.length === 0 ||
      typeof record.orgId !== "string" ||
      record.orgId.length === 0
    ) {
      return null;
    }
    return {
      version: NEWS_SOURCE_RELAY_VERSION,
      notificationId: record.notificationId,
      orgId: record.orgId,
    };
  }

  private isNewsSourceNotification(data: unknown): boolean {
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
    return typeof kind === "string" && NEWS_SOURCE_PRESENTATION_KINDS.has(kind);
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
