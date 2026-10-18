import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";

import { NotificationDispatcher } from "./notification.dispatcher";
import { NotificationsGateway } from "./notifications.gateway";
import { NotificationsService } from "./notifications.service";
import { UserDigestNotificationSubscriber } from "./user-digest-notification.subscriber";

@Module({
  imports: [AuthModule],
  providers: [
    NotificationsService,
    NotificationsGateway,
    NotificationDispatcher,
    UserDigestNotificationSubscriber,
  ],
  exports: [NotificationsService, NotificationDispatcher]
})
export class NotificationsModule {}
