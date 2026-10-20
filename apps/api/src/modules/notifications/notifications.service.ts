import { Injectable } from "@nestjs/common";
import { Notification, NotificationType } from "@prisma/client";
import type { Prisma } from "@prisma/client";

import { PrismaService } from "../config/prisma.service";

import { NotificationRealtimeRelay } from "./notification-realtime.relay";
import { NotificationDispatcher, NotificationEvent } from "./notification.dispatcher";

export interface CreateNotificationInput {
  orgId: string;
  userId?: string | null;
  type: NotificationType;
  title: string;
  body?: string | null;
  data?: Record<string, unknown> | null;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: NotificationDispatcher,
    private readonly realtimeRelay: NotificationRealtimeRelay
  ) {}

  async notify(input: CreateNotificationInput) {
    const data = input.data
      ? (JSON.parse(JSON.stringify(input.data)) as Prisma.InputJsonValue)
      : undefined;
    const record = await this.prisma.notification.create({
      data: {
        orgId: input.orgId,
        userId: input.userId ?? null,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        data
      }
    });
    const event = this.toEvent(record);
    if (this.realtimeRelay.enabled) {
      // Go owns the /notifications transport in this mode. The in-process
      // dispatcher is bypassed so legacy Nest sockets cannot receive the same
      // event a second time through the Socket.IO Redis adapter.
      await this.realtimeRelay.publish(event);
    } else {
      await this.dispatcher.publish(event);
    }
    return event;
  }

  async listForUser(orgId: string, userId: string, limit = 20) {
    const records = await this.prisma.notification.findMany({
      where: { orgId, userId },
      orderBy: { createdAt: "desc" },
      take: limit
    });
    return records.map((record) => this.toEvent(record));
  }

  async countUnread(orgId: string, userId: string) {
    return this.prisma.notification.count({ where: { orgId, userId, readAt: null } });
  }

  async markRead(orgId: string, userId: string, id: string) {
    // Only the first read writes readAt: the `readAt: null` predicate keeps the
    // original timestamp and leaves updatedAt untouched when the notification
    // was already read. The row is therefore re-read by id + orgId + userId
    // instead of trusting the update count, so an already-read notification
    // still returns its model while another tenant or user never matches.
    await this.prisma.notification.updateMany({
      where: { id, orgId, userId, readAt: null },
      data: { readAt: new Date() }
    });
    const record = await this.prisma.notification.findFirst({ where: { id, orgId, userId } });
    return record ? this.toEvent(record) : null;
  }

  async markAllRead(orgId: string, userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { orgId, userId, readAt: null },
      data: { readAt: new Date() }
    });
    return result.count;
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
      createdAt: record.createdAt.toISOString()
    };
  }
}
