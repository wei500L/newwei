import { Injectable } from "@nestjs/common";
import { Notification, NotificationType } from "@prisma/client";
import type { Prisma } from "@prisma/client";

import { PrismaService } from "../config/prisma.service";

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
    private readonly dispatcher: NotificationDispatcher
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
    await this.dispatcher.publish(event);
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
    const updated = await this.prisma.notification.updateMany({
      where: { id, orgId, userId },
      data: { readAt: new Date() }
    });
    if (updated.count === 0) {
      return null;
    }
    const record = await this.prisma.notification.findUnique({ where: { id } });
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
