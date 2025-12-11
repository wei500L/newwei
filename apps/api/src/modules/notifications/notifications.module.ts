import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { NotificationsService } from "./notifications.service";
import { NotificationsGateway } from "./notifications.gateway";
import { NotificationDispatcher } from "./notification.dispatcher";

@Module({
  imports: [AuthModule],
  providers: [NotificationsService, NotificationsGateway, NotificationDispatcher],
  exports: [NotificationsService, NotificationDispatcher]
})
export class NotificationsModule {}
