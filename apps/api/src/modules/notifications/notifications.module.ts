import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";

import { NotificationDispatcher } from "./notification.dispatcher";
import { NotificationsGateway } from "./notifications.gateway";
import { NotificationsService } from "./notifications.service";

@Module({
  imports: [AuthModule],
  providers: [NotificationsService, NotificationsGateway, NotificationDispatcher],
  exports: [NotificationsService, NotificationDispatcher]
})
export class NotificationsModule {}
