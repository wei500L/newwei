import { createLogger } from "@modular/utils";
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import type { Notification } from "@prisma/client";
import Redis from "ioredis";

import { REDIS_CLIENT } from "../cache/cache.tokens";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

import type { NotificationEvent } from "./notification.dispatcher";
import { NotificationsGateway } from "./notifications.gateway";

/**
 * Analysis-only realtime seam. The Go worker writes the Notification row first
 * and then publishes this identifiers-only envelope. It is intentionally
 * separate from the ordinary in-process NotificationDispatcher: the Socket.IO
 * Redis adapter already broadcasts room emits across instances, so feeding the
 * message back into the shared dispatcher would duplicate every analysis
 * notification once per Nest instance.
 *
 * The subscriber re-reads the row by id + orgId + userId, verifies that it is
 * an analysis notification with the analysis presentation, and emits only to
 * local matching sockets. SQL is the durable result; this relay is best effort
 * and does not promise replay after a disconnect.
 */
export const ANALYSIS_NOTIFICATION_CHANNEL = "analysis:notification:v1";

const ANALYSIS_RELAY_VERSION = 1;

const ANALYSIS_NOTIFICATION_TYPES = new Set<string>([
  "analysis_completed",
  "analysis_failed",
]);

const ANALYSIS_PRESENTATION_KINDS = new Set<string>([
  "analysis_completed",
  "analysis_failed",
]);

interface AnalysisRelayMessage {
  version: number;
  notificationId: string;
  orgId: string;
  userId: string;
}

/**
 * In `legacy` mode this subscriber opens no connection and registers no
 * listener (the NestJS worker still owns the queue and sends notifications
 * through the in-process dispatcher). In `go` mode it consumes the analysis
 * relay.
 */
@Injectable()
export class AnalysisNotificationSubscriber
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = createLogger({
    name: "analysis-notification-subscriber",
  });
  private subscriber?: Redis;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly env: EnvService,
    private readonly prisma: PrismaService,
    private readonly gateway: NotificationsGateway,
  ) {}

  async onModuleInit() {
    if (this.env.apiGoAnalysisWorkerMode !== "go") {
      return;
    }

    const subscriber = this.redis.duplicate();
    subscriber.on("error", (error) => {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Analysis notification subscriber redis error",
      );
    });
    subscriber.on("message", (channel, message) => {
      if (channel !== ANALYSIS_NOTIFICATION_CHANNEL) {
        return;
      }
      void this.handleMessage(message).catch((error) => {
        this.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "Failed to handle analysis notification relay message",
        );
      });
    });
    this.subscriber = subscriber;

    try {
      await subscriber.subscribe(ANALYSIS_NOTIFICATION_CHANNEL);
      this.logger.info(
        { channel: ANALYSIS_NOTIFICATION_CHANNEL },
        "Analysis notification subscriber connected",
      );
    } catch (error) {
      this.subscriber = undefined;
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to subscribe analysis notification channel",
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
      await subscriber.unsubscribe(ANALYSIS_NOTIFICATION_CHANNEL);
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
    if (!ANALYSIS_NOTIFICATION_TYPES.has(record.type)) {
      return;
    }
    if (!this.isAnalysisNotification(record.data)) {
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
        "Delivered analysis notification to local sockets",
      );
    }
  }

  private parseRelayMessage(raw: string): AnalysisRelayMessage | null {
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
    if (record.version !== ANALYSIS_RELAY_VERSION) {
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
      version: ANALYSIS_RELAY_VERSION,
      notificationId: record.notificationId,
      orgId: record.orgId,
      userId: record.userId,
    };
  }

  private isAnalysisNotification(data: unknown): boolean {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return false;
    }
    const record = data as Record<string, unknown>;
    if (typeof record.analysisId !== "string" || record.analysisId.length === 0) {
      return false;
    }
    const presentation = record.presentation;
    if (
      !presentation ||
      typeof presentation !== "object" ||
      Array.isArray(presentation)
    ) {
      return false;
    }
    const kind = (presentation as Record<string, unknown>).kind;
    return (
      typeof kind === "string" && ANALYSIS_PRESENTATION_KINDS.has(kind)
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
