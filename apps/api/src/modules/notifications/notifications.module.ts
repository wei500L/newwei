import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";

import { AlertNotificationSubscriber } from "./alert-notification.subscriber";
import { AnalysisNotificationSubscriber } from "./analysis-notification.subscriber";
import { NewsSourceNotificationSubscriber } from "./news-source-notification.subscriber";
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
    AlertNotificationSubscriber,
    AnalysisNotificationSubscriber,
    NewsSourceNotificationSubscriber,
  ],
  exports: [NotificationsService, NotificationDispatcher]
})
export class NotificationsModule {}
