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

import type { NotificationEvent } from "./notification.dispatcher";
import { NotificationsGateway } from "./notifications.gateway";

/**
 * Alert-only Redis pub/sub channel. The api-go alert worker writes the
 * Notification row itself and then publishes this identifiers-only envelope,
 * exactly like the digest relay.
 */
export const ALERT_NOTIFICATION_CHANNEL = "alert:notifications:v1";

const ALERT_RELAY_VERSION = 1;

const ALERT_PRESENTATION_KIND = "alert_triggered";

interface AlertRelayMessage {
  version: number;
  notificationId: string;
  orgId: string;
  userId: string;
}

/**
 * Alert in-app notification relay.
 *
 * Go committed the Notification row before publishing, so this subscriber only
 * asks the local Socket.IO gateway to emit it. It intentionally does NOT feed the
 * shared NotificationDispatcher: the Socket.IO Redis adapter already broadcasts
 * room emits across instances, and replaying the message through the dispatcher
 * would duplicate every alert once per NestJS instance.
 *
 * In `legacy` mode (the default) no connection is opened: the NestJS
 * AlertsProcessor owns the queue and publishes through the in-process
 * dispatcher. In `go` mode the api-go worker owns the queue and this relay
 * becomes the only realtime path.
 */
@Injectable()
export class AlertNotificationSubscriber
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = createLogger({
    name: "alert-notification-subscriber",
  });
  private subscriber?: Redis;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly env: EnvService,
    private readonly prisma: PrismaService,
    private readonly gateway: NotificationsGateway,
  ) {}

  async onModuleInit() {
    if (this.resolveAlertWorkerMode() !== "go") {
      return;
    }

    const subscriber = this.redis.duplicate();
    subscriber.on("error", (error) => {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Alert notification subscriber redis error",
      );
    });
    subscriber.on("message", (channel, message) => {
      if (channel !== ALERT_NOTIFICATION_CHANNEL) {
        return;
      }
      void this.handleMessage(message).catch((error) => {
        this.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "Failed to handle alert notification relay message",
        );
      });
    });
    this.subscriber = subscriber;

    try {
      await subscriber.subscribe(ALERT_NOTIFICATION_CHANNEL);
      this.logger.info(
        { channel: ALERT_NOTIFICATION_CHANNEL },
        "Alert notification subscriber connected",
      );
    } catch (error) {
      this.subscriber = undefined;
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to subscribe alert notification channel",
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
      await subscriber.unsubscribe(ALERT_NOTIFICATION_CHANNEL);
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

  /** API_GO_ALERT_WORKER_MODE, defaulting to legacy (also for the empty string). */
  private resolveAlertWorkerMode(): string {
    const mode = this.env.get<string>("API_GO_ALERT_WORKER_MODE", {
      infer: true,
    });
    return mode ?? "legacy";
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
    if (record.type !== NotificationType.alert_triggered) {
      return;
    }
    if (!this.isAlertNotification(record.data)) {
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
        "Delivered alert notification to local sockets",
      );
    }
  }

  private parseRelayMessage(raw: string): AlertRelayMessage | null {
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
    if (record.version !== ALERT_RELAY_VERSION) {
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
      version: ALERT_RELAY_VERSION,
      notificationId: record.notificationId,
      orgId: record.orgId,
      userId: record.userId,
    };
  }

  private isAlertNotification(data: unknown): boolean {
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
    return kind === ALERT_PRESENTATION_KIND;
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
