import { createLogger } from '@modular/utils';
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Notification } from '@prisma/client';
import type Redis from 'ioredis';

import { REDIS_CLIENT } from '../cache/cache.tokens';
import { EnvService } from '../config/config.service';
import { PrismaService } from '../config/prisma.service';

import { NOTIFICATION_REALTIME_CHANNEL } from './notification-realtime.relay';
import type { NotificationEvent } from './notification.dispatcher';
import { NotificationsGateway } from './notifications.gateway';

/**
 * Version of the identifiers-only envelope written on
 * notification:events:v1. It must match RELAY_VERSION in
 * notification-realtime.relay.ts and relayVersion in the api-go
 * notificationssocket package.
 */
const GENERIC_RELAY_VERSION = 1;

interface GenericRelayMessage {
  version: number;
  notificationId: string;
  orgId: string;
  /** Omitted for organization-wide rows (Notification.userId is NULL). */
  userId?: string;
}

/**
 * Generic relay for every in-app notification api-go writes itself: crawl
 * completion/failure, news-source circuit opened / auto disabled, classification
 * quality alerts and the other Go-owned writers. This is the legacy half of the
 * B3 relay split.
 *
 * api-go commits the Notification row before publishing the identifiers-only
 * envelope, so this subscriber re-reads the row and only asks the local
 * Socket.IO gateway to emit it.
 *
 * Why only in legacy socket mode: with API_GO_NOTIFICATIONS_SOCKET_MODE=go the
 * browser's /notifications namespace is served by the Go transport, whose
 * notificationssocket Runtime subscribes to this very channel. Only when the
 * mode is anything else (unset, empty string or "legacy" — the default) does
 * NestJS keep the socket, and then nobody else consumes the channel, so
 * Go-written rows would stay invisible without this subscriber.
 *
 * Why it does not use NotificationDispatcher: the dispatcher fans out through
 * the Socket.IO Redis adapter, which broadcasts the event to the room on every
 * NestJS instance. One relay message would therefore be re-emitted once per
 * instance even though it describes a single row. emitLocalNotification /
 * emitLocalOrgNotification walk only this instance's sockets instead, and every
 * browser connection is attached to exactly one instance, so each connection
 * receives the event exactly once.
 *
 * Why this cannot loop: the NestJS publisher and this subscriber are disjoint by
 * construction. NotificationsService.notify takes the realtime relay branch only
 * when the mode is go (NotificationRealtimeRelay.enabled), while this subscriber
 * only connects when the mode is not go; in legacy mode NestJS publishes through
 * the in-process dispatcher (never Redis), so the only publisher of
 * notification:events:v1 is api-go.
 */
@Injectable()
export class GenericNotificationSubscriber
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = createLogger({
    name: 'generic-notification-subscriber',
  });
  private subscriber?: Redis;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly env: EnvService,
    private readonly prisma: PrismaService,
    private readonly gateway: NotificationsGateway,
  ) {}

  async onModuleInit() {
    if (this.isGoSocketMode()) {
      return;
    }

    const subscriber = this.redis.duplicate();
    subscriber.on('error', (error) => {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Generic notification subscriber redis error',
      );
    });
    subscriber.on('message', (channel, message) => {
      if (channel !== NOTIFICATION_REALTIME_CHANNEL) {
        return;
      }
      void this.handleMessage(message).catch((error) => {
        this.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'Failed to handle generic notification relay message',
        );
      });
    });
    this.subscriber = subscriber;

    try {
      await subscriber.subscribe(NOTIFICATION_REALTIME_CHANNEL);
      this.logger.info(
        { channel: NOTIFICATION_REALTIME_CHANNEL },
        'Generic notification subscriber connected',
      );
    } catch (error) {
      this.subscriber = undefined;
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to subscribe generic notification relay channel',
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
      await subscriber.unsubscribe(NOTIFICATION_REALTIME_CHANNEL);
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
   * API_GO_NOTIFICATIONS_SOCKET_MODE. Unset and the empty string behave like
   * legacy, exactly like NotificationRealtimeRelay.enabled; only "go" hands the
   * /notifications transport (and therefore this channel) to api-go.
   */
  private isGoSocketMode(): boolean {
    return (
      this.env.get<string>('API_GO_NOTIFICATIONS_SOCKET_MODE', {
        infer: true,
      }) === 'go'
    );
  }

  private async handleMessage(raw: string) {
    const relay = this.parseRelayMessage(raw);
    if (!relay) {
      return;
    }
    // The envelope carries identifiers only. Re-read the committed row by
    // id + orgId + userId, so a stale, forged or cross-tenant envelope can
    // never emit a notification: a user-scoped envelope must match the row's
    // userId, and an org-wide envelope must still find a row with userId NULL.
    const record = await this.prisma.notification.findFirst({
      where: {
        id: relay.notificationId,
        orgId: relay.orgId,
        userId: relay.userId ?? null,
      },
    });
    if (!record) {
      return;
    }
    const event = this.toEvent(record);
    const delivered = relay.userId
      ? this.gateway.emitLocalNotification(relay.orgId, relay.userId, event)
      : this.gateway.emitLocalOrgNotification(relay.orgId, event);
    if (delivered > 0) {
      this.logger.debug(
        {
          notificationId: relay.notificationId,
          orgId: relay.orgId,
          userId: relay.userId,
          delivered,
        },
        'Delivered generic notification to local sockets',
      );
    }
  }

  private parseRelayMessage(raw: string): GenericRelayMessage | null {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (record.version !== GENERIC_RELAY_VERSION) {
      return null;
    }
    if (
      typeof record.notificationId !== 'string' ||
      record.notificationId.length === 0 ||
      typeof record.orgId !== 'string' ||
      record.orgId.length === 0
    ) {
      return null;
    }
    // userId is optional: publishers omit the key for organization-wide rows.
    // When it is present it must still be a non-empty string, so an empty or
    // null value cannot silently degrade into an org-wide fan-out.
    const userId = record.userId;
    if (userId !== undefined) {
      if (typeof userId !== 'string' || userId.length === 0) {
        return null;
      }
    }
    const message: GenericRelayMessage = {
      version: GENERIC_RELAY_VERSION,
      notificationId: record.notificationId,
      orgId: record.orgId,
    };
    if (typeof userId === 'string') {
      message.userId = userId;
    }
    return message;
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
