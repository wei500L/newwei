import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { NotificationType } from "@prisma/client";

export interface NotificationEvent {
  id: string;
  orgId: string;
  userId?: string | null;
  type: NotificationType;
  title: string;
  body?: string | null;
  data?: Record<string, unknown> | null;
  readAt?: string | null;
  createdAt: string;
}

type NotificationListener = (event: NotificationEvent) => void | Promise<void>;

@Injectable()
export class NotificationDispatcher {
  private readonly listeners = new Set<NotificationListener>();
  private readonly logger = createLogger({ name: "notification-dispatcher" });

  registerListener(listener: NotificationListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async publish(event: NotificationEvent) {
    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (error) {
        this.logger.error({ eventId: event.id, error }, "Notification listener failed");
      }
    }
  }
}
