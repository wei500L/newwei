import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";

import { AlertNotificationSubscriber } from "./alert-notification.subscriber";
import { AnalysisNotificationSubscriber } from "./analysis-notification.subscriber";
import { NotificationDispatcher } from "./notification.dispatcher";
import { NotificationRealtimeRelay } from "./notification-realtime.relay";
import { NotificationsGateway } from "./notifications.gateway";
import { NotificationsService } from "./notifications.service";
import { UserDigestNotificationSubscriber } from "./user-digest-notification.subscriber";

@Module({
  imports: [AuthModule],
  providers: [
    NotificationsService,
    NotificationsGateway,
    NotificationDispatcher,
    NotificationRealtimeRelay,
    UserDigestNotificationSubscriber,
    AlertNotificationSubscriber,
    AnalysisNotificationSubscriber,
  ],
  exports: [NotificationsService, NotificationDispatcher]
})
export class NotificationsModule {}
